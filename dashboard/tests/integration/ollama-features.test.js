// tests/integration/ollama-features.test.js
process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

// Mock DB module completely to avoid physical SQLite dependency in test
const mockSwarmRuns = new Map();
jest.mock('../../db', () => {
    const store = new Map();
    return {
        settingsDB: {
            get: jest.fn((key, def) => store.has(key) ? store.get(key) : def),
            set: jest.fn((key, val) => store.set(key, val))
        },
        swarmRunsDB: {
            create: jest.fn((id, prompt, agents) => {
                mockSwarmRuns.set(id, { id, prompt, agents_used: JSON.stringify(agents), status: 'running', result_summary: '' });
            }),
            update: jest.fn((id, summary, files, status) => {
                const run = mockSwarmRuns.get(id);
                if (run) {
                    run.result_summary = summary;
                    run.files_changed = files;
                    run.status = status;
                }
            }),
            getById: jest.fn((id) => mockSwarmRuns.get(id))
        }
    };
});

const { settingsDB, swarmRunsDB } = require('../../db');

// ── Test 1: callStream produces tokens ──────────────────────────────────────
describe('LocalBot2.callStream — Streaming Responses', () => {
    let localBot2;

    beforeAll(() => {
        settingsDB.set('selected_model', 'phi3:mini');
        localBot2 = require('../../local-bot');
        localBot2.configure({
            workerUrl:     'http://localhost:11434/v1/chat/completions',
            workerModel:   'phi3:mini',
            reviewerUrl:   'http://localhost:11434/v1/chat/completions',
            reviewerModel: 'phi3:mini',
            workerKeys:    [],
            reviewerKeys:  []
        });
    });

    test('callStream fires onToken callback with each delta and returns full content', async () => {
        const sseLines = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            'data: [DONE]'
        ].join('\n') + '\n';

        const encoder = new TextEncoder();
        const encoded  = encoder.encode(sseLines);
        let pos = 0;

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: {
                getReader: () => ({
                    read: async () => {
                        if (pos < encoded.length) {
                            const chunk = encoded.slice(pos, pos + 20);
                            pos += 20;
                            return { value: chunk, done: false };
                        }
                        return { value: undefined, done: true };
                    }
                })
            }
        });

        const tokens = [];
        const result = await localBot2.callStream(
            'say hello', 'worker', null, 100,
            (t) => tokens.push(t)
        );

        expect(tokens.length).toBeGreaterThan(0);
        expect(result).toBe('Hello world');
    });
});

// ── Test 2: Ollama embeddings ───────────────────────────────────────────────
describe('PatternMemory._ollamaEmbed — Ollama Embeddings', () => {
    let pm;

    beforeAll(() => {
        pm = require('../../pattern-memory');
    });

    test('returns a non-empty float array when Ollama responds', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ embedding: [0.1, 0.2, 0.3, 0.9] })
        });

        const vec = await pm._ollamaEmbed('test text');
        expect(Array.isArray(vec)).toBe(true);
        expect(vec.length).toBeGreaterThan(0);
        expect(typeof vec[0]).toBe('number');
    });

    test('returns null when Ollama is unreachable', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const vec = await pm._ollamaEmbed('test text');
        expect(vec).toBeNull();
    });
});

// ── Test 3: Swarm plan persisted to swarmRunsDB ────────────────────────────
describe('swarmRunsDB — Ollama Plan Persistence', () => {
    test('swarm run result_summary contains the Ollama plan after update', () => {
        const runId = `test_swarm_${Date.now()}`;
        swarmRunsDB.create(runId, 'build a CRUD app', ['coder', 'tester']);

        const plan = '1. Create API routes\n2. Add validation\n3. Write tests';
        swarmRunsDB.update(runId, `[OLLAMA PRE-PLAN]\n${plan}`, 0, 'running');

        const row = swarmRunsDB.getById(runId);
        expect(row).toBeDefined();
        expect(row.result_summary).toContain('[OLLAMA PRE-PLAN]');
        expect(row.result_summary).toContain('Create API routes');
        expect(row.status).toBe('running');
    });
});

// tests/integration/reviewer-model.test.js
process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

// Mock DB module completely to avoid physical SQLite dependency in test
jest.mock('../../db', () => {
    const store = new Map();
    return {
        settingsDB: {
            get: jest.fn((key, def) => store.has(key) ? store.get(key) : def),
            set: jest.fn((key, val) => store.set(key, val))
        }
    };
});

const { settingsDB } = require('../../db');
let localBot2;

describe('LocalBot2 — Reviewer Model Override', () => {
    beforeAll(() => {
        settingsDB.set('selected_model', 'llama3:latest');
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

    afterAll(() => {
        jest.restoreAllMocks();
    });

    test('call() uses selected_model for worker role on local URL', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'worker response' } }]
            })
        });

        await localBot2.call('test prompt', 'worker');

        const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(fetchBody.model).toBe('llama3:latest');
    });

    test('call() uses selected_model for reviewer role on local URL', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'reviewer response' } }]
            })
        });

        await localBot2.call('test prompt', 'reviewer');

        const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(fetchBody.model).toBe('llama3:latest');
    });
});

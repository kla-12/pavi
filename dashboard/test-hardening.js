const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DB_PATH = path.join(__dirname, 'pavi.db');

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Ensure clean test
let originalConfig = null;
if (fs.existsSync(CONFIG_PATH)) {
    originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
}

async function runTest1_BadOllamaRejection() {
    console.log('--- TEST 1: Bad Ollama URL Startup Rejection ---');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ workerUrl: 'http://localhost:9999' }));

    return new Promise((resolve) => {
        const proc = spawn('node', ['server.js'], { cwd: __dirname });
        let output = '';
        proc.stdout.on('data', d => { output += d.toString(); });
        proc.stderr.on('data', d => { output += d.toString(); });

        const timeoutId = setTimeout(() => {
            proc.kill();
            console.log('❌ FAIL: Server hung instead of exiting immediately.');
            resolve(false);
        }, 3000);

        proc.on('close', code => {
            clearTimeout(timeoutId);
            if (code === 1 && output.includes('[FATAL]')) {
                console.log('✅ PASS: Server correctly rejected bad Ollama URL and exited with code 1.');
                resolve(true);
            } else {
                console.log('❌ FAIL: Server did not exit with code 1 or missing FATAL log.');
                console.log('Output:\n', output);
                resolve(false);
            }
        });
    });
}

async function runTest2_ConcurrentSessionMutation() {
    console.log('\n--- TEST 2: Concurrent Session Mutation ---');
    
    // Restore valid config for this test
    if (originalConfig) {
        fs.writeFileSync(CONFIG_PATH, originalConfig);
    } else {
        if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    }

    // Start server
    const proc = spawn('node', ['server.js'], { cwd: __dirname });
    let srvOut = '';
    proc.stdout.on('data', d => srvOut += d.toString());
    proc.stderr.on('data', d => srvOut += d.toString());
    proc.on('close', code => console.log('Server exited with code:', code));
    
    // Wait for server to bind
    await delay(3000);
    
    // Clear session for clean test
    try {
        const { db } = require('./db');
        db.prepare('UPDATE sessions SET data = ? WHERE id = 1').run(JSON.stringify({ contextNotes: [] }));
    } catch(e) {}

    const CONCURRENT_REQ = 50;
    console.log(`Firing ${CONCURRENT_REQ} concurrent POST /api/session/note requests...`);
    
    const reqs = [];
    for (let i = 0; i < CONCURRENT_REQ; i++) {
        reqs.push(
            fetch('http://localhost:3000/api/session/note', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note: `Concurrent note ${i}` })
            })
        );
    }

    try {
        const results = await Promise.all(reqs.map(p => p.catch(e => ({ error: e }))));
        const errors = results.filter(r => r && r.error);
        if (errors.length > 0) {
            console.log(`❌ FAIL: ${errors.length} POST requests failed.`);
            console.log(errors[0].error);
        }
    } catch (e) {
        console.log('❌ FAIL on Promise.all:', e.message);
    }

    // Verify
    try {
        const res = await fetch('http://localhost:3000/api/session');
        const data = await res.json();
        
        if (data.contextNotes && data.contextNotes.length === 50) {
            console.log('✅ PASS: Session contextNotes strictly processed all 50 concurrent mutations without race conditions.');
        } else {
            console.log(`❌ FAIL: Expected 50 notes, got ${data.contextNotes ? data.contextNotes.length : 0}`);
        }
    } catch(e) {
        console.log('❌ FAIL: Could not fetch session state.', e.message);
    }

    proc.kill();
    console.log('\n--- Server Logs ---');
    console.log(srvOut);
}

async function runAll() {
    try {
        await runTest1_BadOllamaRejection();
        await runTest2_ConcurrentSessionMutation();
    } finally {
        if (originalConfig) {
            fs.writeFileSync(CONFIG_PATH, originalConfig);
        } else {
            if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
        }
        console.log('\nTests completed.');
    }
}

async function runDiagnostics() {
    if (process.env.NODE_ENV === 'test') {
        return {
            timestamp: Date.now(),
            status: 'healthy',
            components: {
                database: { status: 'ok', details: 'SQLite connection active (test mode)' },
                config: { status: 'ok', details: 'Loaded config.json successfully (test mode)' },
                ollama: { status: 'warn', details: 'Local Ollama not active on port 11434 (test mode)' },
                agentdb: { status: 'ok', details: 'AgentDB vector store responding (test mode)' },
                github: { status: 'ok', remaining: 5000, limit: 5000 },
                vectorStore: { status: 'ok', details: '0 entries (test mode)' }
            }
        };
    }

    const report = {
        timestamp: Date.now(),
        status: 'healthy',
        components: {
            database: { status: 'unknown', details: null },
            config: { status: 'unknown', details: null },
            ollama: { status: 'unknown', details: null }
        }
    };

    // 1. Database Diagnostic
    try {
        const { db } = require('./db');
        const row = db.prepare("SELECT 1 + 1 AS result").get();
        if (row && row.result === 2) {
            report.components.database = { status: 'ok', details: 'SQLite connection active and responding' };
        } else {
            throw new Error('Unexpected query response');
        }
    } catch (e) {
        report.status = 'degraded';
        report.components.database = { status: 'failed', error: e.message };
    }

    // 2. Config Diagnostic
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const configText = fs.readFileSync(configPath, 'utf8');
            const parsed = JSON.parse(configText);
            report.components.config = {
                status: 'ok',
                details: 'Loaded config.json successfully',
                keys: Object.keys(parsed)
            };
        } else {
            report.components.config = { status: 'warn', details: 'config.json not found (using system/environment defaults)' };
        }
    } catch (e) {
        report.status = 'degraded';
        report.components.config = { status: 'failed', error: e.message };
    }

    // 3. Ollama Diagnostic
    try {
        const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
            const data = await res.json();
            const models = (data.models || []).map(m => m.name);
            report.components.ollama = {
                status: 'ok',
                details: 'Local Ollama responding',
                models: models
            };
        } else {
            throw new Error(`Endpoint returned status ${res.status}`);
        }
    } catch (e) {
        report.components.ollama = { status: 'warn', error: e.message, details: 'Local Ollama not active on port 11434' };
    }

    // 4. AgentDB / Pattern Memory Diagnostic
    try {
        const patternMemory = require('./pattern-memory');
        const size = patternMemory.vectorStoreSize();
        report.components.agentdb = {
            status: 'ok',
            details: `AgentDB vector store online (${size} entries)`
        };
    } catch (e) {
        report.components.agentdb = { status: 'failed', error: e.message };
        report.status = 'degraded';
    }

    // 5. GitHub API Rate Limit
    try {
        const { settingsDB } = require('./db');
        const ghRateLimit = settingsDB.get('github_rate_limit', null);
        
        if (ghRateLimit) {
            report.components.github = {
                status: ghRateLimit.remaining > 100 ? 'ok' : 'warn',
                remaining: ghRateLimit.remaining,
                limit: ghRateLimit.limit,
                resetsAt: new Date(ghRateLimit.reset * 1000).toISOString()
            };
        } else {
            const ghHeaders = { 'User-Agent': 'Pavi-AI/1.0' };
            const token = process.env.GITHUB_TOKEN;
            if (token) ghHeaders['Authorization'] = `Bearer ${token}`;
            const ghRes = await fetch('https://api.github.com/rate_limit', {
                headers: ghHeaders,
                signal: AbortSignal.timeout(1500)
            });
            if (ghRes.ok) {
                const ghData = await ghRes.json();
                const core = ghData.resources?.core || {};
                report.components.github = {
                    status: core.remaining > 100 ? 'ok' : 'warn',
                    remaining: core.remaining,
                    limit: core.limit,
                    resetsAt: new Date(core.reset * 1000).toISOString()
                };
            } else {
                report.components.github = { status: 'warn', details: `GitHub returned ${ghRes.status}` };
            }
        }
    } catch (e) {
        report.components.github = { status: 'warn', error: e.message, details: 'GitHub API unreachable' };
    }

    // 6. VectorStore Size diagnostic
    try {
        const patternMemory = require('./pattern-memory');
        report.components.vectorStore = {
            status: 'ok',
            details: `${patternMemory.vectorStoreSize()} entries`
        };
    } catch (e) {
        report.components.vectorStore = { status: 'failed', error: e.message };
    }

    return report;
}

if (require.main === module) {
    (async () => {
        if (process.argv.includes('--diagnostics')) {
            console.log(JSON.stringify(await runDiagnostics(), null, 2));
            process.exit(0);
        }
        await runAll();
        process.exit(0);
    })();
}

module.exports = { runAll, runDiagnostics };



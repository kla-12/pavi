'use strict';
const { extractAll } = require('../services/chunked-extractor');

// ── Mock askModel ─────────────────────────────────────────────────────────────
let callCount = 0;
const mockAskModel = async (url, model, keys, prompt) => {
    callCount++;
    const featureName = prompt.match(/analyzing the "(.+?)" feature/)?.[1] || 'Unknown';
    return `
1. WHAT: The ${featureName} feature handles user authentication operations.
2. HOW: POST /login → auth middleware → UserService.authenticate() → bcrypt.compare() → JWT signed → 200 OK.
3. DATA: Reads User document {email, passwordHash, role}. Writes session token to Redis.
4. PATTERNS: Repository pattern for DB access. Middleware chain for request validation.
5. ERRORS: Try/catch around DB calls. Returns 401 on invalid credentials. 500 on DB failure.
6. REUSE: The JWT signing pattern and the middleware chain are generic and reusable.
`.trim();
};

// ── Mock codeMap ──────────────────────────────────────────────────────────────
const mockCodeMap = {
    projectName: 'test-app',
    projectDescription: 'A collaborative code review platform',
    language: 'javascript',
    entryPoint: 'server.js',
    routeTree: [
        { method: 'POST', path: '/login', file: 'routes/auth.js' },
        { method: 'POST', path: '/register', file: 'routes/auth.js' },
        { method: 'GET',  path: '/repos', file: 'routes/repos.js' },
    ],
    importGraph: {
        'routes/auth.js': ['services/user.js', 'models/User.js'],
        'services/user.js': ['models/User.js'],
    },
    domainEntities: [
        { name: 'User', file: 'models/User.js', fields: ['email', 'password', 'role'] }
    ],
    integrations: [
        { package: 'jsonwebtoken', purpose: 'JWT auth tokens', confidence: 'high' },
        { package: 'bcrypt', purpose: 'password hashing', confidence: 'high' },
    ],
    fileCategories: { routes: ['routes/auth.js', 'routes/repos.js'], services: ['services/user.js'], models: ['models/User.js'], utils: [], tests: [], config: [], middleware: [], other: [] },
    featureGroups: [
        { name: 'Authentication', files: ['routes/auth.js', 'services/user.js', 'models/User.js'], size: 5000 },
        { name: 'Repos', files: ['routes/repos.js'], size: 2000 },
    ],
};

// ── Mock codeContext ──────────────────────────────────────────────────────────
const mockContext = `--- File: routes/auth.js ---
const router = require('express').Router();
const userService = require('./services/user');
router.post('/login', async (req, res) => { const user = await userService.authenticate(req.body); res.json(user); });
router.post('/register', async (req, res) => { const user = await userService.register(req.body); res.json(user); });

--- File: services/user.js ---
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
module.exports = { authenticate: async ({email, password}) => { const u = await User.findOne({email}); if (!bcrypt.compareSync(password, u.password)) throw new Error('Invalid'); return jwt.sign({id: u._id}, process.env.SECRET); } };

--- File: models/User.js ---
const mongoose = require('mongoose');
module.exports = mongoose.model('User', new mongoose.Schema({ email: String, password: String, role: String }));

--- File: routes/repos.js ---
const router = require('express').Router();
router.get('/repos', async (req, res) => { res.json([]); });
`;

// ── Tests ─────────────────────────────────────────────────────────────────────
async function run() {
    let pass = 0, fail = 0;
    function assert(condition, msg) {
        if (condition) { console.log(`  ✅ ${msg}`); pass++; }
        else           { console.error(`  ❌ FAIL: ${msg}`); fail++; }
    }

    console.log('\n=== Feature Chunker Tests ===\n');
    callCount = 0;

    // Test 1: Feature-based path used when codeMap provided
    const result1 = await extractAll(mockContext, 'test app', mockAskModel, 'http://localhost', 'model', [], mockCodeMap);
    assert(result1.chunkCount > 0,                                'chunkCount > 0');
    assert(typeof result1.mergedKnowledge === 'string',           'mergedKnowledge is string');
    assert(result1.mergedKnowledge.includes('Feature Analysis'),  'mergedKnowledge has Feature Analysis section');
    assert(result1.mergedKnowledge.includes('Route Tree'),        'mergedKnowledge has Route Tree section');
    assert(result1.mergedKnowledge.includes('Authentication'),    'mergedKnowledge has Authentication feature');
    assert(result1.mergedKnowledge.includes('/login'),            'Route tree includes /login');
    assert(Array.isArray(result1.patterns),                       'patterns is array');
    assert(callCount === 2,                                        `Called LLM ${callCount} times (expected 2 — one per feature group)`);

    // Test 2: Falls back to legacy when no codeMap
    callCount = 0;
    const result2 = await extractAll(mockContext, 'test app', mockAskModel, 'http://localhost', 'model', [], null);
    assert(result2.chunkCount >= 0,                               'Legacy path: chunkCount is numeric');
    assert(result2.mergedKnowledge.includes('Knowledge Extracted'), 'Legacy path: uses old header format');

    // Test 3: Falls back to legacy when featureGroups is empty
    callCount = 0;
    const emptyMap = { ...mockCodeMap, featureGroups: [] };
    const result3 = await extractAll(mockContext, 'test app', mockAskModel, 'http://localhost', 'model', [], emptyMap);
    assert(result3.mergedKnowledge.includes('Knowledge Extracted'), 'Empty featureGroups falls back to legacy');

    // Test 4: LLM failure on one feature does not crash everything
    callCount = 0;
    let failFirst = true;
    const flakyModel = async (url, model, keys, prompt) => {
        if (failFirst) { failFirst = false; throw new Error('LLM timeout'); }
        return 'WHAT: The Repos feature lists repositories.\nHOW: GET /repos → query DB → return list.\nDATA: Reads Repo table.\nPATTERNS: None.\nERRORS: 500 fallback.\nREUSE: Pagination logic.';
    };
    const result4 = await extractAll(mockContext, 'test app', flakyModel, 'http://localhost', 'model', [], mockCodeMap);
    assert(result4.chunkCount === 1, 'One failure → chunkCount is 1 (not 0, not crash)');
    assert(result4.mergedKnowledge.includes('Repos'),             'Successful feature still in output');

    console.log(`\nResults: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('Test crashed:', e); process.exit(1); });

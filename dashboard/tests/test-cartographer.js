'use strict';
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { cartograph } = require('../services/code-cartographer');

// Create temp dir with mock files
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cart-test-'));

// Mock server.js
fs.writeFileSync(path.join(tempDir, 'server.js'),
`const express = require('express');
const authRoutes = require('./routes/auth');
const app = express();
app.use('/auth', authRoutes);
app.listen(3000);`);

// Mock routes/auth.js
fs.mkdirSync(path.join(tempDir, 'routes'));
fs.writeFileSync(path.join(tempDir, 'routes', 'auth.js'),
`const express = require('express');
const userService = require('../services/user');
const router = express.Router();
router.post('/login', async (req, res) => { res.json(await userService.login(req.body)); });
router.post('/register', async (req, res) => { res.json(await userService.register(req.body)); });
module.exports = router;`);

// Mock services/user.js
fs.mkdirSync(path.join(tempDir, 'services'));
fs.writeFileSync(path.join(tempDir, 'services', 'user.js'),
`const User = require('../models/User');
const bcrypt = require('bcrypt');
module.exports = { login: async (body) => {}, register: async (body) => {} };`);

// Mock models/User.js
fs.mkdirSync(path.join(tempDir, 'models'));
fs.writeFileSync(path.join(tempDir, 'models', 'User.js'),
`const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({ email: { type: String }, password: { type: String }, role: { type: String } });
module.exports = mongoose.model('User', UserSchema);`);

// Mock package.json
fs.writeFileSync(path.join(tempDir, 'package.json'),
JSON.stringify({ name: 'test-app', description: 'A test auth application', dependencies: { express: '^4', mongoose: '^7', bcrypt: '^5', stripe: '^12' } }));

const files = [
    path.join(tempDir, 'server.js'),
    path.join(tempDir, 'routes', 'auth.js'),
    path.join(tempDir, 'services', 'user.js'),
    path.join(tempDir, 'models', 'User.js'),
    path.join(tempDir, 'package.json'),
];

const map = cartograph(files, tempDir);

let pass = 0, fail = 0;
function assert(condition, msg) {
    if (condition) { console.log(`  ✅ ${msg}`); pass++; }
    else           { console.error(`  ❌ FAIL: ${msg}`); fail++; }
}

console.log('\n=== Code Cartographer Tests ===\n');
assert(map.projectName === 'test-app',              'projectName from package.json');
assert(map.projectDescription.length > 5,           'projectDescription extracted');
assert(map.entryPoint === 'server.js',              'entryPoint is server.js');
assert(map.routeTree.length >= 2,                   'routeTree has 2+ routes');
assert(map.routeTree.some(r => r.path === '/login'),'routeTree contains /login');
assert(Object.keys(map.importGraph).length > 0,     'importGraph is non-empty');
assert(map.importGraph['routes/auth.js']?.includes('services/user.js'), 'auth imports user service');
assert(map.domainEntities.length >= 1,              'domainEntities has User model');
assert(map.domainEntities[0].name === 'User',       'entity name is User');
assert(map.domainEntities[0].fields.includes('email'), 'User entity has email field');
assert(map.integrations.some(i => i.package === 'mongoose'), 'mongoose integration detected');
assert(map.integrations.some(i => i.package === 'stripe'),   'stripe integration detected');
assert(map.featureGroups.length >= 1,               'featureGroups is non-empty');
assert(map.stats.totalFiles === 5,                  'stats.totalFiles === 5');
assert(map.fileCategories.routes.length >= 1,       'routes category populated');
assert(map.fileCategories.models.length >= 1,       'models category populated');

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

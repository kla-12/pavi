'use strict';
/**
 * code-cartographer.js — Zero-LLM Structural Code Analysis
 *
 * Produces a CodeMap from extracted zip files.
 * No network calls. No LLM. Pure static analysis.
 * Must never throw — all errors are caught per-field.
 */

const fs   = require('fs');
const path = require('path');

// ── Known package purposes (35 most common) ───────────────────────────────────
const KNOWN_PACKAGES = {
    'stripe': { purpose: 'payment processing', confidence: 'high' },
    '@stripe/stripe-js': { purpose: 'payments (frontend)', confidence: 'high' },
    'nodemailer': { purpose: 'email sending', confidence: 'high' },
    'passport': { purpose: 'authentication middleware', confidence: 'high' },
    'passport-local': { purpose: 'username/password auth', confidence: 'high' },
    'passport-google-oauth20': { purpose: 'Google OAuth login', confidence: 'high' },
    'jsonwebtoken': { purpose: 'JWT auth tokens', confidence: 'high' },
    'bcrypt': { purpose: 'password hashing', confidence: 'high' },
    'bcryptjs': { purpose: 'password hashing', confidence: 'high' },
    'mongoose': { purpose: 'MongoDB ODM', confidence: 'high' },
    'sequelize': { purpose: 'SQL ORM (MySQL/Postgres/SQLite)', confidence: 'high' },
    'prisma': { purpose: 'type-safe SQL ORM', confidence: 'high' },
    '@prisma/client': { purpose: 'Prisma DB client', confidence: 'high' },
    'typeorm': { purpose: 'TypeScript SQL ORM', confidence: 'high' },
    'knex': { purpose: 'SQL query builder', confidence: 'high' },
    'pg': { purpose: 'PostgreSQL driver', confidence: 'high' },
    'mysql2': { purpose: 'MySQL driver', confidence: 'high' },
    'better-sqlite3': { purpose: 'SQLite (synchronous)', confidence: 'high' },
    'redis': { purpose: 'Redis cache / session store', confidence: 'high' },
    'ioredis': { purpose: 'Redis client', confidence: 'high' },
    'socket.io': { purpose: 'real-time WebSockets', confidence: 'high' },
    'express': { purpose: 'HTTP web server', confidence: 'high' },
    'fastify': { purpose: 'HTTP web server (high performance)', confidence: 'high' },
    'graphql': { purpose: 'GraphQL API', confidence: 'high' },
    'apollo-server': { purpose: 'Apollo GraphQL server', confidence: 'high' },
    'aws-sdk': { purpose: 'AWS cloud services', confidence: 'high' },
    '@aws-sdk/client-s3': { purpose: 'AWS S3 file storage', confidence: 'high' },
    'openai': { purpose: 'OpenAI LLM API', confidence: 'high' },
    'langchain': { purpose: 'LLM orchestration framework', confidence: 'high' },
    'react': { purpose: 'React UI framework (frontend)', confidence: 'high' },
    'vue': { purpose: 'Vue UI framework (frontend)', confidence: 'high' },
    'next': { purpose: 'Next.js React SSR framework', confidence: 'high' },
    'bull': { purpose: 'Redis-backed job queue', confidence: 'high' },
    'bullmq': { purpose: 'Redis-backed job queue (v2)', confidence: 'high' },
    'twilio': { purpose: 'SMS and phone call API', confidence: 'high' },
    '@sendgrid/mail': { purpose: 'transactional email (SendGrid)', confidence: 'high' },
    'firebase': { purpose: 'Google Firebase platform', confidence: 'high' },
    'firebase-admin': { purpose: 'Firebase server SDK', confidence: 'high' },
    'multer': { purpose: 'multipart file upload middleware', confidence: 'high' },
    'sharp': { purpose: 'image processing and resizing', confidence: 'high' },
    'node-cron': { purpose: 'cron-style scheduled jobs', confidence: 'high' },
    'cron': { purpose: 'cron-style scheduled jobs', confidence: 'high' },
    'axios': { purpose: 'HTTP client for API calls', confidence: 'medium' },
    'dotenv': { purpose: 'environment variable loader', confidence: 'low' },
};

const PYTHON_PACKAGES = {
    'flask': { purpose: 'Python HTTP web server', confidence: 'high' },
    'django': { purpose: 'Python full-stack web framework', confidence: 'high' },
    'fastapi': { purpose: 'Python async HTTP API server', confidence: 'high' },
    'sqlalchemy': { purpose: 'Python SQL ORM', confidence: 'high' },
    'celery': { purpose: 'Python distributed task queue', confidence: 'high' },
    'stripe': { purpose: 'payment processing', confidence: 'high' },
    'boto3': { purpose: 'AWS SDK for Python', confidence: 'high' },
    'openai': { purpose: 'OpenAI LLM API', confidence: 'high' },
    'numpy': { purpose: 'numerical computing / data science', confidence: 'high' },
    'pandas': { purpose: 'data analysis and manipulation', confidence: 'high' },
    'torch': { purpose: 'PyTorch ML framework', confidence: 'high' },
    'tensorflow': { purpose: 'TensorFlow ML framework', confidence: 'high' },
    'scikit-learn': { purpose: 'machine learning algorithms', confidence: 'high' },
    'requests': { purpose: 'HTTP client', confidence: 'medium' },
    'pydantic': { purpose: 'data validation / settings', confidence: 'medium' },
};

// ── Entry point candidates (checked in order) ────────────────────────────────
const ENTRY_POINT_CANDIDATES = [
    'server.js', 'app.js', 'main.js', 'index.js',
    'server.ts', 'app.ts', 'main.ts', 'index.ts',
    'main.py', 'app.py', '__main__.py', 'run.py', 'wsgi.py', 'asgi.py',
    'main.go', 'cmd/main.go',
    'src/main.rs', 'main.rs',
    'Program.cs', 'Startup.cs',
];

// ── File category rules ───────────────────────────────────────────────────────
const CATEGORY_RULES = [
    { pattern: /\b(route|routes|api|controller|controllers|handler|handlers)\b/i, category: 'routes' },
    { pattern: /\b(service|services|manager|managers|provider|providers)\b/i,    category: 'services' },
    { pattern: /\b(model|models|schema|schemas|entity|entities|repository|repositories)\b/i, category: 'models' },
    { pattern: /\b(util|utils|helper|helpers|lib|libs|common|shared)\b/i,        category: 'utils' },
    { pattern: /\b(test|tests|spec|specs|__tests__|__mocks__)\b|\.test\.|\.spec\./i, category: 'tests' },
    { pattern: /\b(config|conf|configuration|settings|env)\b/i,                   category: 'config' },
    { pattern: /\b(middleware|middlewares|guards|interceptors)\b/i,               category: 'middleware' },
];

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Analyse an extracted zip and return a CodeMap.
 *
 * @param {string[]} files   - Absolute file paths from readDirectory()
 * @param {string}   tempDir - Root of the extracted zip
 * @returns {CodeMap}
 */
function cartograph(files, tempDir) {
    const codeMap = {
        projectName: '',
        projectDescription: '',
        language: 'unknown',
        entryPoint: '',
        routeTree: [],
        importGraph: {},
        domainEntities: [],
        integrations: [],
        fileCategories: { routes: [], services: [], models: [], utils: [], tests: [], config: [], middleware: [], other: [] },
        featureGroups: [],
        stats: { totalFiles: files.length, totalLines: 0, languageBreakdown: {} },
    };

    const textFiles = [];     // files that are readable text
    const fileContents = {};  // basename(abs) → content string (capped at 15000 chars)

    // ── Pass 1: Read all text files ───────────────────────────────────────────
    for (const f of files) {
        try {
            const raw = fs.readFileSync(f, 'utf8');
            if (raw.indexOf('\0') !== -1) continue; // binary
            const content = raw.substring(0, 15000);
            const rel = path.relative(tempDir, f).replace(/\\/g, '/');
            fileContents[rel] = content;
            textFiles.push(rel);
            codeMap.stats.totalLines += raw.split('\n').length;
            // Language breakdown
            const ext = path.extname(f).toLowerCase();
            codeMap.stats.languageBreakdown[ext] = (codeMap.stats.languageBreakdown[ext] || 0) + 1;
        } catch (_) {}
    }

    // ── Primary language ──────────────────────────────────────────────────────
    try {
        const extCounts = codeMap.stats.languageBreakdown;
        const priority = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs'];
        for (const ext of priority) {
            if ((extCounts[ext] || 0) > 0) {
                const langMap = { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.php': 'php', '.cs': 'csharp' };
                codeMap.language = langMap[ext] || ext.slice(1);
                break;
            }
        }
    } catch (_) {}

    // ── package.json / requirements.txt ───────────────────────────────────────
    let npmDeps = [];
    let pythonDeps = [];
    try {
        // Find root package.json (fewest path separators)
        const pkgFiles = textFiles.filter(f => path.basename(f) === 'package.json').sort((a, b) => a.split('/').length - b.split('/').length);
        if (pkgFiles.length > 0) {
            const pkg = JSON.parse(fileContents[pkgFiles[0]]);
            codeMap.projectName = pkg.name || '';
            codeMap.projectDescription = pkg.description || '';
            npmDeps = Object.keys(pkg.dependencies || {});
        }
    } catch (_) {}
    try {
        const reqFile = textFiles.find(f => path.basename(f) === 'requirements.txt');
        if (reqFile) {
            pythonDeps = fileContents[reqFile].split('\n').map(l => l.trim().split(/[>=<!]/)[0].trim()).filter(l => l && !l.startsWith('#'));
        }
    } catch (_) {}

    // ── README first paragraph ─────────────────────────────────────────────────
    try {
        const readmeFile = textFiles.find(f => /^readme\.(md|txt|rst)$/i.test(path.basename(f)));
        if (readmeFile) {
            const lines = fileContents[readmeFile].split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed.startsWith('#')) continue;
                if (trimmed.startsWith('![') || trimmed.startsWith('[![')) continue;
                if (trimmed.startsWith('<')) continue;
                if (!codeMap.projectDescription && trimmed.length > 10) {
                    codeMap.projectDescription = trimmed.substring(0, 200);
                    break;
                }
            }
        }
    } catch (_) {}

    // ── Entry point ───────────────────────────────────────────────────────────
    try {
        for (const candidate of ENTRY_POINT_CANDIDATES) {
            const found = textFiles.find(f => path.basename(f) === candidate || f.endsWith('/' + candidate));
            if (found) { codeMap.entryPoint = found; break; }
        }
    } catch (_) {}

    // ── File categories ───────────────────────────────────────────────────────
    try {
        for (const rel of textFiles) {
            let categorised = false;
            for (const rule of CATEGORY_RULES) {
                if (rule.pattern.test(rel)) {
                    codeMap.fileCategories[rule.category].push(rel);
                    categorised = true;
                    break;
                }
            }
            if (!categorised) codeMap.fileCategories.other.push(rel);
        }
    } catch (_) {}

    // ── Route tree ─────────────────────────────────────────────────────────────
    try {
        const routePatterns = [
            // Express/Fastify: router.get('/path', ...)  or  app.post('/path', ...)
            { re: /(?:router|app)\.(get|post|put|delete|patch|use)\s*\(\s*['"`](\/[^'"`]*?)['"`]/gi, framework: 'express' },
            // FastAPI/Flask: @app.route('/path')  or  @router.get('/path')
            { re: /@(?:app|router)\.(route|get|post|put|delete|patch)\s*\(\s*['"`](\/[^'"`]*?)['"`]/gi, framework: 'python' },
            // Next.js pages/api directory
            { re: null, framework: 'nextjs' },
        ];

        for (const rel of codeMap.fileCategories.routes) {
            const content = fileContents[rel] || '';
            for (const { re, framework } of routePatterns) {
                if (!re) continue;
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(content)) !== null) {
                    const method = (m[1] || 'GET').toUpperCase();
                    const routePath = m[2] || m[1];
                    if (codeMap.routeTree.length < 80) { // cap at 80 routes
                        codeMap.routeTree.push({ method, path: routePath, file: rel });
                    }
                }
            }
        }

        // Next.js: pages/api/** → routes
        const nextApiFiles = textFiles.filter(f => f.includes('pages/api/') || f.includes('app/api/'));
        for (const f of nextApiFiles) {
            const routePath = '/' + f.replace(/.*pages\/api\//, 'api/').replace(/.*app\/api\//, 'api/').replace(/\.(ts|js|tsx|jsx)$/, '').replace(/\/index$/, '');
            codeMap.routeTree.push({ method: '*', path: '/' + routePath, file: f });
        }
    } catch (_) {}

    // ── Import graph ───────────────────────────────────────────────────────────
    try {
        const jsFiles = textFiles.filter(f => /\.(js|ts|jsx|tsx|mjs)$/.test(f));
        const requireRe = /require\s*\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g;
        const importRe  = /(?:import|from)\s+['"`](\.{1,2}\/[^'"`]+)['"`]/g;

        for (const rel of jsFiles) {
            const content = fileContents[rel] || '';
            const dir = path.dirname(rel);
            const imports = new Set();

            for (const re of [requireRe, importRe]) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(content)) !== null) {
                    // Resolve relative import to project-root-relative path
                    const resolved = path.posix.normalize(path.posix.join(dir, m[1]));
                    // Strip extension for lookup, find actual file
                    const candidates = [resolved, resolved + '.js', resolved + '.ts', resolved + '/index.js', resolved + '/index.ts'];
                    const matched = candidates.find(c => textFiles.includes(c));
                    if (matched) imports.add(matched);
                }
            }

            if (imports.size > 0) {
                codeMap.importGraph[rel] = [...imports];
            }
        }
    } catch (_) {}

    // ── Domain entities ────────────────────────────────────────────────────────
    try {
        for (const rel of codeMap.fileCategories.models) {
            const content = fileContents[rel] || '';

            // Mongoose: const XSchema = new Schema({ field: ... })
            const mongooseModel = content.match(/mongoose\.model\s*\(\s*['"`](\w+)['"`]/);
            const schemaFields  = [...content.matchAll(/['"`]?(\w+)['"`]?\s*:\s*\{?\s*type\s*:/g)].map(m => m[1]).filter(f => f !== 'type' && f !== 'required').slice(0, 10);
            if (mongooseModel) {
                codeMap.domainEntities.push({ name: mongooseModel[1], file: rel, fields: schemaFields, orm: 'mongoose' });
                continue;
            }

            // Sequelize: sequelize.define('X', { field: DataTypes.X })
            const seqModel = content.match(/sequelize\.define\s*\(\s*['"`](\w+)['"`]/);
            if (seqModel) {
                const seqFields = [...content.matchAll(/(\w+)\s*:\s*\{\s*type\s*:\s*DataTypes/g)].map(m => m[1]).slice(0, 10);
                codeMap.domainEntities.push({ name: seqModel[1], file: rel, fields: seqFields, orm: 'sequelize' });
                continue;
            }

            // TypeScript interface: interface User { field: type; }
            const tsInterface = content.match(/(?:export\s+)?interface\s+(\w+)\s*\{([^}]+)\}/);
            if (tsInterface) {
                const fields = [...tsInterface[2].matchAll(/(\w+)\??:\s*\w+/g)].map(m => m[1]).slice(0, 10);
                if (fields.length >= 2) {
                    codeMap.domainEntities.push({ name: tsInterface[1], file: rel, fields, orm: 'typescript-interface' });
                }
            }
        }
    } catch (_) {}

    // ── Integrations ──────────────────────────────────────────────────────────
    try {
        const allDeps = [...npmDeps, ...pythonDeps];
        const seen = new Set();
        for (const dep of allDeps) {
            const info = KNOWN_PACKAGES[dep] || PYTHON_PACKAGES[dep];
            if (info && !seen.has(dep)) {
                seen.add(dep);
                codeMap.integrations.push({ package: dep, purpose: info.purpose, confidence: info.confidence });
            }
        }
        // Also scan code for dynamic require/import of known packages not in package.json
        const codeStr = Object.values(fileContents).join('\n').substring(0, 200000);
        for (const [pkg, info] of Object.entries({ ...KNOWN_PACKAGES, ...PYTHON_PACKAGES })) {
            if (!seen.has(pkg) && codeStr.includes(`'${pkg}'`) || codeStr.includes(`"${pkg}"`)) {
                seen.add(pkg);
                codeMap.integrations.push({ package: pkg, purpose: info.purpose, confidence: 'medium' });
            }
        }
    } catch (_) {}

    // ── Feature groups ─────────────────────────────────────────────────────────
    try {
        for (const routeFile of codeMap.fileCategories.routes.slice(0, 8)) {
            const groupFiles = new Set([routeFile]);
            // Follow import graph (depth 2)
            const walk = (f, depth) => {
                if (depth > 2) return;
                for (const imp of codeMap.importGraph[f] || []) {
                    groupFiles.add(imp);
                    walk(imp, depth + 1);
                }
            };
            walk(routeFile, 0);

            const name = path.basename(routeFile, path.extname(routeFile))
                .replace(/[_-]/g, ' ')
                .replace(/\b\w/g, c => c.toUpperCase())
                .replace(/^(Routes?|Api|Controllers?)\s*/i, '')
                || path.basename(routeFile);

            const groupFileList = [...groupFiles];
            const size = groupFileList.reduce((acc, f) => acc + (fileContents[f] || '').length, 0);

            codeMap.featureGroups.push({ name, files: groupFileList, size });
        }
        codeMap.featureGroups.sort((a, b) => b.size - a.size);
    } catch (_) {}

    return codeMap;
}

module.exports = { cartograph };

require('dotenv').config();
const express = require('express');
const logger = require('./utils/logger');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const cookieParser = require('cookie-parser');
const pluginLoader = require('./services/plugin-loader');

const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: (origin, cb) => {
            if (!origin) return cb(null, true);
            const ok = origin.includes('localhost') || origin.includes('127.0.0.1')
                || origin.includes('192.168.') || origin.includes('10.') || origin.includes('172.')
                || origin.includes('ngrok-free.app') || origin.includes('ngrok.io') || origin.includes('ngrok-free.dev');
            cb(ok ? null : new Error('CORS'), ok);
        },
        credentials: true
    }
});

const socketSingleton = require('./services/socket-singleton');
socketSingleton.setIO(io);

const PORT = process.env.PORT || 3000;
const BOTS_PATH = path.join(__dirname, 'bots.json');
const SKILLS_PATH = path.join(__dirname, 'skills.json');

// ── Startup Migration: Flat files to SQLite ────────────────────────────────
try {
    const { botsDB, skillsDB } = require('./db');
    const existingBots = botsDB.getAll();
    if (existingBots.length === 0 && fs.existsSync(BOTS_PATH)) {
        const botRegistry = JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8'));
        botsDB.saveAll(botRegistry);
        logger.info('[SERVER] Migrated bots.json to SQLite.');
    }

    const existingSkills = skillsDB.getAll();
    if (existingSkills.length === 0 && fs.existsSync(SKILLS_PATH)) {
        const skillsJSON = JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8'));
        skillsDB.saveAll(skillsJSON);
        logger.info('[SERVER] Migrated skills.json to SQLite.');
    }
} catch (e) {
    logger.warn('[SERVER] Could not perform startup db migration:', e.message);
}

// ── Supreme Architect Startup ─────────────────────────────────────────────────
const supremeArchitect = require('./supreme-architect');
const sessionService = require('./services/session');
sessionService.initSocket(io); // Initialize WebSocket
const { sessionBroadcast, sessionLog, SESSION, getLanIP } = sessionService;

supreme_architect_init();
async function supreme_architect_init() {
    if (process.env.NODE_ENV === 'test') {
        logger.info('[SERVER] Skipping supreme architect cron and updater in test environment.');
        return;
    }
    try {
        await supremeArchitect.loadSelfModel();
        supremeArchitect.startMidnightCron(sessionBroadcast);
        logger.info('[SUPREME-ARCHITECT] Self-model loaded. Midnight briefing cron started.');
        
        try {
            const updater = require('./updater');
            updater.startAutoUpdater();
        } catch (e) {
            logger.warn('[UPDATER] Could not initialize auto-updater:', e.message);
        }
    } catch (e) {
        logger.warn('[SUPREME-ARCHITECT] Startup failed (non-fatal):', e.message);
    }
}

// ── Express Middlewares ──────────────────────────────────────────────────────
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
        const isLAN = origin.includes('192.168.') || origin.includes('10.') || origin.includes('172.');
        const isNgrok = origin.includes('ngrok-free.app') || origin.includes('ngrok.io') || origin.includes('ngrok-free.dev');
        if (isLocalhost || isLAN || isNgrok || origin === 'null') {
            callback(null, true);
        } else {
            callback(new Error('Blocked by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Pavi-Token', 'ngrok-skip-browser-warning']
}));

// Express body parsers
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ── Hardened WAF Security Filter ───────────────────────────────────────────────
const injectionPatterns = /inject|override|system.?prompt|jailbreak|bypass|ignore.?previous|act.?as/i;

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logger.info({
            msg: 'http_request',
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - start,
            ip: req.ip
        });
    });
    next();
});

app.use((req, res, next) => {
    for (const headerName of Object.keys(req.headers)) {
        if (injectionPatterns.test(headerName)) {
            logger.warn(`[WAF] Blocked suspicious header: ${headerName} from ${req.ip}`);
            return res.status(400).json({ error: 'Request blocked by WAF', header: headerName });
        }
        const headerValue = String(req.headers[headerName] || '');
        if (headerValue.length < 500 && injectionPatterns.test(headerValue)) {
            logger.warn(`[WAF] Blocked injection in header value: ${headerName}`);
            return res.status(400).json({ error: 'Request blocked by WAF' });
        }
    }
    next();
});

// ── Mount Modular Routers ──────────────────────────────────────────────────
const authenticateJWT = require('./middleware/auth');
app.use(authenticateJWT);

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/health'));
app.use('/api/architect', require('./routes/architect'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/config', require('./routes/config'));
app.use('/api/models', require('./routes/models'));
app.use('/api/files', require('./routes/files'));
app.use('/api/history', require('./routes/history'));
app.use('/api/cache', require('./routes/cache'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/workspaces', require('./routes/workspaces'));
app.use('/api', require('./routes/chat'));
app.use('/api', require('./routes/general'));
app.use('/webhooks', require('./routes/github'));
app.use('/api/push', require('./routes/push'));
app.use('/api/swarm', require('./routes/swarm-control'));
app.use('/api/phase-d', require('./routes/phase-d-status'));
app.use('/api/training', require('./routes/training'));

// ── System Status Endpoint (Phase 4: Observability) ──────────────────────────
app.get('/api/status', (req, res) => {
    try {
        const { queueDB, skillsDB, stagingSkillsDB, trainingFeedbackDatasetDB } = require('./db');
        const status = {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            queue: {
                pending: (queueDB.getPending ? queueDB.getPending() : []).length,
                total: (queueDB.getAll ? queueDB.getAll() : []).length,
            },
            skills: {
                live: (skillsDB.getAll ? skillsDB.getAll() : []).length,
                staged: (stagingSkillsDB.getAll ? stagingSkillsDB.getAll() : []).filter(s => s.status === 'staged').length,
            },
            training: {
                feedbackSamples: trainingFeedbackDatasetDB.getCount(),
            },
            circuitBreakers: (() => {
                try { return require('./services/circuit-breaker').getAllBreakerStates(); } catch (_) { return []; }
            })(),
            timestamp: new Date().toISOString()
        };
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Initialize Plugins ──────────────────────────────────────────────────
pluginLoader.loadPlugins(app);

// ── Serve Static Assets ──────────────────────────────────────────────────────
app.use('/pwa', express.static(path.join(__dirname, 'pwa')));
app.use(express.static(path.join(__dirname)));
app.get('/mobile-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'mobile-login.html'));
});
app.get('/mobile', (req, res) => {
    res.sendFile(path.join(__dirname, 'mobile.html'));
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// ── Background Tunnel Setup ──────────────────────────────────────────────────
async function startNgrokTunnel() {
    if (process.env.NODE_ENV === 'test') {
        logger.info('[SERVER] Skipping ngrok tunnel in test environment.');
        return;
    }
    logger.info('[SERVER] Checking for existing ngrok tunnel...');
    try {
        const ports = [4040, 4041];
        let running = false;
        for (const p of ports) {
            try {
                const res = await fetch(`http://localhost:${p}/api/tunnels`, { signal: AbortSignal.timeout(1000) });
                if (res.ok) {
                    logger.info(`[SERVER] ngrok already running on port ${p}.`);
                    running = true;
                    break;
                }
            } catch (e) {}
        }
        
        if (!running) {
            logger.info('[SERVER] No ngrok detected. Attempting to start...');
            const ngrokProcess = spawn('ngrok', ['http', '3000'], {
                detached: true,
                stdio: 'ignore'
            });
            ngrokProcess.on('error', (err) => {
                logger.warn('[SERVER] Could not auto-start ngrok (ngrok binary not found in PATH):', err.message);
            });
            ngrokProcess.unref();
            logger.info('[SERVER] ngrok process spawned.');
        }
    } catch (e) {
        logger.warn('[SERVER] Could not auto-start ngrok:', e.message);
    }
}

// ── Startup Validator ────────────────────────────────────────────────────────
async function startupValidator() {
    logger.info('[SERVER] Running startup validation...');
    
    try {
        const { db } = require('./db');
        db.prepare('SELECT 1').get();
    } catch (e) {
        logger.error('[FATAL] Database unwritable or corrupted. Exiting.', e.message);
        process.exit(1);
    }

    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        try {
            const localBot2 = require('./local-bot');
            localBot2.configure(cfg);
        } catch (e) {
            logger.warn('[WARNING] Could not configure localBot2:', e.message);
        }

        if (cfg.workerUrl) {
            try {
                const workerOrigin = new URL(cfg.workerUrl).origin;
                const isOllama = workerOrigin.includes('11434');
                const healthUrl = isOllama ? `${workerOrigin}/api/tags` : workerOrigin;
                const checkRes = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
                if (checkRes.ok) {
                    logger.info(`[SERVER] LLM worker reachable at ${workerOrigin} ✓`);
                } else {
                    logger.warn(`[WARNING] LLM worker at ${workerOrigin} returned ${checkRes.status}. Starting anyway.`);
                }
            } catch (e) {
                logger.warn(`[WARNING] LLM worker unreachable at ${cfg.workerUrl}: ${e.message}. Starting anyway — configure the endpoint in Settings.`);
            }
        } else {
             logger.warn('[WARNING] No workerUrl configured. Use the Settings panel to configure your AI model.');
        }
        if (!cfg.githubToken && !process.env.GITHUB_TOKEN) {
            logger.warn('[WARNING] No GitHub token found in config or GITHUB_TOKEN env. Ingestion rate limits will be restricted.');
        }
    } else {
        const examplePath = path.join(__dirname, 'config.json.example');
        if (fs.existsSync(examplePath)) {
            logger.info('[SERVER] config.json not found. Initializing from config.json.example...');
            try {
                fs.copyFileSync(examplePath, configPath);
                const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const localBot2 = require('./local-bot');
                localBot2.configure(cfg);
            } catch (e) {
                logger.warn('[WARNING] Could not initialize config.json from example:', e.message);
            }
        } else {
            logger.warn('[WARNING] config.json and config.json.example not found. Proceeding with degraded config.');
        }
    }

    await startNgrokTunnel();
}

// ── Start Server ─────────────────────────────────────────────────────────────
if (require.main === module) {
    startupValidator().then(() => {
        server.listen(PORT, '0.0.0.0', () => {
            const lanIP = getLanIP();
            logger.info(`Pavi Dashboard running at http://localhost:${PORT}`);
            logger.info(`Mobile Connect:           http://${lanIP}:${PORT}/mobile`);
            logger.info(`Serving files from ${__dirname}`);
            sessionLog(`[SERVER] Started. LAN: http://${lanIP}:${PORT}/mobile`);

            // Start background health diagnostics (non-blocking)
            const { startBackgroundRefresh } = require('./services/health-cache');
            startBackgroundRefresh();

            // Start Growth Engine periodic check (every 1 hour)
            const growthEngine = require('./growth-engine');
            setInterval(() => {
                try {
                    growthEngine.runGrowthCycle();
                } catch (e) {
                    logger.error('[GROWTH_ENGINE] Periodic run failed:', e.message);
                }
            }, 60 * 60 * 1000); // 1 hour
            setTimeout(() => {
                try {
                    growthEngine.runGrowthCycle();
                } catch (e) {
                    logger.error('[GROWTH_ENGINE] Startup run failed:', e.message);
                }
            }, 10000); // Run once 10s after startup

            // Nightly consolidation at 3:00 AM

            const scheduleNightly = () => {
                const now = new Date();
                const next3AM = new Date(now);
                next3AM.setHours(3, 0, 0, 0);
                if (next3AM <= now) next3AM.setDate(next3AM.getDate() + 1);
                const msUntil3AM = next3AM - now;
                
                setTimeout(() => {
                    const supArch = require('./supreme-architect');
                    if (supArch.nightlyConsolidation) {
                        supArch.nightlyConsolidation().catch(e => logger.error('[NIGHTLY] Failed:', e.message));
                    }
                    setInterval(() => supArch.nightlyConsolidation?.().catch(err => logger.error('[NIGHTLY] Interval Failed:', err.message)), 24 * 60 * 60 * 1000);
                }, msUntil3AM);
                
                logger.info(`[SERVER] Nightly consolidation scheduled for ${next3AM.toLocaleTimeString()}`);
            };
            scheduleNightly();
        });
    });
}

module.exports = app;

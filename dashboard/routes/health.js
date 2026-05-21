const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

router.get('/logs', (req, res) => {
    const logPath = path.join(__dirname, '..', 'logs', 'pavi.log');
    try {
        if (!fs.existsSync(logPath)) return res.json({ lines: [] });
        const raw = fs.readFileSync(logPath, 'utf8');
        const lines = raw.trim().split('\n').slice(-200).map(l => {
            try { return JSON.parse(l); } catch { return { msg: l }; }
        });
        res.json({ lines });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


router.get('/health', async (req, res) => {
    try {
        const { getCachedHealth, refresh } = require('../services/health-cache');
        const report = getCachedHealth();
        res.json(report);
        // If caller explicitly requests a fresh check, trigger background refresh
        if (req.query.refresh === 'true') {
            refresh(); // fire-and-forget, doesn't block the response
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/db-sync', async (req, res) => {
    try {
        const { verifySync } = require('../migrate_skills');
        const result = verifySync();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/github-rate-limit - Return GitHub API rate limit status
router.get('/github-rate-limit', (req, res) => {
    try {
        const { settingsDB } = require('../db');
        const raw = settingsDB.get('github_rate_limit');
        if (!raw) {
            return res.json({ available: false, message: 'No GitHub API calls made yet this session.' });
        }
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const pct = data.limit > 0 ? Math.round((data.remaining / data.limit) * 100) : 100;
        const resetDate = data.reset ? new Date(data.reset * 1000).toISOString() : null;
        const staleSec = data.ts ? Math.round((Date.now() - data.ts) / 1000) : null;
        res.json({
            available: true,
            remaining: data.remaining,
            limit: data.limit,
            resetAt: resetDate,
            percentRemaining: pct,
            warning: data.remaining < 500,
            critical: data.remaining < 100,
            staleSeconds: staleSec
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/skills/health - Return skills health report
router.get('/skills/health', (req, res) => {
    try {
        const skillFeedback = require('../services/skill-feedback');
        res.json(skillFeedback.getHealthReport());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;


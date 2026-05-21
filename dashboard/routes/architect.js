const logger = require('../utils/logger');
const express = require('express');
const router = express.Router();
const path = require('path');

let skillWriter = null;
try { skillWriter = require('../skill-writer'); } catch (e) {}

let gapDetector = null;
try { gapDetector = require('../gap-detector'); } catch (e) {}

let auditLog = null;
try { auditLog = require('../audit-log'); } catch (e) {}

const supremeArchitect = require('../supreme-architect');

router.get('/self-model', async (req, res) => {
    try {
        const model = await supremeArchitect.getSelfModel();
        res.json(model);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/staged', (req, res) => {
    try {
        if (!skillWriter) throw new Error('skill-writer module not available');
        const staged = skillWriter.getStagedSkills('staged');
        res.json({ staged });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/gaps', (req, res) => {
    try {
        if (!gapDetector) throw new Error('gap-detector module not available');
        const gaps = gapDetector.getGaps('pending');
        res.json({ gaps });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/promote', (req, res) => {
    try {
        if (!skillWriter) throw new Error('skill-writer module not available');
        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ error: 'id is required' });
        }
        const result = skillWriter.promote(id);
        if (result.success) {
            try {
                const { skillsDB } = require('../db');
                const allSkills = skillsDB.getAll();
                const SKILLS_PATH = path.join(__dirname, '..', 'skills.json');
                require('fs').writeFileSync(SKILLS_PATH, JSON.stringify(allSkills, null, 2), 'utf8');
            } catch (syncErr) {
                logger.warn('[PROMOTE] Could not sync flat skills.json after promote:', syncErr.message);
            }
        }
        res.status(result.success ? 200 : 400).json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/discard', (req, res) => {
    try {
        if (!skillWriter) throw new Error('skill-writer module not available');
        const { id } = req.body;
        if (!id) {
            return res.status(400).json({ error: 'id is required' });
        }
        const result = skillWriter.discard(id);
        res.status(result.success ? 200 : 400).json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/audit-log', (req, res) => {
    try {
        if (!auditLog) throw new Error('audit-log module not available');
        const rawLimit = parseInt(req.query.limit || '100', 10);
        const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 100 : rawLimit, 500);
        const rows = auditLog.read(limit);
        const logs = rows.map(r => ({
            ts: r.ts,
            eventType: r.event,
            subject: r.tag || r.repo || 'system',
            description: (() => {
                try {
                    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
                    if (d.intent) return `Intent: ${d.intent}${d.count ? ` (${d.count}x)` : ''}`;
                    if (d.sourceRepos) return `Source repos: ${(d.sourceRepos || []).join(', ')}`;
                    return JSON.stringify(d).slice(0, 120);
                } catch (_) { return String(r.data || '').slice(0, 120); }
            })()
        }));
        res.json({ logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/briefing', (req, res) => {
    try {
        const { db } = require('../db');
        const latest = db.prepare("SELECT * FROM briefings ORDER BY id DESC LIMIT 1").get();
        if (!latest) return res.json({ briefing: null });
        res.json({ briefing: latest });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/self-model-full', async (req, res) => {
    try {
        const model = await supremeArchitect.getSelfModel();
        res.json(model);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/escalation/:id/resolve', (req, res) => {
    try {
        const { resolution } = req.body;
        const result = supremeArchitect.resolveEscalation(req.params.id, resolution || 'Resolved via dashboard');
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Daily Briefing ───────────────────────────────────────────────────────────
router.get('/briefing', (req, res) => {
    try {
        const { db } = require('../db');
        const latest = db.prepare("SELECT * FROM briefings ORDER BY id DESC LIMIT 1").get();
        if (!latest) return res.json({ briefing: null });
        res.json({ briefing: latest });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Full Self-Model (capabilities, decisions, escalations) ──────────────────
router.get('/self-model-full', async (req, res) => {
    try {
        const model = await supremeArchitect.getSelfModel();
        res.json(model);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Resolve Escalation ──────────────────────────────────────────────────────
router.post('/escalation/:id/resolve', (req, res) => {
    try {
        const { resolution } = req.body;
        const result = supremeArchitect.resolveEscalation(req.params.id, resolution || 'Resolved via dashboard');
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

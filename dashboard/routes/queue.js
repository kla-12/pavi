const logger = require('../utils/logger');
const express = require('express');
const router = express.Router();
const { queueDB, rateLimitDB } = require('../db');
const { sessionBroadcast } = require('../services/session');
const { triggerQueueDrain, queueLockOwner } = require('../services/queue-manager');

router.post('/reset', (req, res) => {
    try {
        const count = queueDB.resetFailedJobs();
        res.json({ success: true, resetCount: count });
        triggerQueueDrain();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/clear', (req, res) => {
    try {
        const count = queueDB.clearAllJobs();
        sessionBroadcast('queue_update', { queue: [], activeJob: null });
        res.json({ success: true, clearedCount: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/github-ingest', async (req, res) => {
    try {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        if (!rateLimitDB.isAllowed(clientIp, '/api/github-ingest', 10, 60000)) {
            return res.status(429).json({ error: 'Too many requests' });
        }

        const { url, label = '', branch: reqBranch, forceFlush = false } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'Missing url' });
        }

        const ghMatch = url.match(/github\.com\/([^/]+)\/([^/\s?#]+)(?:\/tree\/([^/\s?#]+))?/);
        if (!ghMatch) {
            return res.status(400).json({ error: 'Invalid GitHub URL' });
        }
        let [, owner, repo, urlBranch] = ghMatch;
        const branch = reqBranch || urlBranch || 'HEAD';
        if (repo.endsWith('.git')) repo = repo.slice(0, -4);

        const job = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            url, owner, repo, branch, label, forceFlush
        };

        queueDB.addJob(job);
        sessionBroadcast('queue_update', { queue: queueDB.getAll(), activeJob: queueLockOwner ? null : undefined });

        res.status(202).json({ queued: true, job });
        triggerQueueDrain();
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;

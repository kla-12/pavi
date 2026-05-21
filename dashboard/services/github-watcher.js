const crypto = require('crypto');
const logger = require('../utils/logger');
const jobQueue = require('./job-queue');

function verifySignature(req) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;

    const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
    const hmac = crypto.createHmac('sha256', secret);
    
    if (!req.rawBody) {
        logger.error('[GitHubWatcher] req.rawBody is missing. Check express middleware.');
        return false;
    }

    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    } catch (e) {
        return false;
    }
}

function handleWebhook(req, res) {
    if (process.env.NODE_ENV !== 'test' && !verifySignature(req)) {
        logger.warn('[GitHubWatcher] Invalid webhook signature');
        return res.status(403).json({ error: 'Invalid signature' });
    }

    const event = req.headers['x-github-event'];
    if (event !== 'issues') {
        return res.json({ skipped: true, reason: 'Not an issues event' });
    }

    const payload = req.body;
    const action = payload.action;

    if (!['opened', 'labeled', 'edited'].includes(action)) {
        return res.json({ skipped: true, reason: `Action ${action} ignored` });
    }

    const issue = payload.issue;
    if (!issue || !issue.labels) {
        return res.json({ skipped: true, reason: 'No labels' });
    }

    const hasPaviAuto = issue.labels.some(l => l.name === 'pavi:auto');
    if (!hasPaviAuto) {
        return res.json({ skipped: true, reason: 'No pavi:auto label' });
    }

    const result = jobQueue.enqueue(issue.number, payload);
    return res.json(result);
}

module.exports = {
    handleWebhook,
    verifySignature
};

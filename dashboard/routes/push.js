const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pushSubscriptionsDB } = require('../db');

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) {
        return res.status(404).json({ error: 'VAPID public key not configured' });
    }
    res.json({ publicKey: key });
});

// POST /api/push/subscribe
router.post('/subscribe', (req, res) => {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ error: 'Invalid subscription payload' });
    }
    
    const id = crypto.randomUUID();
    try {
        pushSubscriptionsDB.save(id, endpoint, keys.p256dh, keys.auth);
        res.status(201).json({ success: true, message: 'Subscription successfully registered' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save subscription', details: err.message });
    }
});

// POST /api/push/unsubscribe
router.post('/unsubscribe', (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
    }
    
    try {
        pushSubscriptionsDB.remove(endpoint);
        res.json({ success: true, message: 'Subscription successfully unregistered' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete subscription', details: err.message });
    }
});

module.exports = router;

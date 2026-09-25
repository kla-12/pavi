const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getConfig, invalidateConfigCache } = require('../services/session');
const localBot2 = require('../local-bot');

router.get('/', async (req, res) => {
    try {
        const config = await getConfig();
        res.json(config);
    } catch (e) {
        logger.error('[CONFIG] GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const newConfig = req.body;
        const configPath = path.join(__dirname, '..', 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 4));
        invalidateConfigCache();
        localBot2.configure(newConfig);
        logger.info('[CONFIG] Successfully saved new config.');
        res.json({ ok: true, success: true });
    } catch (e) {
        logger.error('[CONFIG] POST error:', e.message);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;

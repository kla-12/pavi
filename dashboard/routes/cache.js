const express = require('express');
const router = express.Router();
const { promptCacheDB } = require('../db');

// GET /api/cache/stats - Get cache statistics
router.get('/stats', (req, res) => {
    try {
        const stats = promptCacheDB.getStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/cache - Clear the entire cache
router.delete('/', (req, res) => {
    try {
        promptCacheDB.clearAll();
        res.json({ success: true, message: 'Cache cleared successfully' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

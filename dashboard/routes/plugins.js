const express = require('express');
const router = express.Router();
const pluginLoader = require('../services/plugin-loader');

// GET /api/plugins - List all loaded plugins (includes metrics)
router.get('/', (req, res) => {
    try {
        const plugins = pluginLoader.getLoadedPlugins();
        res.json({ success: true, plugins });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/plugins/:id/toggle - Enable/disable a plugin
router.post('/:id/toggle', (req, res) => {
    try {
        const { id } = req.params;
        const { enabled } = req.body;
        
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Missing or invalid "enabled" boolean in body' });
        }
        
        pluginLoader.togglePlugin(id, enabled);
        res.json({ success: true, id, enabled });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/plugins/:id/stats - Retrieve details stats for a plugin
router.get('/:id/stats', (req, res) => {
    try {
        const { id } = req.params;
        const plugins = pluginLoader.getLoadedPlugins();
        const plugin = plugins.find(p => p.id === id);
        
        if (!plugin) {
            return res.status(404).json({ success: false, error: `Plugin not found: ${id}` });
        }
        
        res.json({ success: true, stats: plugin.stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/plugins/:id/test - Perform direct test execution of a plugin
router.post('/:id/test', async (req, res) => {
    try {
        const { id } = req.params;
        const { params } = req.body;
        
        if (!params || typeof params !== 'object') {
            return res.status(400).json({ success: false, error: 'Missing or invalid "params" object in request body' });
        }
        
        const result = await pluginLoader.executePlugin(id, params);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

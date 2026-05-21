const express = require('express');
const router = express.Router();
const { settingsDB } = require('../db');

// Add global fetch mock fallback in case global.fetch is not natively available (Node < 18)
// Pavi likely runs on Node 18+ since it uses global.fetch elsewhere.

router.get('/', async (req, res) => {
    try {
        let ollamaUrl = req.query.url || 'http://localhost:11434';
        // Normalize the URL
        let targetUrl = ollamaUrl;
        if (targetUrl.includes('/v1/chat/completions')) {
            targetUrl = targetUrl.replace('/v1/chat/completions', '/api/tags');
        } else if (targetUrl.includes('/v1')) {
            targetUrl = targetUrl.replace('/v1', '/api/tags');
        } else {
            // strip trailing slash and append /api/tags
            targetUrl = targetUrl.replace(/\/$/, '') + '/api/tags';
        }

        console.log(`[MODELS] Querying Ollama models from dynamic endpoint: ${targetUrl}`);
        const response = await fetch(targetUrl);
        if (!response.ok) {
            throw new Error(`Ollama returned status: ${response.status}`);
        }
        const data = await response.json();
        
        // Extract model names
        const models = data.models ? data.models.map(m => m.name) : [];
        
        // Get currently selected model
        const selectedModel = settingsDB.get('selected_model', 'phi3:mini');

        res.json({
            ok: true,
            models: models,
            selected_model: selectedModel
        });
    } catch (e) {
        console.warn(`[MODELS] Failed to fetch Ollama models from dynamic URL: ${e.message}`);
        // Fallback to currently selected if Ollama is unreachable
        const selectedModel = settingsDB.get('selected_model', 'phi3:mini');
        res.json({
            ok: false,
            error: e.message,
            models: [selectedModel],
            selected_model: selectedModel
        });
    }
});

router.post('/select', (req, res) => {
    try {
        const { model } = req.body;
        if (!model) {
            return res.status(400).json({ error: 'Model name is required' });
        }
        
        settingsDB.set('selected_model', model);
        console.log(`[MODELS] User selected model: ${model}`);
        
        res.json({ ok: true, selected_model: model });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const path = require('path');
const harvester = require('../harvester');
const growthEngine = require('../growth-engine');

router.get('/export', (req, res) => {
    try {
        const outputPath = path.join(__dirname, '..', '..', 'notebook_llm_exports', 'dpo_dataset.jsonl');
        console.log(`[TRAINING] Exporting DPO dataset to ${outputPath}`);
        const result = harvester.exportDPODataset(outputPath);
        if (result.success) {
            res.json({
                ok: true,
                count: result.count,
                outputPath: result.outputPath
            });
        } else {
            res.status(500).json({
                ok: false,
                error: result.error
            });
        }
    } catch (e) {
        console.error(`[TRAINING] Export failed:`, e);
        res.status(500).json({
            ok: false,
            error: e.message
        });
    }
});

// GET /api/training/growth-status
router.get('/growth-status', (req, res) => {
    try {
        const status = growthEngine.getTrainingStatus();
        res.json({ ok: true, status });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/training/growth-cycle
router.post('/growth-cycle', (req, res) => {
    try {
        const result = growthEngine.runGrowthCycle();
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;


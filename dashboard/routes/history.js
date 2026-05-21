const express = require('express');
const router = express.Router();
const { db, swarmRunsDB } = require('../db');
const { spawnSwarm } = require('../swarm-orchestrator');

// GET /api/history - Get paginated swarm runs
router.get('/', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;
        const runs = swarmRunsDB.getAll(limit, offset);
        res.json({ success: true, runs });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/history/stats - Get quality scores & topology learning statistics
router.get('/stats', (req, res) => {
    try {
        const stats = swarmRunsDB.getTopologyStats();
        
        const overview = db.prepare(`
            SELECT
                AVG(quality_score) as avg_quality,
                SUM(retry_count) as total_retries
            FROM swarm_runs
            WHERE status != 'deleted'
        `).get();

        const activeTopologiesRow = db.prepare(`
            SELECT GROUP_CONCAT(DISTINCT topology_used) as topologies
            FROM swarm_runs
            WHERE status != 'deleted' AND topology_used IS NOT NULL AND topology_used != ''
        `).get();

        res.json({
            success: true,
            avgQuality: overview.avg_quality ? Math.round(overview.avg_quality) : null,
            totalRetries: overview.total_retries || 0,
            activeTopologies: activeTopologiesRow.topologies || 'none',
            stats
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/history/stats/topology — Topology performance data for the learning dashboard
router.get('/stats/topology', (req, res) => {
    try {
        const stats = swarmRunsDB.getTopologyStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/history/stats/overview — Overall quality summary
router.get('/stats/overview', (req, res) => {
    try {
        const row = db.prepare(`
            SELECT
                COUNT(*) as total_runs,
                AVG(quality_score) as avg_quality,
                SUM(CASE WHEN quality_score >= 80 THEN 1 ELSE 0 END) as high_quality_runs,
                SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retried_runs,
                SUM(retry_count) as total_retries
            FROM swarm_runs
            WHERE status != 'deleted'
        `).get();
        res.json({ success: true, overview: row });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/history/:id - Get a specific swarm run
router.get('/:id', (req, res) => {
    try {
        const run = swarmRunsDB.getById(req.params.id);
        if (!run) return res.status(404).json({ success: false, error: 'Run not found' });
        res.json({ success: true, run });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/history/:id/replay - Replay a past swarm run
router.post('/:id/replay', async (req, res) => {
    try {
        const run = swarmRunsDB.getById(req.params.id);
        if (!run) return res.status(404).json({ success: false, error: 'Run not found' });
        
        // Asynchronously start the swarm so we don't block the request
        spawnSwarm(run.prompt).catch(console.error);
        
        res.json({ success: true, message: 'Replay started' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/history/:id - Soft delete a swarm run
router.delete('/:id', (req, res) => {
    try {
        swarmRunsDB.delete(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

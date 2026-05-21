const express = require('express');
const router = express.Router();
const swarmOrchestrator = require('../swarm-orchestrator');
const socketSingleton = require('../services/socket-singleton');
const { swarmRunsDB } = require('../db');

router.post('/cancel', (req, res) => {
    const { runId } = req.body;
    const cancelled = swarmOrchestrator.cancelSwarm(runId);
    
    if (cancelled) {
        const io = socketSingleton.getIO();
        if (io) {
            io.emit('swarm_cancelled', { runId, message: 'Swarm execution manually cancelled by user.' });
        }
        return res.json({ success: true, message: 'Swarm execution cancelled successfully.' });
    }
    
    return res.status(400).json({ success: false, error: 'No active swarm session found to cancel.' });
});

router.get('/status', (req, res) => {
    try {
        const runs = swarmRunsDB.getAll(50, 0);
        const running = runs.filter(r => r.status === 'running');
        const circuit = swarmOrchestrator.getCircuitStatus();
        return res.json({
            success: true,
            runningRuns: running,
            circuitBreaker: circuit
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

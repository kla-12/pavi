'use strict';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { workspacesDB } = require('../db');

// GET /api/workspaces
router.get('/', (req, res) => {
    try {
        res.json({ success: true, workspaces: workspacesDB.getAll() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/workspaces — Create a new workspace
router.post('/', (req, res) => {
    const { name, rootPath, description } = req.body;
    if (!name || !rootPath) return res.status(400).json({ error: 'name and rootPath required' });

    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved)) return res.status(400).json({ error: 'Path does not exist on disk' });

    try {
        const id = randomUUID();
        workspacesDB.create(id, name.trim(), resolved, description);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/workspaces/:id/activate — Switch active workspace
router.post('/:id/activate', (req, res) => {
    try {
        const ws = workspacesDB.getById(req.params.id);
        if (!ws) return res.status(404).json({ error: 'Workspace not found' });
        workspacesDB.setActive(req.params.id);
        res.json({ success: true, workspace: workspacesDB.getById(req.params.id) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/workspaces/:id
router.delete('/:id', (req, res) => {
    try {
        workspacesDB.delete(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

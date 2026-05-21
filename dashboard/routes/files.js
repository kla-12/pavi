'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { pendingChangesDB } = require('../db');
const { sessionBroadcast } = require('../services/session');
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const ALLOWED_ROOT = path.resolve(path.join(__dirname, '..', '..'));

function safeResolve(targetPath) {
    if (!targetPath) return null;
    let normalizedPath = targetPath.replace(/\\/g, '/');
    if (normalizedPath.startsWith('/workspace/')) {
        normalizedPath = path.join(ALLOWED_ROOT, normalizedPath.substring('/workspace/'.length));
    } else if (normalizedPath === '/workspace') {
        normalizedPath = ALLOWED_ROOT;
    }
    const resolved = path.resolve(normalizedPath);
    if (!resolved.startsWith(ALLOWED_ROOT)) {
        return null;
    }
    return resolved;
}

// GET /api/files/pending
router.get('/pending', (req, res) => {
    try {
        const changes = pendingChangesDB.getAllPending();
        res.json({ success: true, changes });
    } catch (e) {
        logger.error('[FILES] Failed to get pending changes:', e.message);
        res.status(500).json({ error: 'Failed to fetch pending changes' });
    }
});

// POST /api/files/pending
router.post('/pending', (req, res) => {
    const { filePath, originalContent, proposedContent, swarmRunId } = req.body;
    if (!filePath) {
        return res.status(400).json({ error: 'Missing filePath' });
    }
    
    const safePath = safeResolve(filePath);
    if (!safePath) {
        return res.status(403).json({ error: 'Access denied: path is outside project root' });
    }
    
    try {
        const id = pendingChangesDB.addPendingChange(
            safePath,
            originalContent || '',
            proposedContent || '',
            swarmRunId || `run_${Date.now()}`
        );
        
        logger.info(`[FILES] Intercepted write. Added pending change for file: ${safePath}`);
        
        // Broadcast socket event
        sessionBroadcast('pending_change_added', {
            id,
            file_path: safePath,
            original_content: originalContent || '',
            proposed_content: proposedContent || '',
            swarm_run_id: swarmRunId,
            status: 'pending',
            timestamp: Date.now()
        });
        
        res.json({ success: true, id });
    } catch (e) {
        logger.error('[FILES] Failed to add pending change:', e.message);
        res.status(500).json({ error: 'Failed to record pending change' });
    }
});

// GET /api/files/read
router.get('/read', (req, res) => {
    const { file } = req.query;
    if (!file) {
        return res.status(400).json({ error: 'Missing file query parameter' });
    }
    
    const safePath = safeResolve(file);
    if (!safePath) {
        logger.warn(`[WAF/FILES] Blocked path traversal attempt or out-of-bounds access: ${file}`);
        return res.status(403).json({ error: 'Access denied: path is outside project root' });
    }
    
    try {
        if (!fs.existsSync(safePath)) {
            return res.json({ success: true, content: '' }); // Return empty for new files
        }
        const content = fs.readFileSync(safePath, 'utf8');
        res.json({ success: true, content });
    } catch (e) {
        logger.error(`[FILES] Failed to read file ${safePath}:`, e.message);
        res.status(500).json({ error: 'Failed to read file' });
    }
});

// POST /api/files/write
router.post('/write', (req, res) => {
    const { filePath, content } = req.body;
    if (!filePath || typeof content !== 'string') {
        return res.status(400).json({ error: 'Missing filePath or content' });
    }
    
    const safePath = safeResolve(filePath);
    if (!safePath) {
        return res.status(403).json({ error: 'Access denied: path is outside project root' });
    }
    
    try {
        const dir = path.dirname(safePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(safePath, content, 'utf8');
        logger.info(`[FILES] Directly wrote file: ${safePath}`);
        res.json({ success: true, message: 'File written successfully' });
    } catch (e) {
        logger.error(`[FILES] Failed to write file ${safePath}:`, e.message);
        res.status(500).json({ error: 'Failed to write file' });
    }
});

// POST /api/files/pending/:id/respond
router.post('/pending/:id/respond', (req, res) => {
    const { id } = req.params;
    const { action } = req.body;
    
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Must be approve or reject.' });
    }
    
    try {
        const change = pendingChangesDB.getPendingChange(id);
        if (!change) {
            return res.status(404).json({ error: 'Pending change not found' });
        }
        if (change.status !== 'pending') {
            return res.status(400).json({ error: 'Change is already resolved' });
        }
        
        if (action === 'reject') {
            pendingChangesDB.updateStatus(id, 'rejected');
            logger.info(`[FILES] Rejected pending change for file: ${change.file_path}`);
            sessionBroadcast('pending_changes_update', { id, status: 'rejected' });
            return res.json({ success: true, message: 'Change rejected successfully' });
        }
        
        // action === 'approve'
        const safePath = safeResolve(change.file_path);
        if (!safePath) {
            return res.status(403).json({ error: 'Access denied: path is outside project root' });
        }
        
        // Ensure directory exists
        const dir = path.dirname(safePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write content to file
        fs.writeFileSync(safePath, change.proposed_content, 'utf8');
        pendingChangesDB.updateStatus(id, 'approved');
        logger.info(`[FILES] Approved and committed pending change for file: ${change.file_path}`);
        sessionBroadcast('pending_changes_update', { id, status: 'approved' });
        res.json({ success: true, message: 'Change approved and written to disk successfully' });
    } catch (e) {
        logger.error('[FILES] Failed to resolve pending change:', e.message);
        res.status(500).json({ error: 'Failed to resolve pending change' });
    }
});

module.exports = router;

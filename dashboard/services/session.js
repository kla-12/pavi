const fs = require('fs');
const path = require('path');
const os = require('os');
const { dbSession } = require('../db');

let ioInstance = null;

function initSocket(io) {
    ioInstance = io;
    io.on('connection', (socket) => {
        socket.emit('session', { status: SESSION.status, currentTask: SESSION.currentTask, lastLearnedRepo: SESSION.lastLearnedRepo });
        socket.emit('queue_update', { queue: require('../db').queueDB.getAll(), activeJob: null });
        
        socket.on('cancel_swarm', () => {
            console.log('[SOCKET] Received cancel_swarm command.');
            if (SESSION.status !== 'idle') {
                withSessionLock(async () => {
                    SESSION.status = 'idle';
                    SESSION.currentTask = 'Cancelled by user.';
                    saveSession();
                    sessionBroadcast('session', { status: 'idle', currentTask: 'Cancelled by user.' });
                });
                
                // If there's an ongoing process (like Claude Flow), we can emit an event internally
                const { EventEmitter } = require('events');
                if (!global.swarmEvents) global.swarmEvents = new EventEmitter();
                global.swarmEvents.emit('cancel');
            }
        });
    });
}

const SESSION = {
    selectedFolder: dbSession.get('selectedFolder', ''),
    status: dbSession.get('status', 'idle'),
    currentTask: dbSession.get('currentTask', ''),
    logs: dbSession.get('logs', []),
    contextNotes: dbSession.get('contextNotes', []),
    lastLearnedRepo: null
};

let sessionLock = Promise.resolve();
async function withSessionLock(fn) {
    const next = sessionLock.then(async () => {
        try {
            return await fn();
        } catch (e) {
            console.error('[SESSION-LOCK] Error inside locked operation:', e.message);
            try {
                if (SESSION.status !== 'idle') {
                    SESSION.status = 'idle';
                    saveSession();
                }
            } catch (_) {}
            throw e;
        }
    });
    sessionLock = next.catch(() => {});
    return next;
}

let saveTimeout = null;
function saveSession() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
        dbSession.set('selectedFolder', SESSION.selectedFolder);
        dbSession.set('status', SESSION.status);
        dbSession.set('currentTask', SESSION.currentTask);
        dbSession.set('logs', SESSION.logs);
        dbSession.set('contextNotes', SESSION.contextNotes);
        saveTimeout = null;
    }, 500);
}

let _cachedConfig = null;
async function getConfig() {
    if (_cachedConfig) return _cachedConfig;
    try {
        const text = await fs.promises.readFile(path.join(__dirname, '..', 'config.json'), 'utf8');
        _cachedConfig = JSON.parse(text);
    } catch (_) { _cachedConfig = {}; }
    return _cachedConfig;
}
function invalidateConfigCache() { _cachedConfig = null; }

function sessionBroadcast(type, data) {
    if (ioInstance) {
        ioInstance.emit(type, data);
    }
}

function sessionLog(line) {
    withSessionLock(async () => {
        SESSION.logs.push({ ts: Date.now(), line });
        if (SESSION.logs.length > 200) SESSION.logs.shift();
        saveSession();
        sessionBroadcast('log', { line });
    });
}

function getLanIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '127.0.0.1';
}

function getPhoneCount() {
    if (!ioInstance) return 0;
    return Math.max(0, ioInstance.engine.clientsCount - 1);
}

module.exports = {
    initSocket,
    SESSION,
    withSessionLock,
    saveSession,
    getConfig,
    invalidateConfigCache,
    sessionBroadcast,
    sessionLog,
    getLanIP,
    getPhoneCount
};


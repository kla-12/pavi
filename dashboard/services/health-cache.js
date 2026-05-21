// services/health-cache.js
const logger = require('../utils/logger');

let cachedReport = null;
let lastRefreshedAt = null;
let refreshing = false;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 10 * 1000;         // 10 seconds after boot

async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
        const { runDiagnostics } = require('../test-hardening');
        cachedReport = await runDiagnostics();
        lastRefreshedAt = Date.now();
        logger.info('[HEALTH-CACHE] Diagnostics refreshed successfully.');
    } catch (e) {
        logger.warn('[HEALTH-CACHE] Diagnostics refresh failed:', e.message);
        cachedReport = {
            timestamp: Date.now(),
            status: 'error',
            error: e.message,
            components: {}
        };
    } finally {
        refreshing = false;
    }
}

function getCachedHealth() {
    if (!cachedReport) {
        return {
            timestamp: Date.now(),
            status: 'pending',
            message: 'Health diagnostics initializing...',
            components: {
                database:    { status: 'pending', details: 'Checking...' },
                config:      { status: 'pending', details: 'Checking...' },
                ollama:      { status: 'pending', details: 'Checking...' },
                agentdb:     { status: 'pending', details: 'Checking...' },
                github:      { status: 'pending', details: 'Checking...' },
                vectorStore: { status: 'pending', details: 'Checking...' }
            }
        };
    }
    return { ...cachedReport, cachedAt: lastRefreshedAt };
}

function startBackgroundRefresh() {
    // First refresh after a short delay (don't block server startup)
    setTimeout(() => refresh(), INITIAL_DELAY_MS);
    // Periodic refresh
    setInterval(() => refresh(), REFRESH_INTERVAL_MS);
    logger.info(`[HEALTH-CACHE] Background refresh scheduled: initial=${INITIAL_DELAY_MS}ms, interval=${REFRESH_INTERVAL_MS}ms`);
}

module.exports = { getCachedHealth, startBackgroundRefresh, refresh };

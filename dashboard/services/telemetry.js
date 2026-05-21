'use strict';
/**
 * telemetry.js — Structured Event Emitters for Local SQLite Telemetry
 *
 * Immutable event tracking for observability. All events stored locally
 * in the telemetry_events table for dashboarding and analysis.
 */

const crypto = require('crypto');

let db;
try {
    db = require('../db').db;
    // Create telemetry table if it doesn't exist
    db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_events (
            id TEXT PRIMARY KEY,
            event TEXT NOT NULL,
            data TEXT,
            timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_event ON telemetry_events(event);
        CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_events(timestamp);
    `);
} catch (e) {
    console.warn('[TELEMETRY] Could not initialize database:', e.message);
}

/**
 * Emit a telemetry event.
 * @param {string} event - Event type (e.g. 'swarm_started', 'skill_promoted')
 * @param {object} [data] - Event metadata
 */
function emit(event, data = {}) {
    if (!db) return;
    try {
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO telemetry_events (id, event, data, timestamp) VALUES (?, ?, ?, ?)')
            .run(id, event, JSON.stringify(data), Date.now());
    } catch (e) {
        // Telemetry is non-blocking — never crash the caller
        console.warn(`[TELEMETRY] Emit failed for "${event}":`, e.message);
    }
}

/**
 * Query recent events of a given type.
 * @param {string} event
 * @param {number} [limit=100]
 * @returns {Array<{ id: string, event: string, data: object, timestamp: number }>}
 */
function query(event, limit = 100) {
    if (!db) return [];
    try {
        const rows = db.prepare('SELECT * FROM telemetry_events WHERE event = ? ORDER BY timestamp DESC LIMIT ?')
            .all(event, limit);
        return rows.map(r => ({
            ...r,
            data: (() => { try { return JSON.parse(r.data); } catch (_) { return r.data; } })()
        }));
    } catch (e) {
        return [];
    }
}

/**
 * Get aggregate metrics across all telemetry events.
 * @returns {{ totalEvents: number, eventsLastHour: number, byType: object }}
 */
function getMetrics() {
    if (!db) return { totalEvents: 0, eventsLastHour: 0, byType: {} };
    try {
        const totalEvents = db.prepare('SELECT COUNT(*) as cnt FROM telemetry_events').get().cnt;
        const hourAgo = Date.now() - 3600000;
        const eventsLastHour = db.prepare('SELECT COUNT(*) as cnt FROM telemetry_events WHERE timestamp > ?').get(hourAgo).cnt;

        const typeRows = db.prepare('SELECT event, COUNT(*) as cnt FROM telemetry_events GROUP BY event ORDER BY cnt DESC').all();
        const byType = {};
        for (const row of typeRows) {
            byType[row.event] = row.cnt;
        }

        return { totalEvents, eventsLastHour, byType };
    } catch (e) {
        return { totalEvents: 0, eventsLastHour: 0, byType: {} };
    }
}

/**
 * Prune old telemetry events.
 * @param {number} [olderThanDays=30]
 * @returns {{ deleted: number }}
 */
function prune(olderThanDays = 30) {
    if (!db) return { deleted: 0 };
    try {
        const cutoff = Date.now() - (olderThanDays * 86400000);
        const result = db.prepare('DELETE FROM telemetry_events WHERE timestamp < ?').run(cutoff);
        console.log(`[TELEMETRY] Pruned ${result.changes} events older than ${olderThanDays} days.`);
        return { deleted: result.changes };
    } catch (e) {
        return { deleted: 0 };
    }
}

module.exports = { emit, query, getMetrics, prune };

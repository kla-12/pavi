'use strict';
/**
 * audit-log.js — Structured Audit Trail for Pavi Self-Modifications
 *
 * Every self-modification event (skill learned, staged, promoted, rolled back,
 * bot upgraded, repo quarantined, etc.) writes a structured entry here.
 * This gives you a full, replayable history of how Pavi evolved over time.
 */

const { db } = require('./db');

const MAX_ENTRIES = 500;

const EVENT_TYPES = {
  // Intake events
  REPO_ACCEPTED:      'repo_accepted',
  REPO_PARTIAL:       'repo_partial',
  REPO_QUARANTINED:   'repo_quarantined',
  REPO_REJECTED:      'repo_rejected',
  REPO_RESCORED:      'repo_rescored',

  // Capability events
  INTENTS_TAGGED:     'intents_tagged',
  GAP_DETECTED:       'gap_detected',
  NO_GAP:             'no_gap',

  // Skill lifecycle
  SKILL_STAGED:       'skill_staged',
  SKILL_PROMOTED:     'skill_promoted',
  SKILL_DISCARDED:    'skill_discarded',
  SKILL_ROLLED_BACK:  'skill_rolled_back',

  // Bot upgrade events
  BOT_UPGRADED:       'bot_upgraded',
  BOT_UPGRADE_FAILED: 'bot_upgrade_failed',

  // Plugin events
  PLUGIN_SCAFFOLDED:  'plugin_scaffolded',

  // Singularity loop
  MUTATION_WIN:       'mutation_win',
  MUTATION_STABLE:    'mutation_stable',
  MUTATION_ROLLBACK:  'mutation_rollback',
};

const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log (id, ts, event, tag, repo, data)
  VALUES (@id, @ts, @event, @tag, @repo, @data)
`);

const getAuditStmt = db.prepare(`
  SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?
`);

const getAuditByEventStmt = db.prepare(`
  SELECT * FROM audit_log WHERE event = ? ORDER BY ts DESC LIMIT ?
`);

const trimAuditStmt = db.prepare(`
  DELETE FROM audit_log WHERE id NOT IN (
    SELECT id FROM audit_log ORDER BY ts DESC LIMIT ?
  )
`);

/**
 * Write an audit event.
 * @param {string} event - One of EVENT_TYPES values
 * @param {object} data  - Arbitrary metadata for this event
 */
function log(event, data = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    event,
    tag: data.tag || null,
    repo: data.repo || null,
    data: JSON.stringify(data)
  };
  insertAuditStmt.run(entry);
  trimAuditStmt.run(MAX_ENTRIES);
  console.log(`[AUDIT] ${event}${data.tag ? ' ' + data.tag : ''}${data.repo ? ' ' + data.repo : ''}`);
  return { ...entry, data };
}

/**
 * Read all audit entries, newest first.
 * @param {number} limit - Max entries to return
 */
function read(limit = 100) {
  const rows = getAuditStmt.all(limit);
  return rows.map(r => ({ ...r, data: JSON.parse(r.data) }));
}

/**
 * Read entries filtered by event type.
 */
function readByEvent(eventType, limit = 50) {
  const rows = getAuditByEventStmt.all(eventType, limit);
  return rows.map(r => ({ ...r, data: JSON.parse(r.data) }));
}

module.exports = { log, read, readByEvent, EVENT_TYPES };

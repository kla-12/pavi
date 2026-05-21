'use strict';
let _db;
function getDb() { if (!_db) _db = require('./db').db; return _db; }

function checkRules(signal) {
    const rules = getDb().prepare("SELECT * FROM architect_rules WHERE action = 'BLOCK'").all();
    const text = [signal.owner, signal.repo, ...(signal.fileList || [])].join(' ').toLowerCase();
    for (const rule of rules) {
        try {
            if (new RegExp(rule.pattern, 'i').test(text)) {
                getDb().prepare("UPDATE architect_rules SET trigger_count = trigger_count + 1 WHERE id = ?").run(rule.id);
                return { blocked: true, reason: rule.reason || `Blocked by rule: ${rule.pattern}` };
            }
        } catch(e) {}
    }
    return { blocked: false };
}

function learnFromDecision({ verdict, reason }) {
    if (verdict !== 'REJECT') return;
    const db = getDb();
    const key = reason.slice(0, 80);
    const existing = db.prepare("SELECT id, trigger_count FROM architect_rules WHERE reason = ? AND auto_learned = 1").get(key);
    if (existing) {
        db.prepare("UPDATE architect_rules SET trigger_count = trigger_count + 1 WHERE id = ?").run(existing.id);
        if (existing.trigger_count + 1 >= 3) {
            db.prepare("UPDATE architect_rules SET action = 'BLOCK' WHERE id = ? AND action = 'TRACK'").run(existing.id);
            console.log(`[ARCHITECT-RULES] Auto-promoted to BLOCK: "${key}"`);
        }
    } else {
        db.prepare("INSERT INTO architect_rules (pattern, action, reason, trigger_count, auto_learned, created_ts) VALUES (?, 'TRACK', ?, 1, 1, ?)")
          .run(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), key, Date.now());
    }
}

function getAll() { return getDb().prepare("SELECT * FROM architect_rules ORDER BY trigger_count DESC").all(); }
function addRule({ pattern, action = 'BLOCK', reason }) {
    getDb().prepare("INSERT INTO architect_rules (pattern, action, reason, trigger_count, auto_learned, created_ts) VALUES (?, ?, ?, 0, 0, ?)")
      .run(pattern, action, reason || '', Date.now());
}
function deleteRule(id) { getDb().prepare("DELETE FROM architect_rules WHERE id = ?").run(id); }
function updateRule(id, fields) {
    const db = getDb();
    if (fields.action)  db.prepare("UPDATE architect_rules SET action = ? WHERE id = ?").run(fields.action, id);
    if (fields.pattern) db.prepare("UPDATE architect_rules SET pattern = ? WHERE id = ?").run(fields.pattern, id);
    if (fields.reason)  db.prepare("UPDATE architect_rules SET reason = ? WHERE id = ?").run(fields.reason, id);
}

module.exports = { checkRules, learnFromDecision, getAll, addRule, deleteRule, updateRule };

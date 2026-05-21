'use strict';
/**
 * intake-filter.js — Domain Scorer & Pre-Ingest Gate
 *
 * Runs BEFORE any LLM call or embedding.
 * Pure string-matching — zero API cost.
 *
 * Four outcomes:
 *   FULL      (score >= 0.40) → normal ingest pipeline
 *   PARTIAL   (0.25–0.39)    → extract universal patterns only
 *   QUARANTINE (< 0.25)      → store for nightly rescore, notify user
 *   REJECTED  (hard keywords) → immediate discard, log reason
 *
 * Universal patterns are ALWAYS extracted regardless of score:
 *   retry/backoff, state machines, event buses, circuit breakers, etc.
 */

const fs   = require('fs');
const path = require('path');
const audit = require('./audit-log');

const CONFIG_PATH     = path.join(__dirname, 'intake-config.json');
const QUARANTINE_PATH = path.join(__dirname, 'quarantine.json');

// ── Load config ────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {
      domainKeywords: ['api', 'agent', 'async', 'queue', 'worker', 'fetch', 'server'],
      universalPatterns: ['retry', 'backoff', 'debounce', 'throttle', 'circuit', 'queue'],
      hardRejectExtensions: ['.ino', '.hex', '.o', '.s'],
      hardRejectKeywords: ['void setup()', 'void loop()', 'digitalWrite', '#include <Arduino'],
      hardRejectDomains: ['firmware', 'embedded c', 'microcontroller'],
      thresholds: { full: 0.40, partial: 0.25 }
    };
  }
}

// ── Quarantine store ───────────────────────────────────────────────────────────
function loadQuarantine() {
  try {
    if (fs.existsSync(QUARANTINE_PATH)) return JSON.parse(fs.readFileSync(QUARANTINE_PATH, 'utf8'));
  } catch (e) {}
  return [];
}

function saveQuarantine(entries) {
  try {
    fs.writeFileSync(QUARANTINE_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch (e) {}
}

function quarantine(repoKey, score, reason, fileExtensions) {
  const entries = loadQuarantine();
  const existing = entries.findIndex(e => e.repoKey === repoKey);
  const entry = {
    repoKey,
    score,
    reason,
    fileExtensions,
    quarantinedAt: new Date().toISOString(),
    rescoredAt: null,
    rescoredScore: null
  };
  if (existing !== -1) entries[existing] = entry;
  else entries.push(entry);
  saveQuarantine(entries);
  return entry;
}

// ── Domain Scorer ──────────────────────────────────────────────────────────────
/**
 * Score a repo's domain relevance to Pavi (0.0–1.0).
 *
 * @param {string[]} fileList       - Array of file paths from the repo
 * @param {string}   codeContext    - Concatenated file content sample
 * @param {string}   topicHint      - User's label hint
 * @returns {{ score: number, hits: string[], fileExtensions: object }}
 */
function scoreRepo(fileList, codeContext, topicHint = '') {
  const cfg = loadConfig();
  const ctx = (codeContext + ' ' + topicHint).toLowerCase();
  const hits = [];

  // Extension frequency map
  const extMap = {};
  for (const f of fileList) {
    const ext = path.extname(f).toLowerCase();
    extMap[ext] = (extMap[ext] || 0) + 1;
  }

  // Domain keyword hits (weighted: 0.05 per unique keyword, max 0.60)
  let keywordScore = 0;
  for (const kw of cfg.domainKeywords) {
    if (ctx.includes(kw)) {
      hits.push(`keyword:${kw}`);
      keywordScore += 0.05;
    }
  }
  keywordScore = Math.min(keywordScore, 0.60);

  // File extension bonus (JS/TS/Python = good for Pavi)
  const goodExts = ['.js', '.ts', '.mjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs'];
  const badExts  = ['.ino', '.hex', '.c', '.cpp', '.h', '.s', '.o', '.a', '.elf'];

  let extScore = 0;
  for (const [ext, count] of Object.entries(extMap)) {
    if (goodExts.includes(ext)) { extScore += 0.05 * Math.min(count, 3); hits.push(`ext:${ext}`); }
    if (badExts.includes(ext))  { extScore -= 0.08 * Math.min(count, 3); }
  }
  extScore = Math.max(-0.30, Math.min(0.30, extScore));

  // Topic hint bonus (user said it's relevant)
  const hintScore = topicHint.length > 3 ? 0.10 : 0;

  const total = Math.max(0, Math.min(1, keywordScore + extScore + hintScore));
  return { score: parseFloat(total.toFixed(3)), hits, fileExtensions: extMap };
}

// ── Hard Reject Check ──────────────────────────────────────────────────────────
/**
 * Check for instant-discard signals — no domain score needed.
 * Returns { rejected: boolean, reason: string }
 */
function hardRejectCheck(fileList, codeContext) {
  const cfg = loadConfig();
  const ctx = codeContext.slice(0, 5000).toLowerCase();

  // Hard-reject file extensions
  for (const f of fileList) {
    const ext = path.extname(f).toLowerCase();
    if (cfg.hardRejectExtensions.includes(ext)) {
      return { rejected: true, reason: `Hardware/binary file extension detected: ${ext}` };
    }
  }

  // Hard-reject keywords in code
  for (const kw of cfg.hardRejectKeywords) {
    if (ctx.includes(kw.toLowerCase())) {
      return { rejected: true, reason: `Firmware/hardware keyword detected: "${kw}"` };
    }
  }

  // Hard-reject domains in topic
  return { rejected: false, reason: '' };
}

// ── Universal Pattern Extractor ────────────────────────────────────────────────
/**
 * Even if a repo is quarantined, scan for universally useful patterns.
 * Returns array of pattern names found.
 */
function extractUniversalPatterns(codeContext) {
  const cfg = loadConfig();
  const ctx = codeContext.toLowerCase();
  const found = [];
  for (const pattern of cfg.universalPatterns) {
    if (ctx.includes(pattern.toLowerCase())) {
      found.push(pattern);
    }
  }
  return found;
}

// ── Main Gate ─────────────────────────────────────────────────────────────────
/**
 * Run the full intake gate on a repo.
 *
 * @param {string}   repoKey     - e.g. "github.com/owner/repo"
 * @param {string[]} fileList    - All file paths extracted
 * @param {string}   codeContext - Sample of file contents (first 50k chars)
 * @param {string}   topicHint   - User label
 *
 * @returns {{
 *   outcome: 'full'|'partial'|'quarantine'|'rejected',
 *   score: number,
 *   reason: string,
 *   rescuedPatterns: string[],
 *   notification: string
 * }}
 */
function gate(repoKey, fileList, codeContext, topicHint = '') {
  const cfg = loadConfig();

  // Gate 1: Hard reject (free, instant)
  const hardCheck = hardRejectCheck(fileList, codeContext);
  if (hardCheck.rejected) {
    audit.log(audit.EVENT_TYPES.REPO_REJECTED, {
      repo: repoKey, reason: hardCheck.reason, score: 0
    });
    return {
      outcome: 'rejected',
      score: 0,
      reason: hardCheck.reason,
      rescuedPatterns: [],
      notification: `❌ Repo rejected: ${hardCheck.reason}. This appears to be firmware/hardware code with no transferable patterns for Pavi.`
    };
  }

  // Gate 2: Domain score
  const { score, hits, fileExtensions } = scoreRepo(fileList, codeContext, topicHint);

  // Gate 3: Universal pattern rescue (runs at every tier)
  const rescuedPatterns = extractUniversalPatterns(codeContext);

  if (score >= cfg.thresholds.full) {
    audit.log(audit.EVENT_TYPES.REPO_ACCEPTED, {
      repo: repoKey, score, hits: hits.slice(0, 10), rescuedPatterns
    });
    return {
      outcome: 'full',
      score,
      reason: `Domain score ${score.toFixed(2)} ≥ ${cfg.thresholds.full} (full ingest)`,
      rescuedPatterns,
      notification: `✅ Full ingest: domain relevance score ${(score * 100).toFixed(0)}%${rescuedPatterns.length ? `. Also rescued ${rescuedPatterns.length} universal patterns.` : ''}`
    };
  }

  if (score >= cfg.thresholds.partial) {
    audit.log(audit.EVENT_TYPES.REPO_PARTIAL, {
      repo: repoKey, score, rescuedPatterns
    });
    return {
      outcome: 'partial',
      score,
      reason: `Domain score ${score.toFixed(2)} (partial ingest — universal patterns only)`,
      rescuedPatterns,
      notification: `⚡ Partial ingest: domain score ${(score * 100).toFixed(0)}% (below threshold for full learning). Rescued ${rescuedPatterns.length} universal pattern(s): ${rescuedPatterns.join(', ') || 'none'}.`
    };
  }

  // Below threshold → quarantine
  quarantine(repoKey, score, `Score ${score.toFixed(2)} below ${cfg.thresholds.partial}`, fileExtensions);
  audit.log(audit.EVENT_TYPES.REPO_QUARANTINED, {
    repo: repoKey, score, rescuedPatterns
  });
  return {
    outcome: 'quarantine',
    score,
    reason: `Domain score ${score.toFixed(2)} < ${cfg.thresholds.partial} — quarantined for nightly rescore`,
    rescuedPatterns,
    notification: `🔶 Quarantined (score ${(score * 100).toFixed(0)}%): low domain relevance. Pavi will rescore this repo nightly as it learns more. ${rescuedPatterns.length ? `Rescued ${rescuedPatterns.length} universal pattern(s): ${rescuedPatterns.join(', ')}.` : 'No universal patterns found.'}`
  };
}

// ── Nightly Rescore ────────────────────────────────────────────────────────────
/**
 * Rescore all quarantined repos. Those crossing the threshold get
 * flagged for auto-ingest on next startup.
 * Returns list of repos that graduated out of quarantine.
 */
function rescoreQuarantine(domainProfile = '') {
  const cfg = loadConfig();
  const entries = loadQuarantine();
  const graduated = [];

  for (const entry of entries) {
    // Skip if rescored recently (within 20 hours)
    if (entry.rescoredAt) {
      const age = Date.now() - new Date(entry.rescoredAt).getTime();
      if (age < 20 * 60 * 60 * 1000) continue;
    }

    // Rescore using expanded domain profile
    const { score } = scoreRepo([], domainProfile + ' ' + entry.repoKey, '');
    entry.rescoredAt = new Date().toISOString();
    entry.rescoredScore = score;

    if (score >= cfg.thresholds.partial) {
      entry.graduated = true;
      graduated.push({ repoKey: entry.repoKey, oldScore: entry.score, newScore: score });
      audit.log(audit.EVENT_TYPES.REPO_RESCORED, {
        repo: entry.repoKey, oldScore: entry.score, newScore: score, graduated: true
      });
    }
  }

  saveQuarantine(entries);
  return graduated;
}

module.exports = { gate, scoreRepo, hardRejectCheck, extractUniversalPatterns, rescoreQuarantine, loadQuarantine };

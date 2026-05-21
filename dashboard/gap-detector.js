'use strict';
/**
 * gap-detector.js — Finds Capability Gaps Between What Pavi Knows
 *                   and What It Has Learned From Repos
 *
 * Runs after every ingestion batch.
 * Compares capability-index.json (what was found in repos)
 * against skills.json (what Pavi can currently invoke).
 *
 * If a significant intent has no matching skill → it's a GAP.
 * Gaps are written to skill-gaps.json and trigger skill-writer.js.
 */

const fs   = require('fs');
const path = require('path');
const audit = require('./audit-log');

const CAPABILITY_INDEX_PATH = path.join(__dirname, 'capability-index.json');
const SKILLS_PATH           = path.join(__dirname, 'skills.json');
const GAPS_PATH             = path.join(__dirname, 'skill-gaps.json');

// ── Intent → Skill Tag mapping ────────────────────────────────────────────────
// Maps capability intents (what we found) to skill tags (what Pavi uses).
// If an intent has no entry here, a new tag is auto-generated.
const INTENT_TO_SKILL = {
  'reduce-api-calls':       '$api-batching',
  'caching':                '$caching-strategy',
  'resilience':             '$retry-resilience',
  'fault-tolerance':        '$circuit-breaker',
  'worker-pool':            '$worker-pool',
  'concurrency-control':    '$concurrency-control',
  'async-queue':            '$async-queue',
  'streaming':              '$stream-processing',
  'semantic-memory':        '$semantic-memory',
  'probabilistic-filter':   '$bloom-filter',
  'cache-eviction':         '$lru-cache',
  'persistent-storage':     '$persistent-storage',
  'agent-orchestration':    '$agent-orchestration',
  'swarm-coordination':     '$swarm-coordination',
  'distributed-consensus':  '$distributed-consensus',
  'event-driven':           '$event-driven',
  'input-sanitization':     '$input-sanitization',
  'authentication':         '$authentication',
  'rate-limiting':          '$rate-limiting',
  'encryption':             '$encryption',
  'observability':          '$observability',
  'structured-logging':     '$structured-logging',
  'ml-inference':           '$ml-inference',
  'model-training':         '$model-training',
  'llm-preprocessing':      '$llm-preprocessing',
  'data-pipeline':      '$data-pipeline',
  'batch-processing':   '$batch-processing',
  'pagination':         '$cursor-pagination',
  'rest-api-design':    '$rest-api-design',
  'graphql-api':        '$graphql-api',
  'realtime-comms':     '$realtime-websockets',
  'webhook-pattern':    '$webhook-handler',
  'api-contract':       '$api-contract-openapi',
  'state-machine':      '$state-machine',
  'flux-pattern':       '$flux-state-management',
  'test-mocking':       '$test-mocking',
  'test-fixtures':      '$test-fixtures',
  'config-management':  '$config-env-management',
  'feature-flags':      '$feature-flags',
  'db-migration':       '$database-migrations',
  'containerization':   '$docker-containerization',
  'health-checks':      '$service-health-checks',
  'graceful-shutdown':  '$graceful-shutdown',
  'middleware-pattern': '$middleware-chain',
  'prompt-engineering': '$prompt-engineering',
  'context-management': '$llm-context-management',
  'llm-tool-calling':   '$llm-function-calling',
  'rag-pattern':        '$rag-retrieval-augmented',
  'agentic-loop':       '$agentic-loop-pattern',
};

// Minimum number of times an intent must appear before it's considered significant
const MIN_COUNT_THRESHOLD = 2;
// Minimum confidence for sources to be trusted
const MIN_CONFIDENCE = 0.75;

function loadCapabilityIndex() {
  try {
    if (fs.existsSync(CAPABILITY_INDEX_PATH)) return JSON.parse(fs.readFileSync(CAPABILITY_INDEX_PATH, 'utf8'));
  } catch (e) {}
  return {};
}

function loadSkills() {
  try {
    if (fs.existsSync(SKILLS_PATH)) return JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8'));
  } catch (e) {}
  return [];
}

function loadGaps() {
  try {
    if (fs.existsSync(GAPS_PATH)) return JSON.parse(fs.readFileSync(GAPS_PATH, 'utf8'));
  } catch (e) {}
  return [];
}

function saveGaps(gaps) {
  try {
    fs.writeFileSync(GAPS_PATH, JSON.stringify(gaps, null, 2), 'utf8');
  } catch (e) {}
}

/**
 * Run the gap detection cycle.
 *
 * @returns {{
 *   newGaps: Array<{intent, suggestedTag, sources, count}>,
 *   existingGaps: number,
 *   coveredIntents: string[]
 * }}
 */
function detect() {
  const capIndex = loadCapabilityIndex();
  const skills   = loadSkills();
  const existingGaps = loadGaps();

  // Build set of all skill tags Pavi already has
  const existingTags = new Set(skills.map(s => s.tag));

  // Track which intents are already covered by a skill
  const coveredIntents = [];
  const newGaps = [];

  for (const [intent, data] of Object.entries(capIndex)) {
    // Skip intents that are too infrequent or low-confidence
    if (data.count < MIN_COUNT_THRESHOLD) continue;
    const goodSources = (data.sources || []).filter(s => s.confidence >= MIN_CONFIDENCE);
    if (goodSources.length === 0) continue;

    // Map intent to the expected skill tag
    const suggestedTag = INTENT_TO_SKILL[intent] || `$${intent.replace(/[^a-z0-9]/g, '-')}`;

    if (existingTags.has(suggestedTag)) {
      coveredIntents.push(intent);
      continue;
    }

    // Check if this gap was already detected and is still pending
    const alreadyGapped = existingGaps.find(g => g.intent === intent && g.status !== 'discarded');
    if (alreadyGapped) continue;

    // New gap found!
    const gap = {
      id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      intent,
      suggestedTag,
      count: data.count,
      firstSeen: data.firstSeen,
      sources: goodSources.slice(0, 5).map(s => ({ key: s.key, repoKey: s.repoKey, confidence: s.confidence })),
      detectedAt: new Date().toISOString(),
      status: 'pending', // pending | staged | promoted | discarded
    };
    newGaps.push(gap);

    audit.log(audit.EVENT_TYPES.GAP_DETECTED, {
      intent,
      suggestedTag,
      count: data.count,
      sources: gap.sources.map(s => s.repoKey)
    });

    console.log(`[GAP_DETECTOR] 🔍 New capability gap: "${intent}" → "${suggestedTag}" (seen ${data.count}x, from ${gap.sources.length} repos)`);
  }

  if (newGaps.length === 0 && Object.keys(capIndex).length > 0) {
    console.log(`[GAP_DETECTOR] ✅ No new gaps — all significant intents are covered by existing skills.`);
  }

  // Save updated gaps list
  const allGaps = [...existingGaps, ...newGaps];
  saveGaps(allGaps);

  return { newGaps, existingGaps: existingGaps.length, coveredIntents };
}

/**
 * Mark a gap as staged (skill-writer is working on it).
 */
function markStaged(gapId) {
  const gaps = loadGaps();
  const gap = gaps.find(g => g.id === gapId);
  if (gap) { gap.status = 'staged'; saveGaps(gaps); }
}

/**
 * Mark a gap as promoted (skill is now live).
 */
function markPromoted(gapId) {
  const gaps = loadGaps();
  const gap = gaps.find(g => g.id === gapId);
  if (gap) { gap.status = 'promoted'; gap.promotedAt = new Date().toISOString(); saveGaps(gaps); }
}

/**
 * Mark a gap as discarded (user rejected the skill proposal).
 */
function markDiscarded(gapId) {
  const gaps = loadGaps();
  const gap = gaps.find(g => g.id === gapId);
  if (gap) { gap.status = 'discarded'; saveGaps(gaps); }
}

/**
 * Get all current gaps, optionally filtered by status.
 */
function getGaps(status = null) {
  const gaps = loadGaps();
  return status ? gaps.filter(g => g.status === status) : gaps;
}

module.exports = { detect, markStaged, markPromoted, markDiscarded, getGaps, INTENT_TO_SKILL };

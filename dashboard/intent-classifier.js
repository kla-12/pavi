'use strict';
/**
 * intent-classifier.js — Capability Intent Tagger
 *
 * Runs after skeleton extraction. Tags each skeleton string with
 * one or more "capability intents" — what the code is actually DOING
 * from a capability perspective.
 *
 * Rule-based first (zero API cost, runs in <1ms).
 * Designed to be swapped for an LLM pass later without changing the interface.
 *
 * Example:
 *   FN:batchRequests + FLOW:[async,await] → ["reduce-api-calls", "async-queue"]
 *   FN:circuitBreaker + FLOW:[try,catch]  → ["fault-tolerance", "resilience"]
 */

const fs   = require('fs');
const path = require('path');
const audit = require('./audit-log');

const CAPABILITY_INDEX_PATH = path.join(__dirname, 'capability-index.json');

// ── Intent Rules ──────────────────────────────────────────────────────────────
// Each rule: { patterns: string[], intent: string, weight: number }
// A skeleton matches a rule if ALL its patterns appear in the skeleton string.
const INTENT_RULES = [
  // API efficiency
  { patterns: ['batch', 'request'],              intent: 'reduce-api-calls',    weight: 0.9 },
  { patterns: ['debounce'],                      intent: 'reduce-api-calls',    weight: 0.85 },
  { patterns: ['throttle'],                      intent: 'reduce-api-calls',    weight: 0.85 },
  { patterns: ['cache', 'ttl'],                  intent: 'caching',             weight: 0.9 },
  { patterns: ['cache'],                         intent: 'caching',             weight: 0.75 },

  // Resilience
  { patterns: ['retry', 'backoff'],              intent: 'resilience',          weight: 0.95 },
  { patterns: ['retry'],                         intent: 'resilience',          weight: 0.80 },
  { patterns: ['circuit', 'breaker'],            intent: 'fault-tolerance',     weight: 0.95 },
  { patterns: ['fallback'],                      intent: 'fault-tolerance',     weight: 0.75 },
  { patterns: ['timeout', 'abort'],              intent: 'fault-tolerance',     weight: 0.80 },

  // Concurrency
  { patterns: ['queue', 'worker', 'pool'],       intent: 'worker-pool',         weight: 0.90 },
  { patterns: ['mutex', 'semaphore'],            intent: 'concurrency-control', weight: 0.90 },
  { patterns: ['lock', 'race'],                  intent: 'concurrency-control', weight: 0.80 },
  { patterns: ['async', 'await', 'queue'],       intent: 'async-queue',         weight: 0.85 },
  { patterns: ['stream', 'chunk'],               intent: 'streaming',           weight: 0.80 },

  // Memory & storage
  { patterns: ['embed', 'vector', 'search'],     intent: 'semantic-memory',     weight: 0.95 },
  { patterns: ['hnsw', 'index'],                 intent: 'semantic-memory',     weight: 0.95 },
  { patterns: ['bloom', 'filter'],               intent: 'probabilistic-filter', weight: 0.90 },
  { patterns: ['lru', 'evict'],                  intent: 'cache-eviction',      weight: 0.90 },
  { patterns: ['persist', 'disk', 'write'],      intent: 'persistent-storage',  weight: 0.75 },

  // Agent / orchestration
  { patterns: ['spawn', 'agent', 'task'],        intent: 'agent-orchestration', weight: 0.90 },
  { patterns: ['swarm', 'coordinator'],          intent: 'swarm-coordination',  weight: 0.90 },
  { patterns: ['consensus', 'vote'],             intent: 'distributed-consensus', weight: 0.90 },
  { patterns: ['event', 'emit', 'on'],           intent: 'event-driven',        weight: 0.80 },
  { patterns: ['pubsub', 'subscribe'],           intent: 'event-driven',        weight: 0.85 },

  // Security
  { patterns: ['sanitize', 'escape', 'inject'],  intent: 'input-sanitization',  weight: 0.90 },
  { patterns: ['auth', 'token', 'verify'],       intent: 'authentication',      weight: 0.85 },
  { patterns: ['rate', 'limit'],                 intent: 'rate-limiting',       weight: 0.85 },
  { patterns: ['encrypt', 'decrypt'],            intent: 'encryption',          weight: 0.90 },
  { patterns: ['hmac', 'sign'],                  intent: 'encryption',          weight: 0.90 },

  // Observability
  { patterns: ['metric', 'histogram'],           intent: 'observability',       weight: 0.85 },
  { patterns: ['trace', 'span'],                 intent: 'observability',       weight: 0.85 },
  { patterns: ['log', 'logger'],                 intent: 'structured-logging',  weight: 0.75 },

  // ML / inference
  { patterns: ['model', 'inference', 'predict'], intent: 'ml-inference',        weight: 0.90 },
  { patterns: ['fine', 'tune', 'train'],         intent: 'model-training',      weight: 0.90 },
  { patterns: ['token', 'chunk', 'embed'],       intent: 'llm-preprocessing',   weight: 0.85 },
  
  // Data pipelines
  { patterns: ['etl', 'transform'],              intent: 'data-pipeline',       weight: 0.90 },
  { patterns: ['pipeline', 'stage'],             intent: 'data-pipeline',       weight: 0.80 },
  { patterns: ['batch', 'process', 'chunk'],     intent: 'batch-processing',    weight: 0.85 },
  { patterns: ['paginate', 'cursor'],            intent: 'pagination',          weight: 0.85 },

  // API design
  { patterns: ['rest', 'endpoint', 'route'],     intent: 'rest-api-design',     weight: 0.80 },
  { patterns: ['graphql', 'resolver'],           intent: 'graphql-api',         weight: 0.90 },
  { patterns: ['websocket', 'ws', 'socket'],     intent: 'realtime-comms',      weight: 0.90 },
  { patterns: ['webhook', 'callback', 'notify'], intent: 'webhook-pattern',     weight: 0.85 },
  { patterns: ['openapi', 'swagger', 'schema'],  intent: 'api-contract',        weight: 0.85 },

  // State management
  { patterns: ['state', 'machine', 'transition'],intent: 'state-machine',      weight: 0.90 },
  { patterns: ['reducer', 'action', 'dispatch'], intent: 'flux-pattern',       weight: 0.85 },
  { patterns: ['saga', 'effect', 'yield'],       intent: 'saga-pattern',       weight: 0.90 },

  // Testing patterns
  { patterns: ['mock', 'stub', 'spy'],           intent: 'test-mocking',       weight: 0.85 },
  { patterns: ['fixture', 'factory', 'seed'],    intent: 'test-fixtures',      weight: 0.80 },
  { patterns: ['assertion', 'expect', 'test'],   intent: 'unit-testing',       weight: 0.75 },

  // Configuration
  { patterns: ['config', 'env', 'dotenv'],       intent: 'config-management',  weight: 0.75 },
  { patterns: ['feature', 'flag', 'toggle'],     intent: 'feature-flags',      weight: 0.85 },
  { patterns: ['migration', 'schema', 'version'],intent: 'db-migration',       weight: 0.85 },

  // Infrastructure
  { patterns: ['docker', 'container', 'image'],  intent: 'containerization',   weight: 0.90 },
  { patterns: ['health', 'check', 'ping'],       intent: 'health-checks',      weight: 0.80 },
  { patterns: ['graceful', 'shutdown', 'signal'],intent: 'graceful-shutdown',  weight: 0.85 },
  { patterns: ['middleware', 'intercept', 'hook'],intent: 'middleware-pattern',weight: 0.80 },

  // LLM-specific
  { patterns: ['prompt', 'template', 'format'],  intent: 'prompt-engineering', weight: 0.85 },
  { patterns: ['context', 'window', 'limit'],    intent: 'context-management', weight: 0.85 },
  { patterns: ['tool', 'function', 'call'],      intent: 'llm-tool-calling',   weight: 0.90 },
  { patterns: ['rag', 'retrieval', 'augmented'], intent: 'rag-pattern',        weight: 0.95 },
  { patterns: ['agent', 'loop', 'step'],         intent: 'agentic-loop',       weight: 0.90 },
];

const { capabilityIndexDB } = require('./db');

// ── Capability Index ───────────────────────────────────────────────────────────
function loadCapabilityIndex() {
  try {
    return capabilityIndexDB.get();
  } catch (e) { return {}; }
}

function saveCapabilityIndex(index) {
  try {
    capabilityIndexDB.save(index);
  } catch (e) {}
}

/**
 * Record an intent hit in the capability index.
 * @param {string} intent   - e.g. "reduce-api-calls"
 * @param {string} sourceKey - e.g. "$github-owner-repo-filename"
 * @param {string} repoKey   - e.g. "github.com/owner/repo"
 * @param {number} confidence
 */
function recordIntent(intent, sourceKey, repoKey, confidence) {
  const index = loadCapabilityIndex();
  if (!index[intent]) {
    index[intent] = { count: 0, sources: [], firstSeen: new Date().toISOString(), lastSeen: null };
  }
  index[intent].count++;
  index[intent].lastSeen = new Date().toISOString();
  // Keep last 10 sources
  if (!index[intent].sources.find(s => s.key === sourceKey)) {
    index[intent].sources.unshift({ key: sourceKey, repoKey, confidence, ts: Date.now() });
    if (index[intent].sources.length > 10) index[intent].sources.pop();
  }
  saveCapabilityIndex(index);
}

// ── Classifier ────────────────────────────────────────────────────────────────
/**
 * Classify a skeleton string into capability intents.
 *
 * @param {string} skeleton  - Compressed skeleton from SkeletonExtractor
 * @param {string} sourceKey - The AgentDB key for this pattern
 * @param {string} repoKey   - Source repo identifier
 *
 * @returns {Array<{ intent: string, confidence: number }>}
 */
function classify(skeleton, sourceKey = '', repoKey = '') {
  if (!skeleton || typeof skeleton !== 'string') return [];

  const lower = skeleton.toLowerCase();
  const matched = [];
  const seen = new Set();

  for (const rule of INTENT_RULES) {
    // All patterns in the rule must appear in the skeleton
    const allMatch = rule.patterns.every(p => lower.includes(p.toLowerCase()));
    if (allMatch && !seen.has(rule.intent)) {
      seen.add(rule.intent);
      matched.push({ intent: rule.intent, confidence: rule.weight });

      // Record in global capability index
      if (sourceKey) recordIntent(rule.intent, sourceKey, repoKey, rule.weight);
    }
  }

  if (matched.length > 0) {
    audit.log(audit.EVENT_TYPES.INTENTS_TAGGED, {
      repo: repoKey, key: sourceKey,
      intents: matched.map(m => m.intent),
    });
  }

  return matched;
}

/**
 * Classify a batch of skeletons from a single ingestion.
 * Returns a summary of all unique intents found.
 *
 * @param {Array<{key: string, skeleton: string}>} skeletons
 * @param {string} repoKey
 * @returns {{ allIntents: string[], byKey: object }}
 */
function classifyBatch(skeletons, repoKey = '') {
  const byKey = {};
  const intentSet = new Set();

  for (const { key, skeleton } of skeletons) {
    const results = classify(skeleton, key, repoKey);
    if (results.length > 0) {
      byKey[key] = results;
      results.forEach(r => intentSet.add(r.intent));
    }
  }

  return { allIntents: [...intentSet], byKey };
}

/**
 * Get the full capability index (all known intents).
 */
function getCapabilityIndex() {
  return loadCapabilityIndex();
}

module.exports = { classify, classifyBatch, getCapabilityIndex, recordIntent, INTENT_RULES };

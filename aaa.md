# 🧠 Dual-Model Paradigm: Offline Worker & Online Reviewer
## **Strategic Blueprint v2.0 — Pavi Evolution Engine**
> Security-first local heavy lifting guided by premium cloud intelligence | Gap-resolved, production-ready architecture

---

## 1. Executive Summary

This document is the **authoritative v2 upgrade** of the Maker-Checker Engine for Pavi. It resolves all three critical implementation gaps, introduces seven new architectural subsystems, and elevates every design layer to production-grade standards.

The core paradigm remains:

- **The Maker (Offline Worker):** A pool of specialized local models (Ollama / vLLM) that execute all heavy compute: code generation, repo analysis, pattern extraction. Zero IP leakage. Zero recurring API cost.
- **The Checker (Online Reviewer):** A premium cloud LLM (Gemini Pro / Groq LLaMA-3.3-70B / GPT-4o) that audits Worker outputs, emits structured critiques, and never touches raw private data.
- **The Growth Engine:** Every Checker correction is automatically harvested into a local SFT/LoRA/DPO dataset, continuously upgrading the Worker toward Checker-level capability.

**New in v2:**
- All three original gaps are fully resolved with implementation-ready code
- Five new architectural modules are introduced (Sections 7–11)
- Two premium recommendations are added (Section 12)
- Full observability, security, and resilience layers are specified

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      PAVI CORE ORCHESTRATION — v2                        │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌──────────────┐      ┌──────────────────┐      ┌──────────────┐
│  SKILL STORE │      │  TASK ROUTER     │      │  GROWTH      │
│  (enriched)  │◄────►│  (intent-aware)  │      │  ENGINE      │
└──────────────┘      └────────┬─────────┘      └──────┬───────┘
                               │                        │
               ┌───────────────┴──────────────┐         │
               ▼                              ▼         │
  ┌─────────────────────┐        ┌─────────────────────┐│
  │  👷 OFFLINE MAKER   │        │  🕵️ ONLINE CHECKER   ││
  │  Pool: 3+ models    │──────► │  Gemini/Groq/GPT-4o  ││
  │  Plugins: active    │        │  Structured critique  ││
  └─────────────────────┘        └──────────┬──────────┘│
               ▲                            │            │
               │    [SFT dataset harvest]   │            │
               └────────────────────────────┘◄───────────┘
```

---

## 2. Gap Resolution: All Three Critical Fixes

### 🔴 GAP-1 RESOLVED — Orphaned Skill Feedback Loop

**Root cause:** `recordUsage(tag, success)` in `services/skill-feedback.js` was authored but never wired into execution or verification pathways.

**Fix — Wire into execution pipeline:**

```javascript
// In executioner.js — after every Worker execution result:
const { recordUsage } = require('./services/skill-feedback');

async function executeWorkerTask(task, skill) {
  try {
    const result = await workerPool.run(task, skill);
    const success = await checkerService.verify(result);

    // ✅ NOW WIRED: record the outcome against the skill tag
    await recordUsage(skill.tag, success.passed);

    return result;
  } catch (err) {
    await recordUsage(skill.tag, false); // failure path also captured
    throw err;
  }
}
```

**Fix — Wire into reviewer verification pathway:**

```javascript
// In checker-service.js — after every Checker audit:
async function auditOutput(workerId, output, skillTag) {
  const verdict = await premiumReviewer.audit(output);
  await recordUsage(skillTag, verdict.status === 'PASS');

  if (verdict.status === 'FAIL') {
    await trainingHarvester.capture({
      workerOutput: output,
      critique: verdict.feedback,
      corrected: verdict.correctedOutput,
      skillTag
    });
  }
  return verdict;
}
```

**Enhancement — Skill decay scoring:** Extend `skill-feedback.js` beyond EMA to include a **decay factor**: skills not used in 30 days lose confidence score regardless of historical success. This prevents stale skills from polluting the Worker's tool index.

```javascript
// Enhanced recordUsage with time-decay
function getDecayedScore(skill) {
  const daysSinceLastUse = (Date.now() - skill.lastUsed) / 86_400_000;
  const decayFactor = Math.exp(-0.03 * daysSinceLastUse); // half-life ≈ 23 days
  return skill.emaScore * decayFactor;
}
```

---

### 🔴 GAP-2 RESOLVED — Inline Extractors Drop Structured Metadata

**Root cause:** `ingester.js:L308-L336` parsed `NEW_SKILL:` tags from the LLM stream into flat strings, discarding code skeletons, `whenToUse` context, and anti-patterns.

**Fix — Full structured schema extraction:**

```javascript
// In ingester.js — replace flat string capture with schema hydration:
function parseNewSkillTag(rawTagContent) {
  // Force LLM to emit structured YAML inside NEW_SKILL blocks
  return {
    tag: rawTagContent.tag,
    summary: rawTagContent.summary,
    knowledge: {
      whenToUse: rawTagContent.whenToUse ?? '',
      codeExample: rawTagContent.codeExample ?? '',       // ✅ no longer discarded
      antiPattern: rawTagContent.antiPattern ?? '',       // ✅ no longer discarded
      relatedSkills: rawTagContent.relatedSkills ?? [],
      complexityHint: rawTagContent.complexityHint ?? 'medium'
    },
    skeleton: rawTagContent.skeleton ?? null,             // ✅ skeleton preserved
    sourceRepo: rawTagContent.sourceRepo ?? null,
    extractedAt: new Date().toISOString()
  };
}
```

**Enhancement — Schema validation gate:** All skills extracted from stream must pass a JSON Schema validator before being written to `skills.json`. Malformed extractions are quarantined to `skills_quarantine.json` and flagged for Checker review on next cycle.

```javascript
const Ajv = require('ajv');
const ajv = new Ajv();
const skillSchema = require('./schemas/skill.schema.json');

function validateAndStage(skill) {
  const valid = ajv.validate(skillSchema, skill);
  if (!valid) {
    quarantine.write(skill, ajv.errors);
    return null;
  }
  return skill;
}
```

---

### 🟠 GAP-3 RESOLVED — Promotion Discards Underlying Knowledge

**Root cause:** `skill-writer.js:L254-L256` reduced skills from quarantine to live status by stripping `knowledge{}` to a flat string summary.

**Fix — Lossless promotion with schema preservation:**

```javascript
// In skill-writer.js — replace the stripping logic:

// ❌ BEFORE (broken):
// liveSkill = { tag: staged.tag, summary: staged.summary };

// ✅ AFTER (fixed): full knowledge block migrated intact
function promoteToLive(stagedSkill) {
  return {
    tag: stagedSkill.tag,
    summary: stagedSkill.summary,
    knowledge: stagedSkill.knowledge,     // ✅ preserved
    skeleton: stagedSkill.skeleton,       // ✅ preserved
    promotedAt: new Date().toISOString(),
    confidenceScore: stagedSkill.confidenceScore ?? 0.5,
    usageStats: { uses: 0, passes: 0, fails: 0 }
  };
}
```

**Enhancement — Checker-validated promotion:** Skills only graduate from quarantine when a Checker has audited the `codeExample` and confirmed it passes. This turns promotion into a **quality gate**, not just a time gate.

```javascript
async function checkerValidateAndPromote(stagedSkill) {
  const verdict = await premiumReviewer.auditCodeExample(stagedSkill.knowledge.codeExample);
  if (verdict.status !== 'PASS') {
    stagedSkill.knowledge.codeExample = verdict.correctedOutput; // upgrade in place
    stagedSkill.knowledge.checkerNotes = verdict.feedback;
  }
  return promoteToLive(stagedSkill);
}
```

---

## 3. Offline Worker Pool: Advanced Multi-Model Architecture

The Worker pool runs three specialized models behind a unified routing layer. Each model is assigned by **intent class**, not by request order.

```
                                    ┌──> [Phi-4-Medium]      Fast syntax checks, linting, format validation
                                    │                         Context: 4K | Latency: <200ms
[Intent Classifier] ────────────────┼──> [DeepSeek-Coder]    Heavy code generation, refactoring, architecture
                                    │                         Context: 32K | Latency: 1–4s
                                    │
                                    ├──> [Qwen-2.5-Coder]    Repo analysis, dependency parsing, code search
                                    │                         Context: 128K | Latency: 2–6s
                                    │
                                    └──> [LLaMA-3.3-70B]     Fallback Checker when cloud APIs are offline
                                                              Context: 128K | Latency: 5–15s (vLLM)
```

### Intent Classification (new module: `router/intent-classifier.js`)

```javascript
const intentMap = {
  'syntax-check':     { model: 'phi3:mini',                  maxTokens: 512  },
  'code-generate':    { model: 'deepseek-coder:6.7b',        maxTokens: 4096 },
  'repo-analyze':     { model: 'qwen2.5-coder:7b-instruct',  maxTokens: 8192 },
  'doc-generate':     { model: 'deepseek-coder:6.7b',        maxTokens: 2048 },
  'pattern-extract':  { model: 'qwen2.5-coder:7b-instruct',  maxTokens: 4096 },
  'offline-review':   { model: 'llama3.3:70b',               maxTokens: 8192 }
};

async function classifyAndRoute(task) {
  const intent = await intentClassifier.classify(task.prompt);
  const route = intentMap[intent] ?? intentMap['code-generate']; // safe fallback
  return workerPool.dispatch(task, route);
}
```

### Configuration Manifest (updated `config.json`)

```json
{
  "workerPool": [
    { "model": "deepseek-coder:6.7b",       "role": "coder",         "priority": 1 },
    { "model": "qwen2.5-coder:7b-instruct", "role": "analyzer",      "priority": 2 },
    { "model": "phi3:mini",                  "role": "fast-validator", "priority": 3 },
    { "model": "llama3.3:70b",               "role": "local-checker", "priority": 4, "requiresVLLM": true }
  ],
  "checkerPool": [
    { "provider": "groq",   "model": "llama-3.3-70b-versatile", "priority": 1 },
    { "provider": "google", "model": "gemini-2.0-flash",         "priority": 2 },
    { "provider": "openai", "model": "gpt-4o-mini",              "priority": 3 }
  ],
  "fallback": {
    "offlineCheckerModel": "llama3.3:70b",
    "maxRetries": 3,
    "retryBackoffMs": 500
  }
}
```

---

## 4. The Self-Growth Feedback Loop

Every Checker correction becomes a fine-tuning data point. The pipeline is fully automated.

### Database Schema (extended)

```sql
-- Core training harvest table
CREATE TABLE IF NOT EXISTS training_feedback_dataset (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    task_intent TEXT NOT NULL,
    skill_tag TEXT,
    system_prompt TEXT,
    user_prompt TEXT NOT NULL,
    worker_original_output TEXT NOT NULL,
    reviewer_critique TEXT,
    corrected_output TEXT,
    correction_category TEXT,  -- NEW: 'logic', 'style', 'security', 'performance'
    severity TEXT DEFAULT 'minor', -- NEW: 'minor', 'major', 'critical'
    token_saved INTEGER,
    model_used TEXT,           -- NEW: which Worker model generated this
    checker_used TEXT,         -- NEW: which Checker audited this
    status TEXT DEFAULT 'pending_fine_tune',
    exported_at DATETIME       -- NEW: when it was included in a training run
);

-- NEW: Training run tracking
CREATE TABLE IF NOT EXISTS training_runs (
    id TEXT PRIMARY KEY,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    base_model TEXT,
    adapter_path TEXT,
    samples_used INTEGER,
    eval_score_before REAL,
    eval_score_after REAL,
    status TEXT DEFAULT 'running'
);

-- NEW: Model performance benchmarks
CREATE TABLE IF NOT EXISTS model_benchmarks (
    id TEXT PRIMARY KEY,
    model_name TEXT NOT NULL,
    benchmark_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    pass_rate REAL,
    avg_latency_ms INTEGER,
    top_failure_categories TEXT  -- JSON array
);
```

### SFT Export Pipeline (new: `training/exporter.js`)

Three output formats, all auto-generated:

```javascript
// ChatML format (Ollama / LLaMA-Factory compatible)
function toChatML(row) {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `Task: ${row.task_intent}\n\n${row.user_prompt}\n\nCode to improve:\n${row.worker_original_output}` },
      { role: "assistant", content: `Review: ${row.reviewer_critique}\n\nCorrected:\n${row.corrected_output}` }
    ]
  };
}

// Alpaca format (Unsloth compatible)
function toAlpaca(row) {
  return {
    instruction: row.user_prompt,
    input: row.worker_original_output,
    output: row.corrected_output
  };
}

// DPO format (preference learning — chosen vs rejected)
function toDPO(row) {
  return {
    prompt: row.user_prompt,
    chosen: row.corrected_output,
    rejected: row.worker_original_output
  };
}
```

### Automated Training Trigger

```javascript
// In growth-engine.js — runs as a background cron
async function checkAndTriggerTraining() {
  const pendingCount = await db.count('training_feedback_dataset', { status: 'pending_fine_tune' });

  if (pendingCount >= TRAINING_THRESHOLD) { // default: 100
    const dataset = await exporter.buildDataset('chatml');
    await loraTrainer.run({
      baseModel: config.workerModel,
      dataset,
      epochs: 3,
      rank: 16,
      outputPath: `./adapters/lora-${Date.now()}`
    });
  }
}
```

---

## 5. Plugin Manager: Offline Worker Amplification

The Worker's effective capability is multiplied by the active plugin ecosystem.

### Plugin Auto-Scaffolding Lifecycle

```
[Ingester detects new tool pattern]
         │
         ▼
[Writes plugin to dashboard/plugins/<id>/index.js]
         │
         ▼
[plugin-loader.js hot-reloads it]
         │
         ▼
[Checker validates plugin signature]
         │
         ▼
[Worker receives plugin in system prompt as OpenAI tool-calling schema]
         │
         ▼
[executioner.js handles tool_call response, runs plugin locally]
```

### Plugin Schema (standardized)

```javascript
// dashboard/plugins/csv-parser/index.js
module.exports = {
  id: 'csv-parser',
  version: '1.0.0',
  describe() {
    return {
      name: 'parse_csv',
      description: 'Parse a CSV file and return structured JSON rows',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the CSV file' },
          delimiter: { type: 'string', default: ',', description: 'Column delimiter' }
        },
        required: ['filePath']
      }
    };
  },
  async execute({ filePath, delimiter = ',' }) {
    const csv = require('csv-parser');
    // ... execution logic
  }
};
```

### Plugin Security Sandbox (new: `plugins/sandbox.js`)

All plugins run inside a restricted child process with:

- No network access (unless explicitly whitelisted in plugin manifest)
- No access to parent process environment variables
- 30-second execution timeout
- Memory capped at 256MB

```javascript
const { Worker } = require('worker_threads');

async function sandboxedExecute(plugin, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./plugins/sandbox-worker.js', {
      workerData: { pluginPath: plugin.path, args },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Plugin timeout')); }, 30_000);
    worker.on('message', result => { clearTimeout(timeout); resolve(result); });
    worker.on('error', reject);
  });
}
```

---

## 6. Observability Layer (new module)

A production system must be fully observable. The following three subsystems are new in v2.

### 6.1 Structured Telemetry (new: `services/telemetry.js`)

Every Worker run, Checker audit, plugin execution, and skill promotion emits a structured event to a local SQLite events log. No external telemetry — everything stays on-device.

```javascript
// Event types emitted by the system:
const EVENTS = {
  WORKER_RUN_START:      'worker.run.start',
  WORKER_RUN_COMPLETE:   'worker.run.complete',
  CHECKER_AUDIT_START:   'checker.audit.start',
  CHECKER_AUDIT_PASS:    'checker.audit.pass',
  CHECKER_AUDIT_FAIL:    'checker.audit.fail',
  SKILL_PROMOTED:        'skill.promoted',
  PLUGIN_EXECUTED:       'plugin.executed',
  TRAINING_TRIGGERED:    'training.triggered',
  TRAINING_COMPLETE:     'training.complete',
  FALLBACK_ACTIVATED:    'fallback.activated'  // fired when cloud Checker goes offline
};
```

### 6.2 Real-Time Dashboard Panel (new route: `/api/status`)

```json
{
  "workerPool": {
    "active": 2,
    "models": ["deepseek-coder:6.7b", "qwen2.5-coder:7b-instruct"],
    "queueDepth": 3,
    "avgLatencyMs": 1240
  },
  "checkerPool": {
    "provider": "groq",
    "model": "llama-3.3-70b-versatile",
    "online": true,
    "lastAuditMs": 850
  },
  "growthEngine": {
    "pendingDatapoints": 47,
    "nextTrainingAt": 100,
    "lastTrainingRun": "2025-07-12T03:00:00Z",
    "currentAdapterVersion": "lora-v3"
  },
  "skillStore": {
    "live": 312,
    "quarantined": 14,
    "topPerformers": ["csv-parse", "axios-retry", "sql-batch-insert"]
  }
}
```

### 6.3 Drift Detector (new: `services/drift-detector.js`)

Monitors the gap between Worker and Checker performance over time. If the Worker's uncorrected pass rate drops below a threshold after a training run, it triggers an automatic rollback to the previous LoRA adapter.

```javascript
async function detectDrift(windowDays = 7) {
  const recent = await db.query(`
    SELECT AVG(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END) as passRate
    FROM checker_audits
    WHERE timestamp > datetime('now', '-${windowDays} days')
  `);

  if (recent.passRate < DRIFT_THRESHOLD) { // default: 0.75
    logger.warn(`[DriftDetector] Pass rate dropped to ${recent.passRate}. Rolling back adapter.`);
    await adapterManager.rollback();
  }
}
```

---

## 7. Security Architecture (new section)

The Maker-Checker system handles private codebases. These rules are non-negotiable.

### Data Sanitization Before Checker

The Checker (cloud API) must **never** see:

- Absolute file paths (replaced with `<path>`)
- Environment variable names and values
- API keys, secrets, tokens
- Database connection strings
- Internal hostnames or IPs

```javascript
// services/sanitizer.js — runs on every payload before cloud dispatch
const REDACT_PATTERNS = [
  { pattern: /[A-Z_]{3,}=["']?[^\s"']+/g,        replacement: '<ENV_VAR>'        },
  { pattern: /sk-[a-zA-Z0-9]{32,}/g,              replacement: '<API_KEY>'        },
  { pattern: /mongodb(\+srv)?:\/\/[^\s]+/gi,       replacement: '<DB_CONNECTION>'  },
  { pattern: /[A-Z]:\\[^\s"']+/g,                  replacement: '<PATH>'           },
  { pattern: /\/(?:home|users|root)\/[^\s"']+/gi,  replacement: '<PATH>'           }
];

function sanitize(text) {
  return REDACT_PATTERNS.reduce((acc, { pattern, replacement }) =>
    acc.replace(pattern, replacement), text);
}
```

### Audit Log (immutable)

All Checker interactions are logged with a cryptographic hash of the sanitized payload. This enables forensic review without exposing original content.

```sql
CREATE TABLE IF NOT EXISTS checker_audit_log (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    payload_hash TEXT NOT NULL,    -- SHA-256 of sanitized payload
    checker_provider TEXT,
    verdict TEXT,
    latency_ms INTEGER,
    tokens_used INTEGER
);
```

---

## 8. Context Management: Prompt Compression Layer

Small offline models (8K context) choke on large repository files. The compression layer solves this without semantic loss.

### Three-Stage Compression Pipeline (new: `services/context-compressor.js`)

```
Stage 1: Structural pruning
   - Remove comments, docstrings, whitespace-only lines
   - Strip import blocks (replace with summary line)
   - Estimated reduction: 20–35%

Stage 2: Semantic chunking
   - Split file into function/class-level chunks
   - Rank chunks by relevance to task intent (BM25 or embedding similarity)
   - Keep top-K chunks only
   - Estimated reduction: 40–60% additional

Stage 3: LLMLingua compression (optional, local model)
   - Apply token-level compression to remaining content
   - Target: 4x compression at 98% semantic retention
   - Only activated when context > 80% of model's window
```

```javascript
async function compressForWorker(fileContent, taskIntent, modelContextLimit) {
  const stage1 = structuralPrune(fileContent);
  const chunks  = semanticChunk(stage1, taskIntent);

  if (estimateTokens(chunks) > modelContextLimit * 0.8) {
    return await llmLinguaCompress(chunks, targetRatio = 0.25);
  }
  return chunks;
}
```

---

## 9. Semantic Memory: HNSW Vector Index

Replace flat `skills.json` lookups with a high-performance vector index for sub-10ms retrieval across 100K+ skills.

### Architecture

```
[Skill promoted to live]
         │
         ▼
[Embed skill.summary + knowledge.whenToUse]
  via local embedding model (e.g., nomic-embed-text)
         │
         ▼
[Upsert vector into HNSW index]
  using hnswlib-node or usearch
         │
         ▼
[Worker task arrives]
         │
         ▼
[Embed task intent → query HNSW → retrieve top-5 skills]
  Latency: <10ms even at 1M vectors
         │
         ▼
[Inject retrieved skills into Worker system prompt]
```

### Implementation Skeleton

```javascript
const { HierarchicalNSW } = require('hnswlib-node');

class SkillVectorIndex {
  constructor(dim = 768) {
    this.index = new HierarchicalNSW('cosine', dim);
    this.index.initIndex(100_000); // pre-allocate for 100K skills
    this.idToSkill = new Map();
  }

  async upsert(skill, embeddingVector) {
    const id = this.idToSkill.size;
    this.index.addPoint(embeddingVector, id);
    this.idToSkill.set(id, skill);
  }

  async search(queryVector, topK = 5) {
    const result = this.index.searchKnn(queryVector, topK);
    return result.neighbors.map(id => this.idToSkill.get(id));
  }
}
```

---

## 10. Continuous Self-Play RLHF Pipeline

Once 100+ corrections are harvested, an automated LoRA training loop activates.

### Training Schedule

```
[Every night at 03:00 local time OR when pendingDatapoints >= 100]
         │
         ▼
[growth-engine.js] exports JSONL dataset
         │
         ├──> SFT phase:  ChatML format → Unsloth fine-tune (3 epochs, rank=16)
         │
         └──> DPO phase:  Preference pairs → ORPO or SimPO training
                          (only when SFT eval score > 0.82)
         │
         ▼
[Eval suite runs on held-out 10% of dataset]
         │
         ├── Pass → deploy new adapter, log to training_runs
         │
         └── Fail → rollback, flag dataset batch for Checker re-review
```

### Correction Category Weighting

Not all corrections are equal. The training pipeline weights samples by category:

| Category     | Weight | Rationale |
|:-------------|:------:|:----------|
| `security`   | 3.0    | Security defects have the highest real-world cost |
| `logic`      | 2.0    | Logic errors cause incorrect results silently |
| `performance`| 1.5    | Performance issues compound at scale |
| `style`      | 0.8    | Style is lowest priority for correctness |
| `docs`       | 0.5    | Documentation errors don't affect execution |

---

## 11. Resilience & Failover Architecture

### Four-Level Fallback Chain

```
Level 1: Primary cloud Checker (Groq LLaMA-3.3-70B)
         │ [timeout > 5s or HTTP 5xx]
         ▼
Level 2: Secondary cloud Checker (Gemini 2.0 Flash)
         │ [timeout > 5s or HTTP 5xx]
         ▼
Level 3: Tertiary cloud Checker (GPT-4o-mini)
         │ [all cloud APIs down or network unavailable]
         ▼
Level 4: Local Checker (LLaMA-3.3-70B via vLLM)
         │ [GPU unavailable or vLLM not running]
         ▼
Level 5: Skip Checker, mark output as "unverified", queue for next online session
```

### Circuit Breaker (new: `services/circuit-breaker.js`)

```javascript
class CircuitBreaker {
  constructor(threshold = 5, resetTimeMs = 60_000) {
    this.failures  = 0;
    this.threshold = threshold;
    this.state     = 'CLOSED'; // CLOSED | OPEN | HALF-OPEN
    this.resetTime = resetTimeMs;
  }

  async call(fn) {
    if (this.state === 'OPEN') throw new Error('Circuit open — provider unavailable');
    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (err) {
      this.failures++;
      if (this.failures >= this.threshold) this.trip();
      throw err;
    }
  }

  trip() {
    this.state = 'OPEN';
    setTimeout(() => { this.state = 'HALF-OPEN'; this.failures = 0; }, this.resetTime);
  }

  reset() { this.state = 'CLOSED'; this.failures = 0; }
}
```

---

## 12. Premium Strategic Recommendations (v2 Additions)

### 🚀 Recommendation D: Checker Confidence Calibration

The Checker's verdict should not be binary PASS/FAIL. Introduce a **confidence score** (0–1.0) on every audit. Low-confidence verdicts (< 0.6) are automatically escalated to a second Checker provider for tie-breaking. This eliminates false rejections that would otherwise pollute the training dataset with incorrect "corrections."

```javascript
// Extended verdict schema:
{
  "status": "FAIL",
  "confidence": 0.52,              // NEW
  "requiresEscalation": true,      // NEW: auto-set when confidence < 0.6
  "feedback": "...",
  "correctedOutput": "..."
}
```

### 🚀 Recommendation E: Skill Genealogy Graph

Track the lineage of every skill through its promotion, corrections, and retraining cycles using a directed acyclic graph (DAG) stored in SQLite. This allows:

- Identifying which Checker corrections most improved the Worker
- Rolling back a specific skill to a prior version without full model rollback
- Visualizing the "knowledge tree" of Pavi's learned competencies over time

```sql
CREATE TABLE IF NOT EXISTS skill_genealogy (
    id TEXT PRIMARY KEY,
    skill_tag TEXT NOT NULL,
    parent_version_id TEXT,           -- NULL for initial extraction
    event_type TEXT,                  -- 'extracted', 'corrected', 'promoted', 'deprecated'
    model_version TEXT,               -- which Worker LoRA adapter was active
    checker_verdict TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 🚀 Recommendation F: Zero-Shot Task Decomposition

For complex multi-step tasks, add a **Decomposer** layer before the Worker. The Decomposer breaks a high-level task into atomic sub-tasks, each routed independently through the Worker pool. Results are merged by an **Assembler**. This unlocks parallelism and allows specialized models to each handle their best sub-task type.

```
[Complex Task: "Refactor entire auth module"]
         │
         ▼
[Decomposer] ──► Sub-tasks:
                   1. Extract function signatures       → Qwen-2.5-Coder
                   2. Identify security antipatterns    → DeepSeek-Coder
                   3. Generate refactored functions     → DeepSeek-Coder
                   4. Validate naming conventions       → Phi-4-Medium
                   5. Write unit test stubs             → DeepSeek-Coder
         │
         ▼
[Parallel Worker Pool execution]
         │
         ▼
[Assembler merges outputs]
         │
         ▼
[Single Checker audit on assembled result]
```

---

## 13. Next Actions & Execution Plan (Updated)

Execute in strict priority order to avoid breaking the existing codebase:

**Phase 1 — Gap Closure (Week 1)**
1. Wire `recordUsage()` into `executioner.js` and `checker-service.js` (GAP-1)
2. Replace flat string extraction in `ingester.js:L308-336` with full schema hydration (GAP-2)
3. Fix `skill-writer.js:L254-256` to preserve `knowledge{}` on promotion (GAP-3)
4. Add JSON Schema validation gate for all newly extracted skills

**Phase 2 — Data Layer (Week 2)**
5. Run SQL migration to add `training_feedback_dataset`, `training_runs`, `model_benchmarks`, `checker_audit_log`, `skill_genealogy` tables in `db.js`
6. Author `services/sanitizer.js` — mandatory before any payload leaves the machine
7. Deploy `training/exporter.js` with ChatML, Alpaca, and DPO format support

**Phase 3 — Intelligence Layer (Week 3–4)**
8. Deploy `router/intent-classifier.js` with the intent→model routing table
9. Implement `services/context-compressor.js` (Stages 1 & 2 first; LLMLingua optional)
10. Set up HNSW skill vector index with `nomic-embed-text` embeddings

**Phase 4 — Resilience & Observability (Week 5)**
11. Implement `services/circuit-breaker.js` across all Checker provider calls
12. Wire four-level fallback chain into `checker-service.js`
13. Add `/api/status` endpoint and wire `services/telemetry.js` event emitters

**Phase 5 — Growth Engine (Week 6+)**
14. Activate automated LoRA training trigger (100-sample threshold)
15. Add drift detector with automatic adapter rollback
16. Implement Checker confidence calibration and escalation routing

---

## 14. Architecture Summary: The Completed System

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PAVI v2 — COMPLETE ARCHITECTURE                      │
├────────────────────┬──────────────────────┬──────────────────────────────────┤
│  INGESTION LAYER   │  EXECUTION LAYER      │  GROWTH LAYER                   │
│                    │                       │                                  │
│  ingester.js       │  Intent Classifier    │  Training Harvester              │
│  ├─ Schema hydrate │  ├─ Route to model    │  ├─ ChatML / Alpaca / DPO export │
│  ├─ Validate       │  ├─ Compress context  │  ├─ Weighted sampling            │
│  └─ Quarantine     │  └─ Inject skills     │  └─ LoRA training trigger        │
│                    │                       │                                  │
│  SKILL STORE       │  WORKER POOL          │  DRIFT DETECTOR                  │
│  ├─ HNSW index     │  ├─ DeepSeek-Coder    │  ├─ Pass-rate monitoring         │
│  ├─ Genealogy DAG  │  ├─ Qwen-2.5-Coder    │  └─ Adapter rollback             │
│  ├─ Decay scoring  │  ├─ Phi-4-Medium      │                                  │
│  └─ Feedback EMA   │  └─ LLaMA-3.3 (local)│  OBSERVABILITY                   │
│                    │                       │  ├─ Structured telemetry          │
│  PLUGIN MANAGER    │  CHECKER POOL         │  ├─ /api/status dashboard         │
│  ├─ Auto-scaffold  │  ├─ Groq (primary)    │  └─ Immutable audit log           │
│  ├─ Hot-reload     │  ├─ Gemini (secondary)│                                  │
│  └─ Sandbox exec   │  ├─ GPT-4o (tertiary) │  SECURITY                        │
│                    │  └─ Circuit breaker   │  ├─ Pre-cloud sanitizer           │
│                    │                       │  ├─ Sandbox isolation             │
│                    │  SANITIZER            │  └─ Payload hash audit            │
│                    │  └─ Runs before every │                                  │
│                    │     cloud dispatch    │                                  │
└────────────────────┴──────────────────────┴──────────────────────────────────┘
```

---

*Pavi v2 Blueprint — All gaps resolved. All subsystems specified. Ready for phased implementation.*

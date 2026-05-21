# Phase B — Self-Improving Agent Mesh
## Pavi Platform | Implementation Guide for AI Agents

> **Goal:** After every swarm execution, a Reviewer agent scores the output quality (0–100).
> Low-scoring runs are automatically re-prompted. Over time, Pavi learns which agent
> topologies produce the best results for which categories of prompts.
>
> **Estimated Effort:** 2–3 days
> **Architecture Rating Impact:** 82 → 90 / 100

---

## Context & Current State

Read these files before making any changes:

| File | Why |
|------|-----|
| `dashboard/swarm-orchestrator.js` | Where `spawnSwarm()` lives — this is the main integration point |
| `dashboard/db.js` | Contains `swarmRunsDB` — the SQLite wrapper for the `swarm_runs` table |
| `dashboard/local-bot.js` | The Ollama LLM call wrapper (`localBot.call(prompt, role, system, maxTokens)`) |
| `dashboard/pattern-memory.js` | Vector memory store — used to persist topology → quality mappings |
| `dashboard/routes/history.js` | REST API for swarm history — add quality score endpoints here |
| `dashboard/index.html` | Dashboard UI — add quality score column to history table |
| `dashboard/app.js` | Frontend JS — update `loadSwarmHistory()` to show scores |

---

## Step 1 — Extend the `swarm_runs` SQLite Table

**File:** `dashboard/db.js`

### 1a. Add new columns to the `swarm_runs` CREATE TABLE statement

Find this block (around line 156):
```sql
CREATE TABLE IF NOT EXISTS swarm_runs (
  id TEXT PRIMARY KEY,
  prompt TEXT,
  agents_used TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  result_summary TEXT,
  files_changed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running'
);
```

Replace with:
```sql
CREATE TABLE IF NOT EXISTS swarm_runs (
  id TEXT PRIMARY KEY,
  prompt TEXT,
  agents_used TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  result_summary TEXT,
  files_changed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  quality_score INTEGER DEFAULT NULL,
  quality_feedback TEXT DEFAULT NULL,
  retry_count INTEGER DEFAULT 0,
  prompt_category TEXT DEFAULT NULL,
  topology_used TEXT DEFAULT 'hierarchical'
);
```

### 1b. Add a migration for existing databases

After the `CREATE TABLE` block in `db.js`, add these migration statements so existing installs get the new columns without errors:

```javascript
// Phase B migration — add quality columns if they don't exist
const existingCols = db.prepare("PRAGMA table_info(swarm_runs)").all().map(c => c.name);
if (!existingCols.includes('quality_score'))    db.prepare("ALTER TABLE swarm_runs ADD COLUMN quality_score INTEGER DEFAULT NULL").run();
if (!existingCols.includes('quality_feedback')) db.prepare("ALTER TABLE swarm_runs ADD COLUMN quality_feedback TEXT DEFAULT NULL").run();
if (!existingCols.includes('retry_count'))      db.prepare("ALTER TABLE swarm_runs ADD COLUMN retry_count INTEGER DEFAULT 0").run();
if (!existingCols.includes('prompt_category'))  db.prepare("ALTER TABLE swarm_runs ADD COLUMN prompt_category TEXT DEFAULT NULL").run();
if (!existingCols.includes('topology_used'))    db.prepare("ALTER TABLE swarm_runs ADD COLUMN topology_used TEXT DEFAULT 'hierarchical'").run();
```

### 1c. Add new `swarmRunsDB` methods

Inside the `swarmRunsDB` object (after the existing `delete` method), add:

```javascript
// Save quality score after reviewer evaluation
setQuality: (id, score, feedback) => {
    return db.prepare(`
        UPDATE swarm_runs
        SET quality_score = ?, quality_feedback = ?
        WHERE id = ?
    `).run(score, feedback, id);
},

// Increment retry counter
incrementRetry: (id) => {
    return db.prepare(`
        UPDATE swarm_runs SET retry_count = retry_count + 1 WHERE id = ?
    `).run(id);
},

// Get topology performance stats (for learning)
getTopologyStats: () => {
    return db.prepare(`
        SELECT topology_used, prompt_category,
               AVG(quality_score) as avg_score,
               COUNT(*) as run_count
        FROM swarm_runs
        WHERE quality_score IS NOT NULL
        GROUP BY topology_used, prompt_category
        ORDER BY avg_score DESC
    `).all();
},

// Get best topology for a category based on history
getBestTopology: (category) => {
    const row = db.prepare(`
        SELECT topology_used, AVG(quality_score) as avg_score, COUNT(*) as run_count
        FROM swarm_runs
        WHERE quality_score IS NOT NULL
          AND prompt_category = ?
          AND run_count >= 3
        GROUP BY topology_used
        ORDER BY avg_score DESC
        LIMIT 1
    `).get(category);
    return row ? row.topology_used : null;
},
```

---

## Step 2 — Create the Reviewer Service

**File:** `dashboard/services/reviewer.js` *(NEW FILE)*

```javascript
'use strict';
/**
 * reviewer.js — Swarm Output Quality Evaluator
 *
 * Uses local Ollama to score a swarm's output on a 0–100 scale.
 * Scores below RETRY_THRESHOLD trigger automatic re-execution.
 */

const RETRY_THRESHOLD = 45;   // Score below this triggers a retry
const MAX_RETRIES     = 2;    // Maximum automatic retries per run

/**
 * Ask the local Ollama model to evaluate swarm output quality.
 * @param {string} originalPrompt - What the user originally asked for
 * @param {string} swarmOutput    - The raw output produced by the swarm
 * @returns {Promise<{ score: number, feedback: string, shouldRetry: boolean }>}
 */
async function evaluateOutput(originalPrompt, swarmOutput) {
    try {
        const localBot = require('../local-bot');

        const systemPrompt = `You are a strict but fair software engineering quality reviewer.
Your job is to evaluate whether an AI swarm successfully completed a given objective.
Always respond with ONLY valid JSON in this exact format:
{ "score": <0-100>, "feedback": "<one sentence>", "issues": ["<issue1>", "<issue2>"] }`;

        const evalPrompt = `ORIGINAL OBJECTIVE:
${originalPrompt.slice(0, 400)}

SWARM OUTPUT:
${swarmOutput.slice(0, 1500)}

Evaluate the output. Score 0=complete failure, 50=partial, 80=good, 95+=excellent.
Deduct points for: errors in output, objective not addressed, missing implementation steps.
Respond with JSON only.`;

        const raw = await localBot.call(evalPrompt, 'reviewer', systemPrompt, 400);

        // Parse JSON from response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in reviewer response');

        const parsed = JSON.parse(jsonMatch[0]);
        const score = Math.max(0, Math.min(100, parseInt(parsed.score) || 0));
        const feedback = parsed.feedback || 'No feedback provided.';

        return {
            score,
            feedback,
            issues: parsed.issues || [],
            shouldRetry: score < RETRY_THRESHOLD
        };
    } catch (e) {
        console.warn('[REVIEWER] Evaluation failed (non-fatal):', e.message);
        // Return neutral score on failure — do NOT block swarm completion
        return { score: null, feedback: null, issues: [], shouldRetry: false };
    }
}

/**
 * Classify a prompt into a category for topology learning.
 * @param {string} prompt
 * @returns {string}
 */
function classifyPrompt(prompt) {
    const lower = prompt.toLowerCase();
    if (/test|spec|coverage|jest|vitest/.test(lower))          return 'testing';
    if (/security|audit|vulnerability|pentest/.test(lower))    return 'security';
    if (/refactor|clean|optimize|performance/.test(lower))     return 'refactoring';
    if (/build|deploy|ci|cd|pipeline|docker/.test(lower))      return 'devops';
    if (/api|route|endpoint|rest|graphql/.test(lower))         return 'api';
    if (/ui|frontend|component|react|css|html/.test(lower))    return 'frontend';
    if (/database|sql|schema|migration|model/.test(lower))     return 'database';
    if (/document|readme|comment|explain/.test(lower))         return 'documentation';
    return 'general';
}

module.exports = { evaluateOutput, classifyPrompt, RETRY_THRESHOLD, MAX_RETRIES };
```

---

## Step 3 — Integrate Reviewer into `spawnSwarm()`

**File:** `dashboard/swarm-orchestrator.js`

### 3a. Add require at the top of the file (after existing requires)

```javascript
const reviewer = require('./services/reviewer');
```

### 3b. Update `spawnSwarm()` to record topology and classify prompt

Find where `swarmRunsDB.create(runId, objective, ...)` is called (around line 228) and update it:

```javascript
// Classify the prompt for learning
const promptCategory = reviewer.classifyPrompt(objective);

// Use historically best topology if we have enough data
let topology = opts.topology || 'hierarchical';
try {
    const learnedTopology = swarmRunsDB.getBestTopology(promptCategory);
    if (learnedTopology) {
        topology = learnedTopology;
        console.log(`[SWARM] Using learned topology "${topology}" for category "${promptCategory}"`);
    }
} catch (_e) {}

swarmRunsDB.create(runId, objective, bots.map(b => b.name));
// Record topology and category
try {
    db.prepare('UPDATE swarm_runs SET topology_used = ?, prompt_category = ? WHERE id = ?')
      .run(topology, promptCategory, runId);
} catch (_e) {}
```

> **Note:** You'll need to add `const { db } = require('./db');` at the top of swarm-orchestrator.js if it's not already there.

### 3c. Add reviewer evaluation after swarm completes

Find the two `resolve({ output, bots })` calls — one after Docker success and one after native exec success. Before each `resolve()`, add the reviewer logic:

```javascript
// ── Phase B: Quality Evaluation ───────────────────────────────────────
const currentRetryCount = (() => {
    try { return swarmRunsDB.getById(runId)?.retry_count || 0; } catch { return 0; }
})();

const { score, feedback, shouldRetry } = await reviewer.evaluateOutput(objective, output);

if (score !== null) {
    try { swarmRunsDB.setQuality(runId, score, feedback); } catch (_e) {}
    console.log(`[REVIEWER] Quality score: ${score}/100 — ${feedback}`);
}

// Auto-retry if score is below threshold and retries remain
if (shouldRetry && currentRetryCount < reviewer.MAX_RETRIES) {
    console.log(`[REVIEWER] Score ${score} below threshold. Auto-retrying (attempt ${currentRetryCount + 1}/${reviewer.MAX_RETRIES})...`);
    try { swarmRunsDB.incrementRetry(runId); } catch (_e) {}

    const retryResult = await spawnSwarm(
        `[RETRY - Previous score: ${score}/100. Feedback: ${feedback}]\n\n${objective}`,
        { ...opts, topology, _isRetry: true }
    );
    resolve(retryResult);
    return;
}
// ── End Phase B ───────────────────────────────────────────────────────
```

> Add this block **before** each `resolve({ output, bots })` call. Guard against infinite retry loops using `opts._isRetry`.

---

## Step 4 — Add Topology Stats API Endpoint

**File:** `dashboard/routes/history.js`

Add this route after the existing `DELETE /:id` route:

```javascript
// GET /api/history/stats/topology — Topology performance data for the learning dashboard
router.get('/stats/topology', (req, res) => {
    try {
        const stats = swarmRunsDB.getTopologyStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/history/stats/overview — Overall quality summary
router.get('/stats/overview', (req, res) => {
    try {
        const { db } = require('../db');
        const row = db.prepare(`
            SELECT
                COUNT(*) as total_runs,
                AVG(quality_score) as avg_quality,
                SUM(CASE WHEN quality_score >= 80 THEN 1 ELSE 0 END) as high_quality_runs,
                SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) as retried_runs,
                SUM(retry_count) as total_retries
            FROM swarm_runs
            WHERE status != 'deleted'
        `).get();
        res.json({ success: true, overview: row });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
```

---

## Step 5 — Update the History UI

**File:** `dashboard/index.html`

### 5a. Add "Score" column to the history table header

Find the `<thead>` block inside `#history-panel` and add a column:

```html
<!-- Add after the "Duration" <th> and before "Status" <th> -->
<th style="padding:0.65rem 0.75rem;text-align:left;">Score</th>
```

### 5b. Add a Quality Stats card above the history table

Inside `#history-panel`, above the `<div style="flex:1;overflow:auto;">` wrapper, add:

```html
<!-- Quality Stats Bar -->
<div id="quality-stats-bar" style="display:flex;gap:1.5rem;padding:0.75rem 1.25rem;background:rgba(0,0,0,0.1);border-bottom:1px solid var(--glass-border);flex-wrap:wrap;">
  <div style="font-size:0.78em;color:var(--text-secondary);">📊 Loading quality stats...</div>
</div>
```

---

## Step 6 — Update the Frontend `loadSwarmHistory()` Function

**File:** `dashboard/app.js`

### 6a. Add score column to the table row template

Inside `loadSwarmHistory()`, find where the `<tr>` HTML is built and add a score cell after the duration cell:

```javascript
// Add after duration <td>, before status <td>
const scoreColor = run.quality_score >= 80 ? '#10b981'
    : run.quality_score >= 50 ? '#f59e0b'
    : run.quality_score !== null ? '#ef4444' : '#64748b';
const scoreBadge = run.quality_score !== null
    ? `<span style="font-weight:700;color:${scoreColor}">${run.quality_score}</span><span style="font-size:0.7em;color:var(--text-secondary)">/100</span>`
    : `<span style="color:var(--text-secondary);font-size:0.8em;">—</span>`;
const retryBadge = run.retry_count > 0
    ? `<span style="font-size:0.68em;color:#f59e0b;margin-left:4px;">🔄×${run.retry_count}</span>` : '';
```

Then in the row HTML add:
```javascript
`<td style="padding:0.7rem 0.75rem;white-space:nowrap;">${scoreBadge}${retryBadge}</td>`
```

### 6b. Add a function to load quality stats

Add this new function inside the `DOMContentLoaded` listener:

```javascript
async function loadQualityStats() {
    const bar = document.getElementById('quality-stats-bar');
    if (!bar) return;
    try {
        const [overviewRes, topoRes] = await Promise.all([
            fetch('http://localhost:3000/api/history/stats/overview'),
            fetch('http://localhost:3000/api/history/stats/topology')
        ]);
        const { overview } = await overviewRes.json();
        const { stats } = await topoRes.json();

        const avgQ = overview.avg_quality ? Math.round(overview.avg_quality) : null;
        const avgColor = avgQ >= 80 ? '#10b981' : avgQ >= 50 ? '#f59e0b' : '#ef4444';
        const bestTopo = stats[0];

        bar.innerHTML = `
            <div style="display:flex;gap:2rem;align-items:center;flex-wrap:wrap;font-size:0.82em;">
                <div><span style="color:var(--text-secondary)">Total Runs: </span><strong>${overview.total_runs || 0}</strong></div>
                <div><span style="color:var(--text-secondary)">Avg Quality: </span><strong style="color:${avgColor}">${avgQ !== null ? avgQ + '/100' : 'N/A'}</strong></div>
                <div><span style="color:var(--text-secondary)">High Quality (80+): </span><strong style="color:#10b981">${overview.high_quality_runs || 0}</strong></div>
                <div><span style="color:var(--text-secondary)">Auto-Retried: </span><strong style="color:#f59e0b">${overview.retried_runs || 0}</strong></div>
                ${bestTopo ? `<div><span style="color:var(--text-secondary)">Best Topology: </span><strong style="color:#6366f1">${bestTopo.topology_used} (${bestTopo.prompt_category}, ${Math.round(bestTopo.avg_score)}avg)</strong></div>` : ''}
            </div>`;
    } catch (e) {
        if (bar) bar.innerHTML = `<span style="font-size:0.78em;color:var(--text-secondary)">Quality stats unavailable</span>`;
    }
}
```

### 6c. Call `loadQualityStats()` when the history panel opens

Find where `loadSwarmHistory()` is called (it should be in the nav click handler for the history panel) and add `loadQualityStats()` right after it:

```javascript
loadSwarmHistory();
loadQualityStats();
```

Also call it on the refresh button:
```javascript
document.getElementById('btn-refresh-history')?.addEventListener('click', () => {
    loadSwarmHistory();
    loadQualityStats();
});
```

---

## Step 7 — Store Topology Learning in Pattern Memory (Optional Enhancement)

**File:** `dashboard/services/reviewer.js`

Add this function to persist quality learnings to the vector store for cross-session recall:

```javascript
/**
 * Persist a high-quality run's topology → category mapping to pattern memory.
 * Called only for runs scoring 80+.
 */
async function persistTopologyLearning(category, topology, score, promptSample) {
    if (score < 80) return;
    try {
        const patternMemory = require('../pattern-memory');
        const key = `topology-learning-${category}-${topology}-${Date.now()}`;
        const content = `Topology: ${topology} | Category: ${category} | Score: ${score}/100 | Prompt sample: ${promptSample.slice(0, 100)}`;
        await patternMemory.store(key, content, `topology:${topology} category:${category}`);
        console.log(`[REVIEWER] Persisted topology learning: ${topology} → ${category} (${score})`);
    } catch (_e) {}
}

module.exports = { evaluateOutput, classifyPrompt, persistTopologyLearning, RETRY_THRESHOLD, MAX_RETRIES };
```

Then in `swarm-orchestrator.js`, after `swarmRunsDB.setQuality(runId, score, feedback)`:

```javascript
if (score >= 80) {
    reviewer.persistTopologyLearning(promptCategory, topology, score, objective).catch(() => {});
}
```

---

## Verification Plan

### Automated Tests

Run after implementation:

```bash
cd dashboard
npm test
```

Key test scenarios to add in `tests/reviewer.test.js`:

```javascript
const { evaluateOutput, classifyPrompt } = require('../services/reviewer');

test('classifyPrompt correctly categorizes security prompts', () => {
    expect(classifyPrompt('run a security audit on the auth module')).toBe('security');
});

test('classifyPrompt defaults to general', () => {
    expect(classifyPrompt('do something cool')).toBe('general');
});

test('evaluateOutput returns neutral score when Ollama is offline', async () => {
    const result = await evaluateOutput('test prompt', 'some output');
    expect(result.shouldRetry).toBe(false); // Should not retry on evaluator failure
    expect(result.score === null || typeof result.score === 'number').toBe(true);
});
```

### Manual Verification Checklist

1. **Start the server:** `node server.js`
2. **Run a swarm** from the AI Magic panel with a simple prompt
3. **Check the terminal** for:
   - `[REVIEWER] Quality score: XX/100` log line
   - `[REVIEWER] Using learned topology...` on subsequent runs of the same category
4. **Open the History tab** — verify the new "Score" column shows a number
5. **Check the quality stats bar** at the top of the History tab shows aggregate data
6. **Verify retry behavior:** If you see a score below 45, the swarm should automatically re-run with a `[RETRY]` prefix in the prompt (check terminal logs)
7. **Check SQLite directly:**
   ```bash
   node -e "const {db} = require('./db'); console.log(db.prepare('SELECT id, quality_score, retry_count, prompt_category, topology_used FROM swarm_runs LIMIT 5').all())"
   ```

---

## Important Notes for Implementing AI

1. **Do NOT block swarm completion on reviewer failure.** The `evaluateOutput()` function already handles errors gracefully — if Ollama is offline, it returns `{ score: null, shouldRetry: false }`. Never let a reviewer crash break a swarm result.

2. **The `_isRetry` flag in opts** prevents infinite retry loops. Always check `opts._isRetry` before retrying, or use the `retry_count < MAX_RETRIES` guard from the DB.

3. **Ollama must be running** for the reviewer to work. The reviewer uses the same model as the chat system (reads from `settingsDB.get('selected_model')`).

4. **The topology learning only kicks in** when a category has at least 3 runs with quality scores. This prevents premature learning from too few data points (`run_count >= 3` in the SQL query).

5. **Do not modify `swarm_runs` column names** — they are referenced by the History UI, the history route, and `swarmRunsDB` methods throughout the codebase.

---

## Files to Create / Modify Summary

| Action | File | What Changes |
|--------|------|--------------|
| **CREATE** | `dashboard/services/reviewer.js` | New quality evaluator service |
| **MODIFY** | `dashboard/db.js` | Add 5 new columns + migration + 4 new DB methods |
| **MODIFY** | `dashboard/swarm-orchestrator.js` | Integrate reviewer, topology learning, auto-retry |
| **MODIFY** | `dashboard/routes/history.js` | Add `/stats/topology` and `/stats/overview` endpoints |
| **MODIFY** | `dashboard/index.html` | Add Score column header + quality stats bar div |
| **MODIFY** | `dashboard/app.js` | Add score rendering + `loadQualityStats()` function |

---

*Phase B Implementation Guide — Pavi Platform*
*Generated: May 2026*

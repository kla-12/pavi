# Phase C — Multi-Project Workspace & Platform Hardening
## Pavi Platform | Implementation Guide for AI Agents

> **Goal:** Extend Pavi from a single-repo system to a multi-project workspace.
> Add VectorStore memory cap, complete real plugin implementations, and lay
> the foundation for Autonomous CI/CD (Phase D).
>
> **Estimated Effort:** 3–5 days
> **Architecture Rating Impact:** 90 → 95 / 100

---

## Audit — What Is Already Done (Do NOT re-implement)

| Item | Status |
|------|--------|
| Prompt/Response caching (SQLite `prompt_cache`) | ✅ Done in Phase B |
| Plugin loader (`services/plugin-loader.js`) | ✅ Done |
| LRU eviction on query **cache** (`cacheMaxSize: 100`) | ✅ Done |
| Monaco Editor in Write Audit diff panel | ✅ Done |
| CI/CD GitHub Actions at `.github/workflows/` | ✅ Done |
| Web-search plugin stub (`plugins/web-search/index.js`) | ✅ Stub only — needs real impl |
| VectorStore **persistence** (disk serialisation) | ✅ Done in Phase A |

## What Is NOT Done (Phase C targets)

| # | Item | Priority |
|---|------|----------|
| 1 | VectorStore size cap (main Map has no limit) | **P0** |
| 2 | Real web-search plugin (stub returns nothing useful) | P1 |
| 3 | `code-runner` plugin | P1 |
| 4 | Multi-project workspace manager | P2 |
| 5 | Workspace-aware pattern recall | P2 |

---

## Step 1 — VectorStore LRU Size Cap

**File:** `dashboard/pattern-memory.js`

### 1a. Add `MAX_VECTOR_ENTRIES` constant

Find the constructor (around line 140):
```javascript
this.vectorStorePath = options.vectorStorePath || path.join(__dirname, '.vector-store.json');
```

Add directly after:
```javascript
this.maxVectorEntries = options.maxVectorEntries || 5000; // LRU cap for vectorStore
```

### 1b. Apply cap inside `store()` method

Find the `store()` method where it calls `this.vectorStore.set(key, entry)`:
```javascript
this.vectorStore.set(key, entry);
```

Replace with:
```javascript
// LRU eviction: if over cap, delete the oldest (first inserted) entry
if (this.vectorStore.size >= this.maxVectorEntries) {
    const oldestKey = this.vectorStore.keys().next().value;
    this.vectorStore.delete(oldestKey);
    console.warn(`[PATTERN_MEM] VectorStore cap reached (${this.maxVectorEntries}). Evicted oldest entry: ${oldestKey}`);
}
this.vectorStore.set(key, entry);
```

### 1c. Add a `vectorStoreSize()` helper

Inside the class, add:
```javascript
vectorStoreSize() {
    return this.vectorStore.size;
}
```

### 1d. Expose size in `/api/health`

**File:** `dashboard/routes/health.js`

Find where the health response is built and add a `vectorStore` component:
```javascript
vectorStore: {
    status: 'ok',
    details: `${patternMemory.vectorStoreSize()} entries`
}
```

> Add `const patternMemory = require('../pattern-memory');` at the top of health.js if not already present.

---

## Step 2 — Real Web-Search Plugin

**File:** `dashboard/plugins/web-search/index.js`

Replace the stub with a real DuckDuckGo Instant Answer integration (no API key needed):

```javascript
'use strict';
const logger = require('../../utils/logger');

module.exports = {
    name: 'Web Search',
    version: '2.0.0',
    description: 'Real-time web search via DuckDuckGo Instant Answer API. No API key required.',

    init: (app) => {
        logger.info('[PLUGIN: Web Search] Initializing DuckDuckGo search plugin...');

        // GET /api/plugins/web-search?q=<query>
        app.get('/api/plugins/web-search', async (req, res) => {
            const query = req.query.q;
            if (!query) return res.status(400).json({ success: false, error: 'Missing ?q= parameter' });

            try {
                const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
                const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
                if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);

                const data = await response.json();

                const results = {
                    abstract: data.AbstractText || null,
                    abstractSource: data.AbstractSource || null,
                    abstractURL: data.AbstractURL || null,
                    answer: data.Answer || null,
                    answerType: data.AnswerType || null,
                    relatedTopics: (data.RelatedTopics || []).slice(0, 5).map(t => ({
                        text: t.Text,
                        url: t.FirstURL
                    }))
                };

                logger.info(`[PLUGIN: Web Search] Query: "${query}" — abstract: ${!!results.abstract}`);
                res.json({ success: true, query, results });
            } catch (e) {
                logger.error('[PLUGIN: Web Search] Search failed:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }
};
```

---

## Step 3 — Code Runner Plugin (NEW FILE)

**File:** `dashboard/plugins/code-runner/index.js` *(NEW)*

This plugin executes short JS code snippets in the Node.js `vm` sandbox already available in the project.

```javascript
'use strict';
const vm = require('vm');
const logger = require('../../utils/logger');

module.exports = {
    name: 'Code Runner',
    version: '1.0.0',
    description: 'Safely execute JavaScript snippets in a sandboxed vm context.',

    init: (app) => {
        logger.info('[PLUGIN: Code Runner] Initializing sandboxed JS execution plugin...');

        // POST /api/plugins/code-runner  { code: "...", timeoutMs: 2000 }
        app.post('/api/plugins/code-runner', (req, res) => {
            const { code, timeoutMs = 2000 } = req.body;
            if (!code || typeof code !== 'string') {
                return res.status(400).json({ success: false, error: 'Missing code in request body' });
            }
            if (code.length > 4000) {
                return res.status(400).json({ success: false, error: 'Code exceeds 4000 character limit' });
            }

            const logs = [];
            const sandbox = {
                console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('[WARN] ' + a.join(' ')) },
                Math, JSON, Date, parseInt, parseFloat, isNaN, isFinite,
                Array, Object, String, Number, Boolean, Map, Set
            };

            try {
                const script = new vm.Script(code, { filename: 'sandbox.js' });
                const ctx = vm.createContext(sandbox);
                const result = script.runInContext(ctx, { timeout: timeoutMs });
                res.json({ success: true, result: result !== undefined ? String(result) : undefined, logs });
            } catch (e) {
                logger.warn(`[PLUGIN: Code Runner] Execution error: ${e.message}`);
                res.status(200).json({ success: false, error: e.message, logs });
            }
        });
    }
};
```

---

## Step 4 — Multi-Project Workspace Manager

### 4a. Add `workspaces` table to SQLite

**File:** `dashboard/db.js`

Add to the `db.exec()` schema block:
```sql
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    description TEXT,
    created_at INTEGER,
    last_active_at INTEGER,
    is_active INTEGER DEFAULT 0
);
```

After the schema block, add migration:
```javascript
try { db.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, description TEXT, created_at INTEGER, last_active_at INTEGER, is_active INTEGER DEFAULT 0)'); } catch {}
```

### 4b. Add `workspacesDB` wrapper

Inside `db.js`, after `settingsDB`, add:
```javascript
const workspacesDB = {
    getAll: () => db.prepare('SELECT * FROM workspaces ORDER BY last_active_at DESC').all(),
    getActive: () => db.prepare("SELECT * FROM workspaces WHERE is_active = 1 LIMIT 1").get(),
    create: (id, name, rootPath, description) => {
        return db.prepare(`
            INSERT INTO workspaces (id, name, root_path, description, created_at, last_active_at, is_active)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `).run(id, name, rootPath, description || '', Date.now(), Date.now());
    },
    setActive: (id) => {
        const tx = db.transaction(() => {
            db.prepare('UPDATE workspaces SET is_active = 0').run();
            db.prepare('UPDATE workspaces SET is_active = 1, last_active_at = ? WHERE id = ?').run(Date.now(), id);
        });
        tx();
    },
    delete: (id) => db.prepare('DELETE FROM workspaces WHERE id = ?').run(id),
    getById: (id) => db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
};
```

Add `workspacesDB` to `module.exports`.

### 4c. Create workspace routes

**File:** `dashboard/routes/workspaces.js` *(NEW)*

```javascript
'use strict';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { workspacesDB } = require('../db');

// GET /api/workspaces
router.get('/', (req, res) => {
    try {
        res.json({ success: true, workspaces: workspacesDB.getAll() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/workspaces — Create a new workspace
router.post('/', (req, res) => {
    const { name, rootPath, description } = req.body;
    if (!name || !rootPath) return res.status(400).json({ error: 'name and rootPath required' });

    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved)) return res.status(400).json({ error: 'Path does not exist on disk' });

    try {
        const id = randomUUID();
        workspacesDB.create(id, name.trim(), resolved, description);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/workspaces/:id/activate — Switch active workspace
router.post('/:id/activate', (req, res) => {
    try {
        const ws = workspacesDB.getById(req.params.id);
        if (!ws) return res.status(404).json({ error: 'Workspace not found' });
        workspacesDB.setActive(req.params.id);
        res.json({ success: true, workspace: workspacesDB.getById(req.params.id) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/workspaces/:id
router.delete('/:id', (req, res) => {
    try {
        workspacesDB.delete(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
```

### 4d. Mount workspace router in server.js

**File:** `dashboard/server.js`

After the existing route mounts (around line 138), add:
```javascript
app.use('/api/workspaces', require('./routes/workspaces'));
```

### 4e. Wire active workspace into swarm-orchestrator.js

**File:** `dashboard/swarm-orchestrator.js`

At the top, add:
```javascript
const { workspacesDB } = require('./db');
```

Inside `spawnSwarm()`, find where the working directory is set for Docker/exec, and replace the hardcoded path with:
```javascript
// Use active workspace path if set, fall back to default
const activeWorkspace = (() => { try { return workspacesDB.getActive(); } catch { return null; } })();
const workspaceRoot = activeWorkspace ? activeWorkspace.root_path : path.join(__dirname, '..', 'tmp', 'workspace');
```

Use `workspaceRoot` wherever the host bind-mount path or exec `cwd` is set.

---

## Step 5 — Workspace UI in Dashboard

**File:** `dashboard/index.html`

### 5a. Add sidebar nav item

Inside `#advanced-nav`, add after the Plugin Manager item:
```html
<li><a href="#" data-target="workspace-panel"><i class="icon">🗂️</i> Workspaces</a></li>
```

### 5b. Add workspace panel

After `#plugins-panel` section, add:
```html
<!-- Workspace Manager Panel -->
<section id="workspace-panel" class="panel">
  <div class="cards-grid">
    <div class="card glass-card full-width">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h3 style="margin:0;">🗂️ Project Workspaces</h3>
        <button id="btn-new-workspace" class="btn btn-primary" style="padding:0.4rem 1rem;font-size:0.85rem;">+ New Workspace</button>
      </div>
      <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:1.5rem;">
        Manage multiple project directories. The active workspace is the root used by swarm agents.
      </p>
      <div id="workspace-list" style="display:flex;flex-direction:column;gap:0.75rem;">
        <div style="text-align:center;opacity:0.5;padding:2rem;">Loading workspaces...</div>
      </div>
    </div>

    <!-- New Workspace Form (hidden by default) -->
    <div class="card glass-card full-width" id="new-workspace-form" style="display:none;">
      <h3 style="margin-top:0;">Add Workspace</h3>
      <div class="form-group">
        <label>Project Name</label>
        <input type="text" id="ws-name" placeholder="e.g. My API Project" class="glass-input" style="padding:0.75rem;width:100%;border-radius:8px;">
      </div>
      <div class="form-group" style="margin-top:1rem;">
        <label>Root Path (absolute path on this machine)</label>
        <input type="text" id="ws-path" placeholder="e.g. C:\Users\dev\my-project" class="glass-input" style="padding:0.75rem;width:100%;border-radius:8px;">
      </div>
      <div class="form-group" style="margin-top:1rem;">
        <label>Description (optional)</label>
        <input type="text" id="ws-desc" placeholder="e.g. REST API with Express" class="glass-input" style="padding:0.75rem;width:100%;border-radius:8px;">
      </div>
      <div style="display:flex;gap:1rem;margin-top:1.5rem;">
        <button id="btn-save-workspace" class="btn btn-primary">Save Workspace</button>
        <button id="btn-cancel-workspace" class="btn btn-secondary">Cancel</button>
      </div>
    </div>
  </div>
</section>
```

---

## Step 6 — Workspace Frontend Logic

**File:** `dashboard/app.js`

### 6a. Add workspace initialization to `initializeDashboardComponents()`

```javascript
loadWorkspaces();
document.getElementById('btn-new-workspace')?.addEventListener('click', () => {
    document.getElementById('new-workspace-form').style.display = 'block';
});
document.getElementById('btn-cancel-workspace')?.addEventListener('click', () => {
    document.getElementById('new-workspace-form').style.display = 'none';
});
document.getElementById('btn-save-workspace')?.addEventListener('click', saveWorkspace);
```

### 6b. Add `loadWorkspaces()` function

```javascript
async function loadWorkspaces() {
    const list = document.getElementById('workspace-list');
    if (!list) return;
    try {
        const res = await fetch('http://localhost:3000/api/workspaces');
        const data = await res.json();
        const workspaces = data.workspaces || [];
        if (workspaces.length === 0) {
            list.innerHTML = `<div style="text-align:center;opacity:0.5;padding:2rem;">No workspaces yet. Click "+ New Workspace" to add one.</div>`;
            return;
        }
        list.innerHTML = workspaces.map(ws => `
            <div style="padding:1rem;border-radius:8px;border:1px solid ${ws.is_active ? 'var(--accent-primary)' : 'var(--glass-border)'};background:${ws.is_active ? 'rgba(99,102,241,0.1)' : 'rgba(0,0,0,0.1)'};display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-weight:600;font-size:0.95rem;">${ws.name} ${ws.is_active ? '<span style="font-size:0.7rem;background:#6366f1;color:white;padding:2px 6px;border-radius:8px;margin-left:6px;">ACTIVE</span>' : ''}</div>
                <div style="font-size:0.75rem;opacity:0.6;margin-top:2px;">${ws.root_path}</div>
                ${ws.description ? `<div style="font-size:0.75rem;opacity:0.5;margin-top:2px;">${ws.description}</div>` : ''}
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0;margin-left:1rem;">
                ${!ws.is_active ? `<button class="btn btn-primary" onclick="activateWorkspace('${ws.id}')" style="padding:4px 12px;font-size:0.8rem;">Activate</button>` : ''}
                <button class="btn" onclick="deleteWorkspace('${ws.id}')" style="padding:4px 10px;font-size:0.8rem;background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.2);">🗑</button>
              </div>
            </div>`).join('');
    } catch (e) {
        list.innerHTML = `<div style="color:#ef4444;padding:1rem;">Failed to load workspaces: ${e.message}</div>`;
    }
}

async function saveWorkspace() {
    const name = document.getElementById('ws-name')?.value?.trim();
    const rootPath = document.getElementById('ws-path')?.value?.trim();
    const description = document.getElementById('ws-desc')?.value?.trim();
    if (!name || !rootPath) return alert('Name and path are required.');
    try {
        const res = await fetch('http://localhost:3000/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, rootPath, description })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('new-workspace-form').style.display = 'none';
            document.getElementById('ws-name').value = '';
            document.getElementById('ws-path').value = '';
            document.getElementById('ws-desc').value = '';
            loadWorkspaces();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Failed: ' + e.message); }
}

async function activateWorkspace(id) {
    try {
        await fetch(`http://localhost:3000/api/workspaces/${id}/activate`, { method: 'POST' });
        loadWorkspaces();
    } catch (e) { console.error('[WORKSPACE] Activate failed:', e); }
}

async function deleteWorkspace(id) {
    if (!confirm('Delete this workspace? The files on disk are NOT deleted.')) return;
    try {
        await fetch(`http://localhost:3000/api/workspaces/${id}`, { method: 'DELETE' });
        loadWorkspaces();
    } catch (e) { console.error('[WORKSPACE] Delete failed:', e); }
}

window.activateWorkspace = activateWorkspace;
window.deleteWorkspace = deleteWorkspace;
```

---

## Step 7 — Tests

**File:** `dashboard/tests/integration/workspaces.test.js` *(NEW)*

```javascript
const request = require('supertest');
const app = require('../../server');

describe('Workspace API', () => {
    let workspaceId;

    it('GET /api/workspaces returns array', async () => {
        const res = await request(app).get('/api/workspaces');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.workspaces)).toBe(true);
    });

    it('POST /api/workspaces creates a workspace', async () => {
        const res = await request(app)
            .post('/api/workspaces')
            .send({ name: 'Test Project', rootPath: process.cwd(), description: 'Test' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        workspaceId = res.body.id;
    });

    it('POST /api/workspaces/:id/activate switches active', async () => {
        if (!workspaceId) return;
        const res = await request(app).post(`/api/workspaces/${workspaceId}/activate`);
        expect(res.status).toBe(200);
        expect(res.body.workspace.is_active).toBe(1);
    });

    it('DELETE /api/workspaces/:id removes workspace', async () => {
        if (!workspaceId) return;
        const res = await request(app).delete(`/api/workspaces/${workspaceId}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/workspaces rejects non-existent path', async () => {
        const res = await request(app)
            .post('/api/workspaces')
            .send({ name: 'Bad', rootPath: '/this/path/does/not/exist/anywhere' });
        expect(res.status).toBe(400);
    });
});
```

---

## Verification Plan

### Automated Tests
```bash
cd dashboard
npm test
```

### Manual Checklist

1. **VectorStore cap** — Store 5001 entries programmatically; confirm oldest is evicted and size stays at 5000.
2. **Web search** — Hit `GET /api/plugins/web-search?q=node+js` in browser; expect JSON with `abstract` or `relatedTopics`.
3. **Code runner** — POST `{ "code": "2 + 2" }` to `/api/plugins/code-runner`; expect `{ result: "4" }`.
4. **Workspace CRUD** — Create workspace pointing to `ruflo-main/`, activate it, verify it shows as ACTIVE in UI.
5. **Workspace routing in swarm** — With a workspace active, run a swarm and confirm terminal shows correct `workspaceRoot` path.

### SQLite Verification
```bash
node -e "const {db} = require('./db'); console.log(db.prepare('SELECT name, sqlite_master.sql FROM sqlite_master WHERE name=\"workspaces\"').get())"
```

---

## Files To Create / Modify Summary

| Action | File | What Changes |
|--------|------|--------------|
| **MODIFY** | `dashboard/pattern-memory.js` | Add `maxVectorEntries` + LRU eviction in `store()` |
| **MODIFY** | `dashboard/routes/health.js` | Expose vectorStore size in health response |
| **MODIFY** | `dashboard/plugins/web-search/index.js` | Replace stub with real DuckDuckGo integration |
| **CREATE** | `dashboard/plugins/code-runner/index.js` | Sandboxed JS execution plugin |
| **MODIFY** | `dashboard/db.js` | Add `workspaces` table + `workspacesDB` wrapper |
| **CREATE** | `dashboard/routes/workspaces.js` | REST CRUD for workspace management |
| **MODIFY** | `dashboard/server.js` | Mount `/api/workspaces` router |
| **MODIFY** | `dashboard/swarm-orchestrator.js` | Use active workspace path as execution root |
| **MODIFY** | `dashboard/index.html` | Sidebar nav item + workspace panel HTML |
| **MODIFY** | `dashboard/app.js` | `loadWorkspaces()`, `saveWorkspace()`, `activateWorkspace()` |
| **CREATE** | `dashboard/tests/integration/workspaces.test.js` | Integration tests |

---

## Important Notes for Implementing AI

1. **Do not re-implement caching** — `prompt_cache` table and `promptCacheDB` in `db.js` are complete. Do not touch them.
2. **Plugin loader is already wired** — `server.js` calls `pluginLoader.loadPlugins(app)`. Just add new plugin folders; they auto-load.
3. **VectorStore LRU is on the Map itself** — The `this.cache` (LRU, 100 entries) and `this.vectorStore` (the semantic store, currently unbounded) are two different things. Only the vectorStore needs the cap added.
4. **Workspace paths must be absolute** — Always `path.resolve()` before storing. Never store relative paths.
5. **Swarm backward compatibility** — If no workspace is active, the swarm must fall back to the existing hardcoded path. Never break existing single-project usage.

---

*Phase C Implementation Guide — Pavi Platform*
*Generated: May 2026*

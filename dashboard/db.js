'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'pavi.db');
const db = new Database(dbPath, { timeout: 5000 });

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS session_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS training_feedback_dataset (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    swarm_output TEXT,
    score INTEGER,
    feedback TEXT,
    issues TEXT,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS training_runs (
    id TEXT PRIMARY KEY,
    status TEXT,
    dataset_size INTEGER,
    loss REAL,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS model_benchmarks (
    model_name TEXT PRIMARY KEY,
    pass_rate REAL,
    avg_score REAL,
    runs INTEGER
  );

  CREATE TABLE IF NOT EXISTS checker_audit_log (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    checker_model TEXT,
    score INTEGER,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS skill_genealogy (
    tag TEXT PRIMARY KEY,
    parent_tag TEXT,
    generation INTEGER,
    confidence REAL,
    mutations TEXT
  );

  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    url TEXT,
    label TEXT,
    status TEXT, -- 'pending', 'processing', 'done', 'failed'
    processing_since INTEGER,
    retries INTEGER,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    ts TEXT,
    event TEXT,
    tag TEXT,
    repo TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS capability_index (
    intent TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS staging_skills (
    id TEXT PRIMARY KEY,
    status TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS repo_quarantine (
    repoKey TEXT PRIMARY KEY,
    score REAL,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS bots (
    name TEXT PRIMARY KEY,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS skills (
    tag TEXT PRIMARY KEY,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS rate_limit_log (
    ip TEXT,
    endpoint TEXT,
    timestamp INTEGER
  );
  
  CREATE INDEX IF NOT EXISTS idx_rate_limit ON rate_limit_log(ip, endpoint, timestamp);

  CREATE TABLE IF NOT EXISTS self_model_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT,
    confidence REAL DEFAULT 1.0,
    domain TEXT,
    updated_ts INTEGER,
    source TEXT
  );

  CREATE TABLE IF NOT EXISTS architect_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    verdict TEXT,
    reason TEXT,
    delta TEXT,
    prompt_fragment TEXT,
    ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS architect_known_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT,
    repo TEXT,
    ingested_count INTEGER DEFAULT 0,
    ingestion_status TEXT DEFAULT 'pending',
    extracted_skills TEXT DEFAULT '[]',
    redundancy_score REAL DEFAULT 0,
    ts INTEGER,
    UNIQUE(owner, repo)
  );

  CREATE TABLE IF NOT EXISTS known_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT UNIQUE,
    domain TEXT,
    priority REAL DEFAULT 0.5,
    first_detected INTEGER,
    times_seen INTEGER DEFAULT 1,
    filled_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    level TEXT,
    reason TEXT,
    resolved INTEGER DEFAULT 0,
    resolution TEXT,
    ts INTEGER,
    expires_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    learned_count INTEGER DEFAULT 0,
    upgraded_count INTEGER DEFAULT 0,
    rejected_count INTEGER DEFAULT 0,
    gaps_remaining INTEGER DEFAULT 0,
    full_text TEXT
  );

  CREATE TABLE IF NOT EXISTS learned_signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    domain TEXT DEFAULT 'auto-discovered',
    source TEXT,
    confidence REAL DEFAULT 0.70,
    times_matched INTEGER DEFAULT 0,
    created_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS architect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT,
    action TEXT,
    reason TEXT,
    trigger_count INTEGER DEFAULT 0,
    auto_learned INTEGER DEFAULT 0,
    created_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

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

  CREATE TABLE IF NOT EXISTS pending_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT,
    original_content TEXT,
    proposed_content TEXT,
    swarm_run_id TEXT,
    status TEXT DEFAULT 'pending',
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS prompt_cache (
    id TEXT PRIMARY KEY,
    provider TEXT,
    model TEXT,
    prompt_hash TEXT,
    system_prompt_hash TEXT,
    response TEXT,
    created_at INTEGER,
    last_accessed_at INTEGER,
    access_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    description TEXT,
    created_at INTEGER,
    last_active_at INTEGER,
    is_active INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS phase_d_jobs (
    id TEXT PRIMARY KEY,
    issue_number INTEGER,
    payload TEXT,
    status TEXT DEFAULT 'pending',
    result_data TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS code_maps (
    id TEXT PRIMARY KEY,
    zip_name TEXT,
    topic_hint TEXT,
    code_map TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS ingestion_summaries (
    id TEXT PRIMARY KEY,
    zip_name TEXT,
    topic_hint TEXT,
    what_is_it TEXT,
    who_uses_it TEXT,
    core_flow TEXT,
    best_pattern TEXT,
    tech_stack TEXT,
    reviewer_summary TEXT,
    reviewer_verdict TEXT,
    suggested_skills TEXT,
    readme_verification TEXT,
    created_at INTEGER
  );

`);

try { db.exec('ALTER TABLE ingest_jobs ADD COLUMN progress_done INTEGER DEFAULT 0;'); } catch {}
try { db.exec('ALTER TABLE ingest_jobs ADD COLUMN progress_total INTEGER DEFAULT 0;'); } catch {}
try { db.exec('ALTER TABLE ingest_jobs ADD COLUMN retry_queue TEXT DEFAULT "[]";'); } catch {}
try { db.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, description TEXT, created_at INTEGER, last_active_at INTEGER, is_active INTEGER DEFAULT 0)'); } catch {}
// code_maps table migration
try { db.exec('CREATE TABLE IF NOT EXISTS code_maps (id TEXT PRIMARY KEY, zip_name TEXT, topic_hint TEXT, code_map TEXT, created_at INTEGER)'); } catch {}

// ingestion_summaries table
try { db.exec(`CREATE TABLE IF NOT EXISTS ingestion_summaries (id TEXT PRIMARY KEY, zip_name TEXT, topic_hint TEXT, what_is_it TEXT, who_uses_it TEXT, core_flow TEXT, best_pattern TEXT, tech_stack TEXT, reviewer_summary TEXT, reviewer_verdict TEXT, suggested_skills TEXT, readme_verification TEXT, created_at INTEGER)`); } catch {}

// Column-level migration for existing databases that have the table but lack readme_verification
try {
    const summCols = db.prepare("PRAGMA table_info(ingestion_summaries)").all().map(c => c.name);
    if (!summCols.includes('readme_verification')) {
        db.prepare("ALTER TABLE ingestion_summaries ADD COLUMN readme_verification TEXT DEFAULT NULL").run();
        console.log('[DB] Migration: ingestion_summaries.readme_verification added.');
    }
} catch(e) {
    console.warn('[DB] ingestion_summaries migration warning:', e.message);
}

// Phase B migrations
try {
    const existingCols = db.prepare("PRAGMA table_info(swarm_runs)").all().map(c => c.name);
    if (!existingCols.includes('quality_score'))    db.prepare("ALTER TABLE swarm_runs ADD COLUMN quality_score INTEGER DEFAULT NULL").run();
    if (!existingCols.includes('quality_feedback')) db.prepare("ALTER TABLE swarm_runs ADD COLUMN quality_feedback TEXT DEFAULT NULL").run();
    if (!existingCols.includes('retry_count'))      db.prepare("ALTER TABLE swarm_runs ADD COLUMN retry_count INTEGER DEFAULT 0").run();
    if (!existingCols.includes('prompt_category'))  db.prepare("ALTER TABLE swarm_runs ADD COLUMN prompt_category TEXT DEFAULT NULL").run();
    if (!existingCols.includes('topology_used'))    db.prepare("ALTER TABLE swarm_runs ADD COLUMN topology_used TEXT DEFAULT 'hierarchical'").run();
    // Phase D migrations
    if (!existingCols.includes('pr_url'))           db.prepare("ALTER TABLE swarm_runs ADD COLUMN pr_url TEXT DEFAULT NULL").run();
    if (!existingCols.includes('pr_number'))        db.prepare("ALTER TABLE swarm_runs ADD COLUMN pr_number INTEGER DEFAULT NULL").run();
    if (!existingCols.includes('issue_number'))     db.prepare("ALTER TABLE swarm_runs ADD COLUMN issue_number INTEGER DEFAULT NULL").run();
} catch (e) {
    console.warn("[DB] Swarm runs migrations warning:", e.message);
}

// ── Architect Known Repos migrations ────────────────────────────────────────
// CRITICAL: CREATE TABLE IF NOT EXISTS never adds new columns to existing tables.
// Must use ALTER TABLE for columns added after initial schema creation.
try {
    const archCols = db.prepare("PRAGMA table_info(architect_known_repos)").all().map(c => c.name);
    if (!archCols.includes('ingestion_status')) {
        db.prepare("ALTER TABLE architect_known_repos ADD COLUMN ingestion_status TEXT DEFAULT 'pending'").run();
        console.log("[DB] Migration applied: architect_known_repos.ingestion_status column added.");
    }
} catch (e) {
    console.warn("[DB] architect_known_repos migration warning:", e.message);
}

// ── Session State Wrapper ───────────────────────────────────────────────────────
const getSessionStmt = db.prepare('SELECT value FROM session_state WHERE key = ?');
const setSessionStmt = db.prepare('INSERT OR REPLACE INTO session_state (key, value) VALUES (?, ?)');

const dbSession = {
    get: (key, defaultValue) => {
        const row = getSessionStmt.get(key);
        return row ? JSON.parse(row.value) : defaultValue;
    },
    set: (key, value) => {
        setSessionStmt.run(key, JSON.stringify(value));
    }
};

// ── Ingest Queue Wrapper ────────────────────────────────────────────────────────
const insertJobStmt = db.prepare(`
    INSERT INTO ingest_jobs (id, url, label, status, processing_since, retries, timestamp)
    VALUES (@id, @url, @label, @status, @processing_since, @retries, @timestamp)
`);
const getPendingJobStmt = db.prepare(`
    SELECT * FROM ingest_jobs WHERE status = 'pending' ORDER BY timestamp ASC LIMIT 1
`);
const updateJobStatusStmt = db.prepare(`
    UPDATE ingest_jobs SET status = @status, processing_since = @processing_since WHERE id = @id
`);
const incrementJobRetryStmt = db.prepare(`
    UPDATE ingest_jobs SET retries = retries + 1, status = 'pending', processing_since = NULL WHERE id = @id
`);
const getAllJobsStmt = db.prepare(`SELECT * FROM ingest_jobs ORDER BY timestamp ASC`);

const queueDB = {
    addJob: (job) => {
        insertJobStmt.run({
            id: job.id,
            url: job.url,
            label: job.label || '',
            status: 'pending',
            processing_since: null,
            retries: 0,
            timestamp: Date.now()
        });
    },
    getNextPending: () => getPendingJobStmt.get(),
    markProcessing: (id) => updateJobStatusStmt.run({ id, status: 'processing', processing_since: Date.now() }),
    markDone: (id) => updateJobStatusStmt.run({ id, status: 'done', processing_since: null }),
    markFailed: (id) => updateJobStatusStmt.run({ id, status: 'failed', processing_since: null }),
    retryJob: (id) => incrementJobRetryStmt.run({ id }),
    getAll: () => getAllJobsStmt.all(),
    
    updateProgress: (id, done, total, retryQueue) => {
        db.prepare('UPDATE ingest_jobs SET progress_done = ?, progress_total = ?, retry_queue = ? WHERE id = ?')
          .run(done, total, JSON.stringify(retryQueue || []), id);
    },
    
    // Watchdog to rescue stuck jobs
    rescueStuckJobs: () => {
        const thirtyMinsAgo = Date.now() - 30 * 60 * 1000;
        const resetStmt = db.prepare(`
            UPDATE ingest_jobs 
            SET status = 'pending', processing_since = NULL 
            WHERE status = 'processing' AND processing_since < ?
        `);
        const info = resetStmt.run(thirtyMinsAgo);
        if (info.changes > 0) {
            console.log(`[DB Watchdog] Rescued ${info.changes} stuck ingest job(s).`);
        }
    },

    resetFailedJobs: () => {
        const info = db.prepare("UPDATE ingest_jobs SET status = 'pending' WHERE status = 'failed'").run();
        console.log(`[DB] Reset ${info.changes} failed jobs to pending.`);
        return info.changes;
    },

    clearAllJobs: () => {
        const info = db.prepare("DELETE FROM ingest_jobs").run();
        console.log(`[DB] Cleared all ${info.changes} jobs from queue.`);
        return info.changes;
    }
};

// ── Registry Wrappers (Bots & Skills) ──────────────────────────────────────────
const botsDB = {
    getAll: () => db.prepare('SELECT data FROM bots').all().map(r => JSON.parse(r.data)),
    saveAll: (bots) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO bots (name, data) VALUES (?, ?)');
        const tx = db.transaction((bList) => {
            for (const b of bList) stmt.run(b.name, JSON.stringify(b));
        });
        tx(bots);
    }
};

const skillsDB = {
    getAll: () => db.prepare('SELECT data FROM skills').all().map(r => JSON.parse(r.data)),
    saveAll: (skills) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO skills (tag, data) VALUES (?, ?)');
        const tx = db.transaction((sList) => {
            // Optional: delete all first to sync exactly
            db.prepare('DELETE FROM skills').run();
            for (const s of sList) stmt.run(s.tag, JSON.stringify(s));
        });
        tx(skills);
    }
};

const stagingSkillsDB = {
    getAll: () => db.prepare('SELECT data FROM staging_skills').all().map(r => JSON.parse(r.data)),
    saveAll: (skills) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO staging_skills (id, status, data) VALUES (?, ?, ?)');
        const tx = db.transaction((sList) => {
            db.prepare('DELETE FROM staging_skills').run();
            for (const s of sList) stmt.run(s.id, s.status, JSON.stringify(s));
        });
        tx(skills);
    }
};

const capabilityIndexDB = {
    get: () => {
        const rows = db.prepare('SELECT intent, value FROM capability_index').all();
        const index = {};
        for (const row of rows) index[row.intent] = JSON.parse(row.value);
        return index;
    },
    save: (index) => {
        const stmt = db.prepare('INSERT OR REPLACE INTO capability_index (intent, value) VALUES (?, ?)');
        const tx = db.transaction((entries) => {
            for (const [intent, val] of entries) stmt.run(intent, JSON.stringify(val));
        });
        tx(Object.entries(index));
    }
};

const rateLimitDB = {
    isAllowed: (ip, endpoint, maxRequests, windowMs) => {
        const now = Date.now();
        const cutoff = now - windowMs;
        
        // Prune old entries
        db.prepare('DELETE FROM rate_limit_log WHERE timestamp < ?').run(cutoff);
        
        // Count recent requests
        const count = db.prepare('SELECT COUNT(*) as count FROM rate_limit_log WHERE ip = ? AND endpoint = ? AND timestamp >= ?').get(ip, endpoint, cutoff).count;
        
        if (count >= maxRequests) return false;
        
        // Log new request
        db.prepare('INSERT INTO rate_limit_log (ip, endpoint, timestamp) VALUES (?, ?, ?)').run(ip, endpoint, now);
        return true;
    }
};

const usersDB = {
    getByUsername: (username) => {
        return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    },
    createUser: (username, passwordHash) => {
        return db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
                 .run(username, passwordHash, new Date().toISOString());
    },
    getUserCount: () => {
        return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    }
};

const settingsDB = {
    get: (key, defaultValue) => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : defaultValue;
    },
    set: (key, value) => {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    }
};

const pendingChangesDB = {
    addPendingChange: (filePath, originalContent, proposedContent, swarmRunId) => {
        return db.prepare(`
            INSERT INTO pending_changes (file_path, original_content, proposed_content, swarm_run_id, status, timestamp)
            VALUES (?, ?, ?, ?, 'pending', ?)
        `).run(filePath, originalContent, proposedContent, swarmRunId, Date.now()).lastInsertRowid;
    },
    getPendingChange: (id) => {
        return db.prepare('SELECT * FROM pending_changes WHERE id = ?').get(id);
    },
    getAllPending: () => {
        return db.prepare("SELECT * FROM pending_changes WHERE status = 'pending'").all();
    },
    updateStatus: (id, status) => {
        return db.prepare('UPDATE pending_changes SET status = ? WHERE id = ?').run(status, id);
    },
    clearAll: () => {
        return db.prepare('DELETE FROM pending_changes').run();
    }
};

const swarmRunsDB = {
    create: (id, prompt, agentsUsed) => {
        return db.prepare(`
            INSERT INTO swarm_runs (id, prompt, agents_used, started_at, status)
            VALUES (?, ?, ?, ?, 'running')
        `).run(id, prompt, JSON.stringify(agentsUsed), Date.now());
    },
    update: (id, resultSummary, filesChanged, status) => {
        return db.prepare(`
            UPDATE swarm_runs 
            SET completed_at = ?, result_summary = ?, files_changed = ?, status = ?
            WHERE id = ?
        `).run(Date.now(), resultSummary, filesChanged, status, id);
    },
    getAll: (limit = 20, offset = 0) => {
        return db.prepare('SELECT * FROM swarm_runs ORDER BY started_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    },
    getById: (id) => {
        return db.prepare('SELECT * FROM swarm_runs WHERE id = ?').get(id);
    },
    delete: (id) => {
        return db.prepare("UPDATE swarm_runs SET status = 'deleted' WHERE id = ?").run(id);
    },
    setQuality: (id, score, feedback) => {
        return db.prepare(`
            UPDATE swarm_runs
            SET quality_score = ?, quality_feedback = ?
            WHERE id = ?
        `).run(score, feedback, id);
    },
    incrementRetry: (id) => {
        return db.prepare(`
            UPDATE swarm_runs SET retry_count = retry_count + 1 WHERE id = ?
        `).run(id);
    },
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
    getBestTopology: (category) => {
        const row = db.prepare(`
            SELECT topology_used, AVG(quality_score) as avg_score, COUNT(*) as run_count
            FROM swarm_runs
            WHERE quality_score IS NOT NULL
              AND prompt_category = ?
            GROUP BY topology_used
            HAVING run_count >= 3
            ORDER BY avg_score DESC
            LIMIT 1
        `).get(category);
        return row ? row.topology_used : null;
    }
};

// ── Prompt Cache Wrapper ──────────────────────────────────────────────────────
const promptCacheDB = {
    get: (promptHash, systemPromptHash, provider, model) => {
        const stmt = db.prepare(`
            SELECT * FROM prompt_cache 
            WHERE prompt_hash = ? AND system_prompt_hash = ? AND provider = ? AND model = ?
        `);
        const row = stmt.get(promptHash, systemPromptHash, provider, model);
        if (row) {
            db.prepare('UPDATE prompt_cache SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?')
              .run(Date.now(), row.id);
        }
        return row;
    },
    set: (id, promptHash, systemPromptHash, provider, model, response) => {
        const stmt = db.prepare(`
            INSERT INTO prompt_cache (id, prompt_hash, system_prompt_hash, provider, model, response, created_at, last_accessed_at, access_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        return stmt.run(id, promptHash, systemPromptHash, provider, model, response, Date.now(), Date.now());
    },
    clearAll: () => {
        return db.prepare('DELETE FROM prompt_cache').run();
    },
    getStats: () => {
        return db.prepare('SELECT COUNT(*) as count, SUM(access_count) as hits FROM prompt_cache').get();
    }
};

// ── Workspaces Wrapper ────────────────────────────────────────────────────────
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

// ── Phase D Job Queue Wrapper ──────────────────────────────────────────────────
const phaseDJobsDB = {
    addJob: (id, issue_number, payload) => {
        const existing = db.prepare("SELECT * FROM phase_d_jobs WHERE issue_number = ? AND status IN ('pending', 'processing')").get(issue_number);
        if (existing) return false;

        db.prepare(`
            INSERT INTO phase_d_jobs (id, issue_number, payload, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
        `).run(id, issue_number, JSON.stringify(payload), Date.now(), Date.now());
        return true;
    },
    getNextPending: () => {
        return db.prepare("SELECT * FROM phase_d_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").get();
    },
    updateStatus: (id, status, resultData = null) => {
        if (resultData) {
            return db.prepare("UPDATE phase_d_jobs SET status = ?, result_data = ?, updated_at = ? WHERE id = ?")
                     .run(status, JSON.stringify(resultData), Date.now(), id);
        }
        return db.prepare("UPDATE phase_d_jobs SET status = ?, updated_at = ? WHERE id = ?")
                 .run(status, Date.now(), id);
    },
    getById: (id) => db.prepare("SELECT * FROM phase_d_jobs WHERE id = ?").get(id)
};

const pushSubscriptionsDB = {
    save: (id, endpoint, p256dh, auth) => {
        return db.prepare(`
            INSERT OR REPLACE INTO push_subscriptions (id, endpoint, p256dh, auth, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, endpoint, p256dh, auth, Date.now(), Date.now());
    },
    getAll: () => {
        return db.prepare('SELECT * FROM push_subscriptions').all();
    },
    remove: (endpoint) => {
        return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    }
};

const trainingFeedbackDatasetDB = {
    insert: (id, prompt, swarm_output, score, feedback, issues) => {
        return db.prepare(`
            INSERT INTO training_feedback_dataset (id, prompt, swarm_output, score, feedback, issues, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, prompt, swarm_output, score, feedback, JSON.stringify(issues), Date.now());
    },
    getAll: () => db.prepare('SELECT * FROM training_feedback_dataset ORDER BY timestamp DESC').all(),
    getCount: () => db.prepare('SELECT COUNT(*) as cnt FROM training_feedback_dataset').get().cnt
};

module.exports = {
    db,
    dbSession,
    queueDB,
    botsDB,
    skillsDB,
    stagingSkillsDB,
    capabilityIndexDB,
    rateLimitDB,
    usersDB,
    settingsDB,
    pendingChangesDB,
    swarmRunsDB,
    promptCacheDB,
    workspacesDB,
    phaseDJobsDB,
    pushSubscriptionsDB,
    trainingFeedbackDatasetDB
};


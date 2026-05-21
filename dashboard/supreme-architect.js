'use strict';
// ── Supreme Architect: Self-Aware Governor Bot ────────────────────────────────
// Tier 1 authority — evaluates all incoming repo ingestion jobs,
// maintains Pavi's self-model, gates upgrades, and generates daily briefings.

const path = require('path');
const fs = require('fs');

let _db;
function getDb() { if (!_db) _db = require('./db').db; return _db; }

const TTL = 6 * 60 * 60 * 1000; // self-model refreshes every 6h

// Pavi's hardcoded baseline capabilities (born-with knowledge)
const BASELINE = [
    { key: 'multi-key-rotation',         kw: ['key rotation','api key pool','rate limit failover'],        domain: 'infra',    conf: 0.95 },
    { key: 'sse-mobile-sync',            kw: ['server-sent events','sse','mobile sync','event stream'],    domain: 'infra',    conf: 0.95 },
    { key: 'agentdb-vector-memory',      kw: ['vector database','agentdb','embedding','semantic search'],  domain: 'data',     conf: 0.95 },
    { key: 'singularity-loop',           kw: ['self upgrade','singularity loop','arena mutation'],         domain: 'infra',    conf: 0.95 },
    { key: 'github-ingestion',           kw: ['github ingestion','repo ingestion','file tree','github api'],domain:'data',     conf: 0.95 },
    { key: 'worker-reviewer-dual-model', kw: ['worker model','reviewer model','dual model'],               domain: 'ai',      conf: 0.95 },
    { key: 'swarm-orchestration',        kw: ['swarm','multi-agent','agent spawn','claude-flow'],          domain: 'ai',      conf: 0.90 },
    { key: 'shield-neutrality',          kw: ['shield','neutrality','bias detection','prompt injection'],  domain: 'security', conf: 0.90 },
    { key: 'pattern-memory',             kw: ['pattern memory','bloom filter','deduplication'],            domain: 'data',     conf: 0.90 },
    { key: 'ngrok-tunnel',               kw: ['ngrok','tunnel','public url','qr code'],                   domain: 'infra',    conf: 0.90 },
    { key: 'sqlite-persistence',         kw: ['sqlite','better-sqlite3','wal mode'],                       domain: 'data',     conf: 0.95 },
    { key: 'zip-ingestion',              kw: ['zip upload','archive extraction','brain dump'],              domain: 'data',     conf: 0.90 },
    { key: 'skills-system',              kw: ['skills.json','skill extraction','skill tag'],               domain: 'ai',       conf: 0.90 },
    { key: 'intake-filter',              kw: ['intake filter','domain score','quarantine'],                domain: 'security', conf: 0.85 },
    { key: 'local-bot-ollama',           kw: ['local bot','ollama','local llm','offline model'],          domain: 'ai',       conf: 0.85 },
];

// ── 1. Self-model management ─────────────────────────────────────────────────
async function loadSelfModel() {
    const db = getDb();
    const meta = db.prepare("SELECT updated_ts FROM self_model_snapshot WHERE key='_meta'").get();
    if (!meta || (Date.now() - meta.updated_ts) > TTL) await _regenerate(db);
    return _read(db);
}

function _read(db) {
    const caps = db.prepare("SELECT key,value,confidence,domain FROM self_model_snapshot WHERE key!='_meta'").all()
        .map(r => ({ key: r.key, confidence: r.confidence, domain: r.domain, kw: JSON.parse(r.value || '[]') }));
    const gaps  = db.prepare("SELECT feature,domain,priority,times_seen FROM known_gaps WHERE filled_ts IS NULL").all();
    const repos = db.prepare("SELECT owner,repo,ingested_count,ts FROM architect_known_repos ORDER BY ts DESC LIMIT 50").all();
    return { capabilities: caps, gaps, knownRepos: repos };
}

async function _regenerate(db) {
    const upsert = db.prepare(`
        INSERT INTO self_model_snapshot (key,value,confidence,domain,updated_ts,source)
        VALUES (@key,@value,@confidence,@domain,@ts,@source)
        ON CONFLICT(key) DO UPDATE SET value=@value,confidence=MAX(confidence,@confidence),
          domain=@domain,updated_ts=@ts,source=@source
    `);
    const tx = db.transaction(() => {
        for (const c of BASELINE)
            upsert.run({ key: c.key, value: JSON.stringify(c.kw), confidence: c.conf, domain: c.domain, ts: Date.now(), source: 'baseline' });
        try {
            const sp = path.join(__dirname, 'skills.json');
            if (fs.existsSync(sp))
                JSON.parse(fs.readFileSync(sp, 'utf8')).forEach(s =>
                    upsert.run({ key:`skill:${s.tag}`, value: JSON.stringify([s.description||'']), confidence: 0.85, domain: 'skill', ts: Date.now(), source: 'skills.json' })
                );
        } catch(e) {}

        // ── Inject live absorbed repos from patternMemory.repoStats ──────────
        // This closes the gap where repos absorbed via zip or prior sessions
        // are not reflected in the self-model, causing false-low redundancy scores.
        try {
            const pm = require('./pattern-memory');
            const stats = pm && pm.repoStats ? pm.repoStats : {};
            for (const [repoKey, info] of Object.entries(stats)) {
                // repoKey format: "owner/repo"
                const files  = typeof info === 'object' ? (info.files || 0) : 0;
                const hits   = typeof info === 'object' ? (info.hits  || 0) : 0;
                // Confidence scales with how much we've absorbed: more files + hits = more confident
                const conf   = Math.min(0.92, 0.60 + Math.log1p(files) * 0.04 + Math.log1p(hits) * 0.02);
                const kws    = repoKey.split(/[\/\-_]/).filter(Boolean); // "owner", "repo" as keywords
                upsert.run({ key: `ingested:${repoKey}`, value: JSON.stringify(kws), confidence: conf, domain: 'absorbed', ts: Date.now(), source: 'pattern-memory' });
            }
        } catch(e) { /* pattern-memory not installed — non-fatal */ }
        // ── End patternMemory injection ────────────────────────────────────────
        
        // ── Inject active plugins as capabilities ───────────────────────────────
        try {
            const pluginLoader = require('./services/plugin-loader');
            const plugins = pluginLoader.getLoadedPlugins();
            for (const p of plugins) {
                if (p.status === 'active') {
                    upsert.run({
                        key: `plugin:${p.id}`,
                        value: JSON.stringify([p.name, p.description]),
                        confidence: 0.90,
                        domain: 'plugin',
                        ts: Date.now(),
                        source: 'plugin-loader'
                    });
                }
            }
        } catch(e) {}

        upsert.run({ key:'_meta', value:'{}', confidence:1, domain:'meta', ts:Date.now(), source:'system' });
    });
    tx();
}

// ── 2. Delta computation ─────────────────────────────────────────────────────
function computeDelta(rawFeatures, selfModel) {
    const focus=[], skip=[], review=[];
    for (const feat of rawFeatures) {
        const fl = feat.toLowerCase();
        let best = 0, bestKey = null;
        for (const cap of selfModel.capabilities) {
            const kws = Array.isArray(cap.kw) ? cap.kw : [];
            const hits = kws.filter(k => fl.includes(k.toLowerCase())).length;
            if (hits === 0 && !fl.includes(cap.key.replace(/-/g,' '))) continue;
            const score = fl.includes(cap.key.replace(/-/g,' ')) ? 0.95
                        : Math.min(0.88, 0.3 + (hits / Math.max(kws.length,1)) * 0.6);
            if (score > best) { best = score; bestKey = cap.key; }
        }
        if      (best >= 0.8) skip.push({ feature: feat, confidence: best, matched: bestKey });
        else if (best >= 0.4) review.push({ feature: feat, confidence: best, matched: bestKey });
        else                  focus.push({ feature: feat, confidence: best });
    }
    return { focus, skip, review, redundancyScore: rawFeatures.length > 0 ? skip.length / rawFeatures.length : 0 };
}

// ── 3. Decide ────────────────────────────────────────────────────────────────
function decide(delta, signal = {}) {
    const risks = _detectRisks(signal);
    if (risks.length > 0)
        return { verdict:'ESCALATE', reason:`Risk flags: ${risks.join(', ')}`, level:'WARN', riskFlags: risks };
    
    const discovered = delta.focus
        .map(f => f.feature)
        .filter(feat => feat.startsWith('[DISCOVER:'));
    if (discovered.length > 0) {
        const tokens = discovered.map(d => d.replace('[DISCOVER:', '').replace(']', ''));
        return {
            verdict: 'DISCOVER',
            reason: `Auto-extracted ${tokens.length} new domain token(s) — learning: ${tokens.join(', ')}`,
            discovered: tokens
        };
    }

    // Check if this repo was ever actually ingested (content absorbed, not just name discovered)
    // If it was never ingested, override REJECT — we only know the name, not the content.
    const repoKey = signal.owner && signal.repo ? `${signal.owner}/${signal.repo}` : null;
    let neverActuallyIngested = false;
    if (repoKey) {
        try {
            const db = getDb();
            const known = db.prepare("SELECT ingestion_status FROM architect_known_repos WHERE owner=? AND repo=?").get(signal.owner, signal.repo);
            neverActuallyIngested = !known || known.ingestion_status !== 'complete';
        } catch (_) {}
    }

    if (delta.redundancyScore > 0.9 && delta.focus.length === 0) {
        if (neverActuallyIngested) {
            return { verdict:'APPROVE', reason:`Overriding redundancy gate — repo was discovered but never fully ingested. ${delta.skip.length} known pattern(s) will be deepened.` };
        }
        return { verdict:'REJECT', reason:`${Math.round(delta.redundancyScore*100)}% redundant — no new gaps found.` };
    }
    if (delta.focus.length === 0 && delta.review.length === 0) {
        if (neverActuallyIngested) {
            return { verdict:'APPROVE', reason:`No new gaps detected but repo content was never absorbed. Allowing ingestion.` };
        }
        return { verdict:'REJECT', reason:'No capability gaps identified.' };
    }
    return { verdict:'APPROVE', reason:`${delta.focus.length} gap(s) to focus, ${delta.review.length} to review.` };
}

function _detectRisks(sig) {
    const t = JSON.stringify(sig).toLowerCase();
    const flags = [];
    if (/delete|drop table|truncate|rm -rf/.test(t)) flags.push('destructive-op');
    if (/password|private.?key|oauth.?token/.test(t)) flags.push('auth-sensitive');
    if (/eval\(|exec\(.*shell/.test(t)) flags.push('code-exec-risk');
    return flags;
}

// ── 4. Build focused prompt fragment ────────────────────────────────────────
function buildPromptFragment(delta) {
    let f = '\n\n━━━ ARCHITECT DIRECTIVE (MANDATORY) ━━━\n';
    if (delta.skip.length)   f += `SKIP (Pavi already knows): ${delta.skip.map(s=>s.feature).slice(0,8).join(' | ')}\n`;
    if (delta.focus.length)  f += `FOCUS ON (genuine gaps): ${delta.focus.map(s=>s.feature).slice(0,8).join(' | ')}\n`;
    if (delta.review.length) f += `FLAG FOR REVIEW: ${delta.review.map(s=>s.feature).slice(0,5).join(' | ')}\n`;
    return f + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
}

// ── 5. evaluateRepo — main drainQueue gate ───────────────────────────────────
async function evaluateRepo({ owner, repo, fileList = [] }) {
    const db = getDb();
    const rules = require('./architect-rules');

    const ruleHit = rules.checkRules({ owner, repo, fileList });
    if (ruleHit.blocked) {
        _log(db, `${owner}/${repo}`, 'REJECT', ruleHit.reason, {}, '');
        return { verdict:'REJECT', reason: ruleHit.reason };
    }

    const known = db.prepare("SELECT ingested_count FROM architect_known_repos WHERE owner=? AND repo=?").get(owner, repo);
    if (known && known.ingested_count > 0) {
        // Allow re-ingestion if explicitly requested (e.g. via UI retry button)
        if (!fileList._forceReIngest) {
            const r = `Already ingested ${known.ingested_count} files from ${owner}/${repo}.`;
            _log(db, `${owner}/${repo}`, 'REJECT', r, {}, '');
            rules.learnFromDecision({ verdict:'REJECT', reason: r });
            return { verdict:'REJECT', reason: r };
        }
        console.log(`[SUPREME-ARCHITECT] Force re-ingest requested for ${owner}/${repo}. Clearing stale record.`);
        db.prepare("DELETE FROM architect_known_repos WHERE owner=? AND repo=?").run(owner, repo);
    }

    const rawFeatures = _inferFeatures(fileList);
    const selfModel = await loadSelfModel();
    const delta = computeDelta(rawFeatures, selfModel);
    const decision = decide(delta, { owner, repo });
    const fragment = (decision.verdict === 'APPROVE' || decision.verdict === 'DISCOVER') ? buildPromptFragment(delta) : '';

    _log(db, `${owner}/${repo}`, decision.verdict, decision.reason, delta, fragment);
    rules.learnFromDecision({ verdict: decision.verdict, reason: decision.reason });

    if (decision.verdict === 'DISCOVER') {
        await _autoLearnDomain(decision.discovered, `${owner}/${repo}`);
    }

    if (decision.verdict === 'APPROVE') {
        const gUp = db.prepare("INSERT OR IGNORE INTO known_gaps (feature,domain,priority,first_detected,times_seen) VALUES (?,?,?,?,1)");
        for (const f of delta.focus) gUp.run(f.feature, 'unknown', 0.5, Date.now());
    }
    if (decision.verdict === 'ESCALATE') {
        db.prepare("INSERT INTO escalations (job_id,level,reason,ts,expires_ts) VALUES (?,?,?,?,?)")
          .run(`${owner}/${repo}`, decision.level||'WARN', decision.reason, Date.now(), Date.now()+48*3600000);
    }

    return { ...decision, delta, promptFragment: fragment };
}

function _loadLearnedSignatures() {
    try {
        return getDb().prepare('SELECT pattern, label FROM learned_signatures').all();
    } catch (_) { return []; }
}

function _extractRawDomain(files) {
    const stopwords = new Set([
        'src','lib','index','main','test','js','ts','json','md','txt','config',
        'utils','helpers','types','models','services','routes','components',
        'pages','assets','dist','build','package','readme','license','node',
        'modules','data','api','http','https','www','com','get','set','new',
        'run','use','app','init','base','core','common','shared'
    ]);
    const tokens = new Map();
    for (const fp of files) {
        const clean = fp.toLowerCase().replace(/\.(js|ts|py|c|h|cpp|rs|go|java|rb|php|swift|kt|dart|ino|hex|bin|elf)$/, '');
        const parts = clean.split(/[\/\-_. ]/);
        for (const part of parts) {
            // Support alphanumeric tokens (e.g. esp32, i2c) containing at least one letter, min length 3
            if (part.length >= 3 && !stopwords.has(part) && /^[a-z0-9]+$/.test(part) && /[a-z]/.test(part)) {
                tokens.set(part, (tokens.get(part) || 0) + 1);
            }
        }
    }
    const minOccurrences = files.length < 15 ? 1 : 2;
    return [...tokens.entries()]
        .filter(([, count]) => count >= minOccurrences)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([token]) => token);
}

async function _autoLearnDomain(discoveredTokens, source) {
    const db = getDb();
    
    // 1. Persist each token as a new learned signature in SQLite
    const sigInsert = db.prepare(`
        INSERT OR IGNORE INTO learned_signatures (pattern, label, domain, source, confidence, created_ts)
        VALUES (?, ?, 'auto-discovered', ?, 0.70, ?)
    `);
    // 2. Add each token to self_model_snapshot as a new capability
    const capUpsert = db.prepare(`
        INSERT INTO self_model_snapshot (key, value, confidence, domain, updated_ts, source)
        VALUES (@key, @value, @confidence, @domain, @ts, @source)
        ON CONFLICT(key) DO UPDATE SET
            value=@value, confidence=MAX(confidence, @confidence), updated_ts=@ts
    `);
    
    const tx = db.transaction(() => {
        for (const token of discoveredTokens) {
            sigInsert.run(token, `${token} domain`, source, Date.now());
            capUpsert.run({
                key:        `discovered:${token}`,
                value:      JSON.stringify([token]),
                confidence: 0.70,
                domain:     'auto-discovered',
                ts:         Date.now(),
                source
            });
        }
    });
    tx();
    
    // 3. Store the domain knowledge in pattern memory asynchronously in the background
    try {
        const patternMemory = require('./pattern-memory');
        const knowledgeSummary = `Domain: ${discoveredTokens.join(', ')}. Source: ${source}`;
        patternMemory.store(`discovery:${source}`, knowledgeSummary, `auto-discovered:${discoveredTokens.slice(0,5).join(',')}`)
            .catch(() => {});
    } catch (_) {}
}

function _inferFeatures(files) {
    const SIGS = [
        [/calendar|gcal|google.calendar/,  'google calendar integration'],
        [/voice|speech|stt|tts|whisper/,   'voice input / speech recognition'],
        [/payment|stripe|billing/,          'payment processing'],
        [/auth|login|oauth|jwt/,            'authentication system'],
        [/docker|kubernetes|k8s/,           'containerization'],
        [/graphql|resolver/,               'graphql api'],
        [/websocket|socket\.io/,            'websocket realtime'],
        [/redis|cache|memcache/,            'caching layer'],
        [/jest|vitest|cypress|playwright/,  'automated testing'],
        [/\.github.workflows|github.actions/, 'ci/cd pipeline'],
        [/bull|job.queue|worker.queue/,    'background job queue'],
        [/pinecone|qdrant|weaviate/,        'external vector database'],
        [/i18n|locale|translation\.json/,   'internationalization'],
        [/analytics|telemetry|mixpanel/,    'analytics/telemetry'],
        [/smtp|sendgrid|mailgun|nodemailer/,'email sending'],
        [/react.native|flutter|expo/,       'mobile application'],
        [/spend|billing|cost.track/,        'cost tracking'],
    ];
    const feats = new Set();
    
    // Stage 1: Check hardcoded rules
    for (const fp of files) {
        const l = fp.toLowerCase();
        for (const [re, label] of SIGS) if (re.test(l)) feats.add(label);
    }
    
    // Stage 2: Check dynamically learned rules from DB
    const learned = _loadLearnedSignatures();
    for (const fp of files) {
        const l = fp.toLowerCase();
        for (const sig of learned) {
            try {
                if (new RegExp(sig.pattern, 'i').test(l)) {
                    feats.add(sig.label);
                }
            } catch (_) {}
        }
    }
    
    // Stage 3: If still nothing, auto-extract raw domain tokens
    if (feats.size === 0 && files.length > 0) {
        const discovered = _extractRawDomain(files);
        for (const d of discovered) {
            feats.add(`[DISCOVER:${d}]`);
        }
    }
    
    return [...feats];
}

function _log(db, jobId, verdict, reason, delta, fragment) {
    try {
        db.prepare("INSERT INTO architect_decisions (job_id,verdict,reason,delta,prompt_fragment,ts) VALUES (?,?,?,?,?,?)")
          .run(jobId, verdict, reason, JSON.stringify(delta), fragment, Date.now());
    } catch(e) {}
}

// ── 6. updateModel — call after successful ingest ───────────────────────────
async function updateModel({ owner, repo, extractedSkills=[], ingestedCount=0 }) {
    const db = getDb();
    db.prepare(`
        INSERT INTO architect_known_repos (owner,repo,ingested_count,extracted_skills,ts)
        VALUES (?,?,?,?,?)
        ON CONFLICT(owner,repo) DO UPDATE SET ingested_count=ingested_count+?,extracted_skills=?,ts=?
    `).run(owner, repo, ingestedCount, JSON.stringify(extractedSkills), Date.now(),
           ingestedCount, JSON.stringify(extractedSkills), Date.now());
    for (const s of extractedSkills)
        db.prepare("UPDATE known_gaps SET filled_ts=? WHERE feature LIKE ?").run(Date.now(), `%${s}%`);
    db.prepare("UPDATE self_model_snapshot SET updated_ts=0 WHERE key='_meta'").run();
}

// ── 7. evaluateUpgrade — gates Arena ────────────────────────────────────────
function evaluateUpgrade(proposal) {
    const pl = proposal.toLowerCase();
    const safe = !/delete|drop |truncate|rm -rf|format c:/.test(pl);
    const conflicts = [];
    if (/auth|key|token|password/.test(pl)) conflicts.push('touches auth/credentials — needs review');
    if (/server\.js|db\.js|orchestrator\.js/.test(pl)) conflicts.push('touches core files — staged rollout');
    return { safe, conflicts, recommendation: !safe ? 'BLOCK' : conflicts.length ? 'REVIEW' : 'SAFE' };
}

// ── 8. generateBriefing — daily summary ─────────────────────────────────────
async function generateBriefing(broadcast) {
    const db = getDb();
    const today = new Date().toISOString().slice(0,10);
    const dayAgo = Date.now() - 86400000;
    const d = db.prepare("SELECT verdict FROM architect_decisions WHERE ts>?").all(dayAgo);
    const learned   = d.filter(x=>x.verdict==='APPROVE').length;
    const rejected  = d.filter(x=>x.verdict==='REJECT').length;
    const escalated = d.filter(x=>x.verdict==='ESCALATE').length;
    const gaps      = db.prepare("SELECT COUNT(*) as c FROM known_gaps WHERE filled_ts IS NULL").get().c;
    const upgrades  = db.prepare("SELECT COUNT(*) as c FROM architect_decisions WHERE verdict='UPGRADE_APPLIED' AND ts>?").get(dayAgo).c;
    const text = `📋 Briefing ${today}\n✅ Learned: ${learned} | ❌ Rejected: ${rejected} | ⚠️ Escalated: ${escalated} | ⚙️ Upgrades: ${upgrades} | 🔍 Open gaps: ${gaps}`;
    db.prepare("INSERT INTO briefings (date,learned_count,upgraded_count,rejected_count,gaps_remaining,full_text) VALUES (?,?,?,?,?,?)")
      .run(today, learned, upgrades, rejected, gaps, text);
    if (typeof broadcast === 'function') broadcast('architect_briefing', { text, learned, rejected, escalated, upgrades, gaps });
    console.log(`[SUPREME-ARCHITECT] ${text}`);
    return { text, learned, rejected, escalated, upgrades, gaps };
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function getSelfModel() {
    const db = getDb();
    const caps = db.prepare("SELECT key,value,confidence,domain,source FROM self_model_snapshot WHERE key!='_meta'").all();
    const gaps = db.prepare("SELECT * FROM known_gaps WHERE filled_ts IS NULL ORDER BY priority DESC").all();
    const repos = db.prepare("SELECT owner,repo,ingested_count,ts FROM architect_known_repos ORDER BY ts DESC").all();
    const decisions = db.prepare("SELECT verdict,reason,ts FROM architect_decisions ORDER BY ts DESC LIMIT 20").all();
    const escalations = db.prepare("SELECT * FROM escalations WHERE resolved=0").all();
    return { capabilities:caps, gaps, knownRepos:repos, recentDecisions:decisions, pendingEscalations:escalations };
}

function resolveEscalation(id, resolution) {
    getDb().prepare("UPDATE escalations SET resolved=1,resolution=? WHERE id=?").run(resolution, id);
    return { ok:true };
}

function manageGap({ action, feature, domain='unknown', priority=0.5 }) {
    const db = getDb();
    if (action==='add')    db.prepare("INSERT OR IGNORE INTO known_gaps (feature,domain,priority,first_detected,times_seen) VALUES (?,?,?,?,1)").run(feature, domain, priority, Date.now());
    if (action==='remove') db.prepare("UPDATE known_gaps SET filled_ts=? WHERE feature=?").run(Date.now(), feature);
    return { ok:true };
}

function startMidnightCron(broadcast) {
    const next = () => {
        const n=new Date(), t=new Date(n); t.setUTCHours(0,0,0,0); if(t<=n) t.setUTCDate(t.getUTCDate()+1);
        setTimeout(async()=>{ try{await generateBriefing(broadcast);}catch(e){} next(); }, t-n);
        console.log(`[SUPREME-ARCHITECT] Next briefing in ${Math.round((t-n)/3600000)}h`);
    };
    next();
}

/**
 * Run the nightly knowledge consolidation pass.
 * - Merges skills with >80% tag similarity
 * - Demotes skills unused for >30 days
 * - Promotes skills used >10 times with >90% success
 * - Generates a daily health report
 */
async function nightlyConsolidation() {
    console.log('[SUPREME_ARCHITECT] 🌙 Starting nightly knowledge consolidation...');
    const db = getDb();
    const now = Date.now();
    const STALE_DAYS = 30;
    
    // 1. Demote stale skills (not used in 30 days)
    const allSkillRows = db.prepare("SELECT * FROM self_model_snapshot WHERE source='skills.json'").all();
    let demoted = 0;
    for (const row of allSkillRows) {
        if (!row.updated_ts) continue;
        const daysSinceUpdate = (now - row.updated_ts) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate > STALE_DAYS && row.confidence > 0.50) {
            db.prepare("UPDATE self_model_snapshot SET confidence=confidence*0.95 WHERE key=?").run(row.key);
            demoted++;
        }
    }
    
    // 2. Rescore quarantined repos
    const { rescoreQuarantine } = require('./intake-filter');
    const graduated = rescoreQuarantine();
    if (graduated.length > 0) {
        console.log(`[SUPREME_ARCHITECT] 🎓 ${graduated.length} quarantined repos graduated to ingest queue`);
    }
    
    // 3. Auto-promote battle-tested staged skills (used >= 10 times with >= 90% success)
    let promotedCount = 0;
    try {
        const skillWriter = require('./skill-writer');
        const stagedSkills = skillWriter.getStagedSkills('staged');
        for (const skill of stagedSkills) {
            const usage = skill.usageCount || 0;
            const success = skill.successCount || 0;
            if (usage >= 10 && (success / usage) >= 0.90) {
                const res = skillWriter.promote(skill.id);
                if (res.success) {
                    promotedCount++;
                }
            }
        }
    } catch (e) {
        console.error(`[SUPREME_ARCHITECT] Failed to auto-promote staged skills: ${e.message}`);
    }
    
    // 4. Generate health report
    const caps = db.prepare("SELECT COUNT(*) as n FROM self_model_snapshot WHERE key!='_meta'").get();
    const gaps = db.prepare("SELECT COUNT(*) as n FROM known_gaps WHERE filled_ts IS NULL").get();
    
    console.log(`[SUPREME_ARCHITECT] ✅ Nightly consolidation complete:`);
    console.log(`   Skills demoted: ${demoted} | Skills promoted: ${promotedCount} | Repos graduated: ${graduated.length}`);
    console.log(`   Total capabilities: ${caps.n} | Open gaps: ${gaps.n}`);
    
    return { demoted, promoted: promotedCount, graduated: graduated.length, totalCaps: caps.n, openGaps: gaps.n };
}

module.exports = { loadSelfModel, computeDelta, decide, buildPromptFragment, evaluateRepo, updateModel, evaluateUpgrade, generateBriefing, getSelfModel, resolveEscalation, manageGap, startMidnightCron, nightlyConsolidation };

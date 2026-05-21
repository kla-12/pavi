const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { queueDB, settingsDB } = require('../db');
const { SESSION, sessionBroadcast, sessionLog, withSessionLock, saveSession } = require('./session');

// Helper to extract GitHub rate limit headers
function extractRateLimit(res) {
    if (res && res.headers && res.headers.has('x-ratelimit-remaining')) {
        try {
            settingsDB.set('github_rate_limit', {
                remaining: parseInt(res.headers.get('x-ratelimit-remaining') || '0', 10),
                limit: parseInt(res.headers.get('x-ratelimit-limit') || '0', 10),
                reset: parseInt(res.headers.get('x-ratelimit-reset') || '0', 10),
                ts: Date.now()
            });
        } catch (e) {}
    }
}

// Exponential backoff helper
async function fetchWithBackoff(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            extractRateLimit(res);
            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
                const wait = Math.max(retryAfter * 1000, Math.pow(2, attempt) * 1000);
                console.warn(`[QUEUE] GitHub rate limited. Waiting ${wait}ms before retry ${attempt + 1}/${maxRetries}`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            return res;
        } catch (err) {
            if (attempt === maxRetries) throw err;
            const wait = Math.pow(2, attempt) * 500;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw new Error(`fetchWithBackoff: max retries (${maxRetries}) exceeded for ${url}`);
}

let patternMemory;
try { patternMemory = require('../pattern-memory'); } catch (e) { patternMemory = null; }

const supremeArchitect = require('../supreme-architect');

let gapDetector = null;
try { gapDetector = require('../gap-detector'); } catch (e) {}
let skillWriter = null;
try { skillWriter = require('../skill-writer'); } catch (e) {}
let intakeFilter = null;
try { intakeFilter = require('../intake-filter'); } catch (e) {}
let compressionEngine = null;
try { compressionEngine = require('../compression-engine'); } catch (e) {}

const WORKER_ID = `${process.pid}-${Date.now()}`;
let queueRunning = false;
let queueLockOwner = null;
let drainScheduled = false;

function acquireQueueLock() {
    if (queueRunning) return false;
    queueRunning = true;
    queueLockOwner = WORKER_ID;
    return true;
}

function releaseQueueLock() {
    queueRunning = false;
    queueLockOwner = null;
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

async function drainQueue() {
    if (!acquireQueueLock()) return;
    drainScheduled = false;
    const job = queueDB.getNextPending();
    if (!job) {
        releaseQueueLock();
        return;
    }

    await yieldToEventLoop();

    queueDB.markProcessing(job.id);
    const queue = queueDB.getAll();
    sessionBroadcast('queue_update', { queue, activeJob: job });

    let { url, owner, repo, branch, label, forceFlush } = job;
    // DB rows only store `url` — parse owner/repo/branch if missing
    if (!owner || !repo) {
        const ghMatch = (url || '').match(/github\.com\/([^/]+)\/([^/\s?#]+)(?:\/tree\/([^/\s?#]+))?/);
        if (ghMatch) {
            owner = owner || ghMatch[1];
            repo  = repo  || ghMatch[2].replace(/\.git$/, '');
            branch = branch || ghMatch[3] || 'HEAD';
        }
    }
    if (!branch) branch = 'HEAD';
    const emit = (type, data) => sessionBroadcast(type, { jobId: job.id, ...data });

    try {
        emit('start', { owner, repo, branch });
        await withSessionLock(async () => {
            SESSION.status = 'learning';
            SESSION.currentTask = `Learning: ${owner}/${repo}`;
            sessionBroadcast('session', { status: 'learning', currentTask: SESSION.currentTask });
        });

        if (forceFlush && patternMemory) {
            patternMemory.flushRepo(owner, repo);
        }

        const ghHeaders = { 'User-Agent': 'Pavi-AI/1.0' };
        try {
            const configPath = path.join(__dirname, '..', 'config.json');
            const ghToken = process.env.GITHUB_TOKEN ||
                (fs.existsSync(configPath)
                    ? JSON.parse(fs.readFileSync(configPath, 'utf8')).gh_token
                    : null);
            if (ghToken) ghHeaders['Authorization'] = `Bearer ${ghToken}`;
        } catch (e) {}

        let treeData = null;
        const branchSet = new Set([branch, 'main', 'master', 'HEAD']);
        const repoApiUrl = `https://api.github.com/repos/${owner}/${repo}`;
        try {
            emit('progress', { step: `Checking repository: ${owner}/${repo}...` });
            const repoRes = await fetch(repoApiUrl, { 
                headers: ghHeaders,
                signal: AbortSignal.timeout(10000)
            });
            extractRateLimit(repoRes);
            if (repoRes.status === 404) {
                throw new Error(`Repository not found: github.com/${owner}/${repo}`);
            }
            if (repoRes.ok) {
                const repoInfo = await repoRes.json();
                if (repoInfo.default_branch) branchSet.add(repoInfo.default_branch);
                emit('progress', { step: `Default branch: ${repoInfo.default_branch}. Fetching file tree...` });
            }
        } catch (e) {
            if (e.message.includes('not found')) throw e;
            console.warn('[DRAIN-QUEUE] Pre-flight repo check failed:', e.message);
        }

        const branchesToTry = Array.from(branchSet).filter(Boolean);
        for (const b of branchesToTry) {
            const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${b}?recursive=1`;
            emit('progress', { step: `Fetching file tree (branch: ${b})...` });

            let treeRes;
            try {
                treeRes = await fetch(treeUrl, { 
                    headers: ghHeaders,
                    signal: AbortSignal.timeout(10000)
                });
                extractRateLimit(treeRes);
            } catch (netErr) {
                throw new Error(`Network error fetching tree: ${netErr.message}`);
            }

            if (treeRes.status === 200) {
                treeData = await treeRes.json();
                branch = b;
                break;
            }
        }

        if (!treeData) throw new Error(`Could not find repository tree on any branch tried: ${branchesToTry.join(', ')}. The repository may be empty, private, or the branch name is non-standard.`);
        
        const allFiles = treeData.tree || [];
        const ALLOWED_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.md', '.json', '.yaml', '.yml', '.toml', '.env.example', '.sh']);
        const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'vendor', 'coverage']);
        const ALWAYS = new Set(['README.md', 'readme.md', 'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
        const MAX_INGEST_FILES = 1000;

        const learnable = allFiles.filter(f => {
            if (f.type !== 'blob') return false;
            const parts = f.path.split('/');
            if (parts.some(p => SKIP_DIRS.has(p))) return false;
            const name = path.basename(f.path);
            const ext = path.extname(name).toLowerCase();
            if (ALWAYS.has(name)) return true;
            if (!ALLOWED_EXT.has(ext)) return false;
            if ((f.size || 0) > 51200) return false;
            return true;
        }).slice(0, MAX_INGEST_FILES);

        if (intakeFilter) {
            emit('progress', { step: 'Running passive domain intake gate...' });
            
            let codeContext = '';
            const sampleFiles = learnable.filter(f => {
                const name = path.basename(f.path).toLowerCase();
                const ext = path.extname(name);
                return name === 'readme.md' || name === 'package.json' || ['.js', '.ts', '.py', '.go', '.rs'].includes(ext);
            }).slice(0, 5);

            for (const file of sampleFiles) {
                try {
                    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
                    const fileRes = await fetch(rawUrl, { headers: { 'User-Agent': 'Pavi-AI/1.0' }, signal: AbortSignal.timeout(5000) });
                    if (fileRes.ok) {
                        const text = await fileRes.text();
                        codeContext += `\n--- FILE: ${file.path} ---\n` + text.slice(0, 10000);
                    }
                } catch (e) {}
                if (codeContext.length > 50000) break;
            }
            codeContext = codeContext.slice(0, 50000);

            const gateResult = intakeFilter.gate(`github.com/${owner}/${repo}`, learnable.map(f => f.path), codeContext, label || '');
            
            emit('progress', { step: gateResult.notification });

            if (gateResult.outcome === 'rejected') {
                queueDB.markFailed(job.id);
                sessionBroadcast('queue_update', { queue: queueDB.getAll(), activeJob: null });
                throw new Error(`Repository intake rejected: ${gateResult.reason}`);
            }

            if (gateResult.outcome === 'quarantine') {
                queueDB.markDone(job.id);
                sessionBroadcast('queue_update', { queue: queueDB.getAll(), activeJob: null });
                await withSessionLock(async () => {
                    SESSION.status = 'idle';
                    saveSession();
                });
                emit('ingest_done', { owner, repo, ingested: 0, failed: 0, total: learnable.length, quarantined: true, reason: gateResult.reason });
                return;
            }
        }

        emit('architect_evaluating', { step: `Architect evaluating ${owner}/${repo}...` });
        let architectFragment = '';
        try {
            const filePaths = learnable.map(f => f.path);
            const archDecision = await supremeArchitect.evaluateRepo({ owner, repo, fileList: filePaths });
            if (archDecision.verdict === 'REJECT') {
                emit('architect_reject', { reason: archDecision.reason });
                console.log(`[SUPREME-ARCHITECT] REJECT ${owner}/${repo}: ${archDecision.reason}`);
                queueDB.markDone(job.id);
                const rejectErr = new Error(`Architect REJECT: ${archDecision.reason}`);
                rejectErr.isArchitectReject = true;
                throw rejectErr;
            }
            if (archDecision.verdict === 'ESCALATE') {
                emit('architect_escalate', { reason: archDecision.reason, level: archDecision.level });
                console.warn(`[SUPREME-ARCHITECT] ESCALATE ${owner}/${repo}: ${archDecision.reason}`);
                queueRunning = false;
                return;
            }
            architectFragment = archDecision.promptFragment || '';
            emit('architect_approve', { focus: archDecision.delta?.focus?.length || 0, skip: archDecision.delta?.skip?.length || 0 });
        } catch (archErr) {
            if (archErr.isArchitectReject) throw archErr;
            console.warn('[SUPREME-ARCHITECT] Evaluation error (non-fatal, proceeding):', archErr.message);
        }

        emit('ingest_progress', { step: `Found ${learnable.length} learnable files. Queueing ingestion...`, total: learnable.length, done: 0 });

        let ingested = 0;
        let failedCount = 0;
        const memory = require('../memory');
        
        let retryQueue = [];
        try { if (job.retry_queue) retryQueue = JSON.parse(job.retry_queue); } catch (e) {}
        ingested = job.progress_done || 0;
        
        let startIdx = ingested;
        const targetFiles = learnable.slice(startIdx);
        
        // Use p-limit for controlled concurrency
        const limit = pLimit(10);
        let completedSinceLastUpdate = 0;

        const promises = targetFiles.map(file => limit(async () => {
            try {
                const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
                const fileRes = await fetchWithBackoff(rawUrl, { headers: ghHeaders });
                if (!fileRes.ok) { retryQueue.push(file); failedCount++; return; }
                const content = await fileRes.text();

                const ext = path.extname(file.path).toLowerCase();
                if (ext === '.js' || ext === '.mjs') {
                    if (compressionEngine) {
                        const validation = compressionEngine.validateLocally(content);
                        if (!validation.valid) {
                            emit('warning', { reason: 'syntax-invalid', file: file.path, errors: validation.errors });
                        }
                    }
                }

                const safePathHash = Buffer.from(file.path).toString('base64url').replace(/=/g, '');
                const tag = `$github-${owner}-${repo}-${safePathHash}`;
                
                let storeOk = false;
                if (patternMemory) {
                    await memory.storeCompressed(tag, content, `${owner}/${repo}:${file.path}`);
                    patternMemory.trackRepoFile(owner, repo);
                    storeOk = true;
                } else {
                    storeOk = await memory.storeSkill(tag, `GitHub: ${owner}/${repo}/${file.path}`, content.slice(0, 500));
                }
                
                if (!storeOk) emit('warning', { reason: 'vector-index-unavailable', file: file.path });
                
                ingested++;
                completedSinceLastUpdate++;
                emit('ingest_progress', { step: `Learning: ${file.path}`, done: ingested, total: learnable.length });

                // Periodic DB updates so we don't spam it or lose all progress
                if (completedSinceLastUpdate >= 20) {
                    completedSinceLastUpdate = 0;
                    queueDB.updateProgress(job.id, ingested, learnable.length, retryQueue);
                }
            } catch (e) { retryQueue.push(file); failedCount++; }
        }));

        await Promise.allSettled(promises);
        queueDB.updateProgress(job.id, ingested, learnable.length, retryQueue);

        if (retryQueue.length > 0) {
            emit('ingest_progress', { step: `Retrying ${retryQueue.length} failed files...`, done: ingested, total: learnable.length });
            const retries = [...retryQueue];
            retryQueue.length = 0;
            const retryPromises = retries.map(file => limit(async () => {
                try {
                    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
                    const fileRes = await fetchWithBackoff(rawUrl, { headers: ghHeaders });
                    if (!fileRes.ok) return;
                    const content = await fileRes.text();

                    const ext = path.extname(file.path).toLowerCase();
                    if (ext === '.js' || ext === '.mjs') {
                        if (compressionEngine) {
                            const validation = compressionEngine.validateLocally(content);
                            if (!validation.valid) {
                                emit('warning', { reason: 'syntax-invalid', file: file.path, errors: validation.errors });
                            }
                        }
                    }

                    const safePathHash = Buffer.from(file.path).toString('base64url').replace(/=/g, '');
                    const tag = `$github-${owner}-${repo}-${safePathHash}`;
                    if (patternMemory) {
                        await memory.storeCompressed(tag, content, `${owner}/${repo}:${file.path}`);
                        patternMemory.trackRepoFile(owner, repo);
                    } else {
                        await memory.storeSkill(tag, `GitHub: ${owner}/${repo}/${file.path}`, content.slice(0, 500));
                    }
                    ingested++; failedCount--;
                    emit('ingest_progress', { step: `Learning (retry): ${file.path}`, done: ingested, total: learnable.length });
                } catch (e) { }
            }));
            await Promise.allSettled(retryPromises);
        }

        const ingestTimestamp = Date.now();
        const summaryTag = `$github-repo-${owner}-${repo}-${ingestTimestamp}`;
        await memory.storeSkill(summaryTag, `GitHub repo: ${owner}/${repo}`, `Learned ${ingested} files from github.com/${owner}/${repo} at ${new Date(ingestTimestamp).toISOString()}.`);
        await memory.storeSkill(`$github-repo-${owner}-${repo}-latest`, `GitHub repo: ${owner}/${repo} (latest)`, `Latest ingestion: ${ingested} files at ${new Date(ingestTimestamp).toISOString()}.`);

        try {
            await supremeArchitect.updateModel({ owner, repo, extractedSkills: [], ingestedCount: ingested });
        } catch (e) { console.warn('[SUPREME-ARCHITECT] updateModel failed (non-fatal):', e.message); }

        try {
            if (gapDetector && skillWriter) {
                emit('progress', { step: 'Analyzing learned repositories for capability gaps...' });
                const detection = gapDetector.detect();
                if (detection.newGaps.length > 0) {
                    const stagingResults = skillWriter.processGaps();
                    emit('progress', { step: `Detected ${detection.newGaps.length} new gaps. Staged ${stagingResults.filter(r => r.success).length} skills.` });
                } else {
                    emit('progress', { step: 'Capability gap analysis complete: all intents are covered.' });
                }
            }
        } catch (e) {
            console.warn('[SERVER] Gap detection or skill writing failed:', e.message);
        }

        await withSessionLock(async () => {
            SESSION.status = 'idle';
            SESSION.currentTask = '';
            SESSION.lastLearnedRepo = { owner, repo, label, ingested, ts: Date.now() };
            saveSession();
            sessionBroadcast('session', { status: 'idle', currentTask: '', lastLearnedRepo: SESSION.lastLearnedRepo });
        });
        emit('ingest_done', { owner, repo, ingested, failed: failedCount, total: learnable.length });
        
        try {
            const pushNotifications = require('./push-notifications');
            pushNotifications.broadcastNotification({
                title: 'Ingestion Complete',
                body: `Successfully learned ${ingested} files from github.com/${owner}/${repo}!`,
                url: '/mobile',
                tag: 'ingest-complete'
            });
        } catch (pushErr) {
            console.error('[QUEUE] Push notification failed:', pushErr.message);
        }

        queueDB.markDone(job.id);
        sessionBroadcast('queue_update', { queue: queueDB.getAll(), activeJob: null });
    } catch (e) {
        if (e.isArchitectReject) {
            console.log(`[DRAIN-QUEUE] Job ${job.id} rejected by Architect.`);
        } else {
            console.error('[DRAIN-QUEUE] Fatal error:', e);
            emit('error', { message: e.message });
            await withSessionLock(async () => {
                SESSION.status = 'idle';
                saveSession();
            });
            queueDB.markFailed(job.id);
        }
        sessionBroadcast('queue_update', { queue: queueDB.getAll(), activeJob: null });
    } finally {
        releaseQueueLock();
        if (!drainScheduled) {
            drainScheduled = true;
            setTimeout(() => {
                drainQueue().catch(e => {
                    console.error('[DRAIN-QUEUE] Unexpected loop error:', e.message);
                    drainScheduled = false;
                    releaseQueueLock();
                });
            }, 1000);
        }
    }
}

function triggerQueueDrain() {
    if (!drainScheduled) {
        drainScheduled = true;
        setImmediate(() => drainQueue());
    }
}

module.exports = {
    triggerQueueDrain,
    drainQueue,
    get queueRunning() { return queueRunning; },
    get queueLockOwner() { return queueLockOwner; }
};

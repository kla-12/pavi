/**
 * swarm-orchestrator.js
 * Pavi Swarm Orchestration Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides two public utilities:
 *   1. isComplexPrompt(text)      → boolean  (keyword / length heuristic)
 *   2. spawnSwarm(objective, opts) → Promise<{output, bots}>
 */

'use strict';

const { exec } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const { swarmRunsDB, db, workspacesDB } = require('./db');
const reviewer = require('./services/reviewer');

const activeSwarms = new Map();

let docker = null;
try {
    const Dockerode = require('dockerode');
    docker = new Dockerode();
} catch (e) {
    console.warn("[SANDBOX] Dockerode load failed, container sandbox is disabled:", e.message);
}

// ── Complex-prompt detection keywords ────────────────────────────────────────
const SWARM_KEYWORDS = [
    // Testing
    'test', 'testing', 'unit test', 'integration test', 'e2e', 'coverage',
    // Building / deployment
    'build', 'deploy', 'deployment', 'ci', 'cd', 'pipeline', 'release', 'publish',
    // Full-stack / architectural
    'full stack', 'fullstack', 'scaffold', 'architect', 'architecture', 'refactor',
    'migrate', 'migration', 'upgrade', 'overhaul',
    // Security / performance
    'security audit', 'audit', 'pentest', 'performance', 'optimise', 'optimize',
    // Multi-file / complex
    'multiple files', 'entire project', 'whole project', 'all files',
    'documentation', 'readme', 'api docs'
];

// Minimum word count that also triggers swarm mode
const WORD_COUNT_THRESHOLD = 40;

// Simple prompts that should bypass the swarm even if they contain keywords or are long
const SIMPLE_PREFIXES = [
    'what is', 'how to', 'explain', 'tell me', 'can you', 'where is', 'why is'
];

/**
 * Decide whether a prompt should trigger swarm orchestration based on recall scope.
 */
async function isComplexPrompt(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase().trim();
    
    if (SIMPLE_PREFIXES.some(prefix => lower.startsWith(prefix))) {
        return false;
    }

    // 1. Recall Scope Check (Gap 5 proper fix)
    try {
        const patternMemory = require('./pattern-memory');
        if (patternMemory && patternMemory.recall) {
            const results = await patternMemory.recall(text, 6);
            const sources = new Set();

            for (const res of results) {
                // We stored the repo source in res.metadata.source during ingestion:
                if (res.metadata && typeof res.metadata.source === 'string') {
                    const repoPrefix = res.metadata.source.split(':')[0]; // Extracts owner/repo
                    if (repoPrefix) sources.add(repoPrefix);
                }
            }
            
            // If the query requires synthesizing across multiple repos -> swarm
            if (sources.size > 1) {
                return true;
            }
        }
    } catch(_e) {
        // Silently fallback if pattern memory isn't available
    }

    // 2. Keyword & Heuristic Fallback
    if (SWARM_KEYWORDS.some(kw => lower.includes(kw))) return true;
    const wordCount = lower.split(/\s+/).length;
    if (wordCount >= WORD_COUNT_THRESHOLD) return true;
    return false;
}

// ── Valid claude-flow agent types ─────────────────────────────────────────────
const VALID_CF_TYPES = new Set([
    'coder', 'researcher', 'tester', 'reviewer', 'architect', 'coordinator',
    'analyst', 'optimizer', 'security-architect', 'security-auditor',
    'memory-specialist', 'swarm-specialist', 'performance-engineer',
    'core-architect', 'test-architect'
]);

// Map custom/shorthand roles → valid claude-flow types
const ROLE_MAP = {
    'security':    'security-auditor',
    'audit':       'security-auditor',
    'sec':         'security-auditor',
    'performance': 'performance-engineer',
    'perf':        'performance-engineer',
    'memory':      'memory-specialist',
    'swarm':       'swarm-specialist',
    'core':        'core-architect',
    'test':        'test-architect',
    'analysis':    'analyst',
    'optimize':    'optimizer',
    'devops':      'coder',
    'backend':     'coder',
    'frontend':    'coder',
    'ui':          'coder',
    'api':         'coder',
};

/** Normalize a bot role to a valid claude-flow agent type. */
function normalizeRole(role) {
    if (!role) return 'coder';
    const lower = role.toLowerCase();
    if (VALID_CF_TYPES.has(lower)) return lower;
    return ROLE_MAP[lower] || 'coder';
}

/**
 * Load the registered bots and derive swarm agent spawns from active ones.
 * @returns {{ spawns: string[], bots: object[] }}
 */
function buildAgentSpawns(objective, maxAgents = 8) {
    const botsPath = path.join(__dirname, 'bots.json');
    const defaultBots = [
        { name: 'arch',     role: 'architect' },
        { name: 'coder',    role: 'coder'     },
        { name: 'tester',   role: 'tester'    },
        { name: 'reviewer', role: 'reviewer'  }
    ];
    const defaultSpawns = defaultBots.map(b =>
        `npx claude-flow agent spawn --type ${b.role} --name pavi-${b.name}`
    );

    try {
        if (!fs.existsSync(botsPath)) return { spawns: defaultSpawns, bots: defaultBots };
        const bots = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
        const active = bots.filter(b => b.active !== false);
        if (active.length === 0) return { spawns: defaultSpawns, bots: defaultBots };

        // Prioritize bots that match the user's objective
        const lowerObj = (objective || '').toLowerCase();
        active.sort((a, b) => {
            let scoreA = 0, scoreB = 0;
            if (a.role && lowerObj.includes(a.role))                 scoreA += 5;
            if (a.language && lowerObj.includes(a.language))         scoreA += 5;
            if (a.name && lowerObj.includes(a.name.toLowerCase()))   scoreA += 2;
            if (b.role && lowerObj.includes(b.role))                 scoreB += 5;
            if (b.language && lowerObj.includes(b.language))         scoreB += 5;
            if (b.name && lowerObj.includes(b.name.toLowerCase()))   scoreB += 2;
            return scoreB - scoreA;
        });

        const selected = active.slice(0, maxAgents);

        const spawns = selected.map((b, i) => {
            const cfType = normalizeRole(b.role);
            const safeName = (b.name || `bot-${i}`).replace(/[^a-zA-Z0-9-]/g, '-');
            return `npx claude-flow agent spawn --type ${cfType} --name pavi-${safeName}`;
        });

        return { spawns, bots: selected };
    } catch (e) {
        return { spawns: defaultSpawns, bots: defaultBots };
    }
}

class CircuitBreaker {
    constructor(failureThreshold, cooldownMs) {
        this.failureThreshold = failureThreshold;
        this.cooldownMs = cooldownMs;
        this.failures = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    }

    async fire(action) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.cooldownMs) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error(`Circuit is OPEN. Swarm orchestration is temporarily disabled due to repeated failures. Cooldown remaining: ${Math.ceil((this.cooldownMs - (Date.now() - this.lastFailureTime))/1000)}s`);
            }
        }

        try {
            const result = await action();
            // Success
            this.failures = 0;
            this.state = 'CLOSED';
            return result;
        } catch (e) {
            this.failures++;
            this.lastFailureTime = Date.now();
            if (this.failures >= this.failureThreshold) {
                this.state = 'OPEN';
            }
            throw e;
        }
    }
}

const swarmBreaker = new CircuitBreaker(3, 60000); // 3 failures = 60s cooldown

/**
 * Run a claude-flow swarm for the given objective via a temporary batch script.
 * Includes a circuit breaker to prevent cascading timeouts.
 */
function spawnSwarm(objective, opts = {}) {
    return swarmBreaker.fire(() => new Promise(async (resolve, reject) => {
        const maxAgents = opts.maxAgents || 8;
        const strategy  = opts.strategy  || 'development';
        
        let workspaceCwd = opts.cwd;
        if (!workspaceCwd) {
            try {
                const activeWS = workspacesDB.getActive();
                workspaceCwd = activeWS ? activeWS.root_path : path.join(__dirname, '..');
            } catch {
                workspaceCwd = path.join(__dirname, '..');
            }
        }
        const cwd = workspaceCwd;

        const { spawns, bots } = buildAgentSpawns(objective, maxAgents);

        const runId = opts.runId || `swarm_${Date.now()}`;
        
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

        try {
            swarmRunsDB.create(runId, objective, bots.map(b => b.name));
            db.prepare('UPDATE swarm_runs SET topology_used = ?, prompt_category = ? WHERE id = ?')
              .run(topology, promptCategory, runId);
        } catch (dbErr) {
            console.error('[SWARM] Failed to log swarm run creation:', dbErr.message);
        }

        let enrichedObjective = typeof objective === 'string' ? objective : (objective.objective || 'Automated task');
        let planObject = typeof objective === 'object' ? objective : null;

        if (planObject) {
            enrichedObjective = `[PHASE D CI/CD PLAN]\n\n${JSON.stringify(planObject, null, 2)}`;
            console.log('[SWARM_PLANNER] Structured plan object received, skipping local Ollama pre-plan.');
        } else {
            try {
                console.log('[SWARM_PLANNER] Generating technical pre-plan with local Ollama...');
                const localBot2 = require('./local-bot');
                const planningPrompt = `You are Pavi's Local Swarm Planner. 
The user wants to achieve this objective:
"${objective}"

Prepare a structured, step-by-step technical execution plan for the swarm agents. 
Identify potential files to modify, architectural patterns to use, security precautions, and testing strategies. 
Keep it concise, actionable, and structured as a set of TODO items.`;

                const plan = await localBot2.call(planningPrompt, 'worker', 'You are a master software architect. Prepare clear technical plans.', 1000);
                if (plan) {
                    enrichedObjective = `${objective}\n\n[LOCAL OLLAMA PRE-PLAN]:\n${plan}`;
                    console.log('[SWARM_PLANNER] Pre-plan successfully generated and merged.');
                    try {
                        swarmRunsDB.update(runId, `[OLLAMA PRE-PLAN]\n${plan}`, 0, 'running');
                    } catch (dbUpdateErr) {
                        console.warn('[SWARM_PLANNER] Could not persist plan to swarmRunsDB:', dbUpdateErr.message);
                    }
                }
            } catch (planErr) {
                console.warn('[SWARM_PLANNER] Failed to generate pre-plan, falling back to original objective:', planErr.message);
            }
        }


        // Build temporary script
        const isWin    = process.platform === 'win32';
        const tmpDir   = path.join(__dirname, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const scriptPath = path.join(tmpDir, `swarm_${Date.now()}${isWin ? '.bat' : '.sh'}`);

        // Escape objective for shell
        const safeObjective = enrichedObjective.replace(/"/g, '\\"').replace(/\n/g, ' ');

        let script = '';
        if (isWin) {
            script  = '@echo off\r\n';
            script += `call npx claude-flow swarm init --topology ${topology} --max-agents ${maxAgents}\r\n`;
            spawns.forEach(s => { script += `call ${s}\r\n`; });
            script += `call npx claude-flow swarm start --objective "${safeObjective}" --strategy ${strategy}\r\n`;
        } else {
            script  = '#!/bin/bash\n';
            script += `npx claude-flow swarm init --topology ${topology} --max-agents ${maxAgents}\n`;
            spawns.forEach(s => { script += `${s}\n`; });
            script += `npx claude-flow swarm start --objective "${safeObjective}" --strategy ${strategy}\n`;
        }

        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        console.log(`[SWARM] Launching via script: ${scriptPath}`);

        const globalTimeout = 300_000; // 5 min cap
        const safetyTimer = setTimeout(() => {
            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
            reject(new Error('Swarm timed out after 5 minutes.'));
        }, globalTimeout);

        // 1. Verify if Docker Daemon is Online/Active
        let useDocker = false;
        if (docker) {
            try {
                await docker.ping();
                useDocker = true;
            } catch (e) {
                // Docker is offline or stopped
            }
        }

        // 2. If Docker is active, execute swarm inside secure Docker sandbox container
        if (useDocker) {
            try {
                console.log("[SANDBOX] Docker daemon active. Bootstrapping containerized swarm sandbox...");
                const hostCwd = path.resolve(cwd);
                const containerName = `pavi-swarm-sandbox-${Date.now()}`;

                // Determine best available image (pre-built sandbox first, generic fallback)
                let sandboxImage = 'node:18-slim';
                try {
                    const images = await docker.listImages({ filters: { reference: ['pavi-swarm-sandbox'] } });
                    if (images && images.length > 0) sandboxImage = 'pavi-swarm-sandbox';
                } catch {}
                console.log(`[SANDBOX] Using image: ${sandboxImage}`);

                const container = await docker.createContainer({
                    name: containerName,
                    Image: sandboxImage,
                    Cmd: ['/bin/sh', '-c', `cd /workspace && sh dashboard/tmp/${path.basename(scriptPath)}`],
                    HostConfig: {
                        Binds: [
                            `${hostCwd}:/workspace:ro`,          // Project root — READ ONLY
                            `${path.join(__dirname, 'tmp')}:/workspace/dashboard/tmp:rw` // Only tmp is writable
                        ],
                        NetworkMode: 'host',
                        // ── Resource limits ──────────────────────────────
                        NanoCpus: 1_000_000_000,    // 1 CPU core max
                        Memory: 512 * 1024 * 1024,  // 512 MB RAM max
                        MemorySwap: 512 * 1024 * 1024, // No swap beyond RAM
                        PidsLimit: 128,             // Max 128 processes
                        // ── Filesystem hardening ─────────────────────────
                        ReadonlyRootfs: sandboxImage === 'pavi-swarm-sandbox', // Only if we control the image
                        Tmpfs: { '/tmp': 'size=64m,mode=1777' }, // Small /tmp in memory
                        CapDrop: ['ALL'],            // Drop all Linux capabilities
                        SecurityOpt: ['no-new-privileges:true']
                    },
                    Env: [
                        'NODE_ENV=production',
                        'PAVI_CONTAINER_SANDBOX=true',
                        `PAVI_SWARM_RUN_ID=${runId}`
                    ]
                });

                await container.start();
                activeSwarms.set(runId, { type: 'docker', container, scriptPath });
                const result = await container.wait();
                activeSwarms.delete(runId);
                if (result && result.StatusCode !== 0) {
                    throw new Error(`Container exited with non-zero code: ${result.StatusCode}`);
                }

                const logStream = await container.logs({ stdout: true, stderr: true });
                let rawLogs = logStream.toString('utf8');
                // Strip Docker multiplex headers
                rawLogs = rawLogs.replace(/[\u0000-\u001F]/g, '').trim();

                await container.remove();

                clearTimeout(safetyTimer);
                if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

                const finalOutput = `[SANDBOX-CONTAINER] Docker container sandbox activated (image: ${sandboxImage}).\n\n✅ Swarm completed:\n${rawLogs || 'No output captured.'}`;
                try {
                    swarmRunsDB.update(runId, (rawLogs || '').substring(0, 500), 0, 'completed');
                } catch {}

                // ── Phase B: Quality Evaluation ───────────────────────────────────────
                const currentRetryCount = (() => {
                    try { return swarmRunsDB.getById(runId)?.retry_count || 0; } catch { return 0; }
                })();

                const { score, feedback, shouldRetry } = await reviewer.evaluateOutput(objective, finalOutput);

                if (score !== null) {
                    try { swarmRunsDB.setQuality(runId, score, feedback); } catch (_e) {}
                    console.log(`[REVIEWER] Quality score: ${score}/100 — ${feedback}`);
                    if (score >= 80) {
                        reviewer.persistTopologyLearning(promptCategory, topology, score, objective).catch(() => {});
                    }
                }

                // Auto-retry if score is below threshold and retries remain
                if (shouldRetry && currentRetryCount < reviewer.MAX_RETRIES && !opts._isRetry) {
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

                try {
                    const pushNotifications = require('./services/push-notifications');
                    pushNotifications.broadcastNotification({
                        title: 'Swarm Done',
                        body: `Quality Score: ${score || 'N/A'}/100. Objective: ${enrichedObjective.substring(0, 80)}...`,
                        url: '/mobile',
                        tag: 'swarm-done'
                    });
                } catch (pushErr) {
                    console.error('[SWARM] Push notification failed:', pushErr.message);
                }

                resolve({
                    output: finalOutput,
                    bots
                });
                return;
            } catch (containerErr) {
                console.warn("[SANDBOX-WARNING] Docker sandbox container launch failed. Falling back to native sandbox:", containerErr.message);
            }
        }

        // 3. Graceful native local execution fallback with sensitive credentials scrubbed
        console.log("[SANDBOX] Activating secure native local sandbox fallback (Docker offline/unreachable)...");
        const scrubbedEnv = { ...process.env };
        const SENSITIVE_KEYS = [
            'JWT_SECRET', 'JWT_KEY', 'SESSION_SECRET', 'COOKIE_SECRET',
            'GITHUB_TOKEN', 'API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
            'GEMINI_API_KEY', 'STRIPE_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'
        ];
        SENSITIVE_KEYS.forEach(key => {
            delete scrubbedEnv[key];
        });
        
        scrubbedEnv.PAVI_SWARM_RUN_ID = runId;

        const child = exec(isWin ? `"${scriptPath}"` : `/bin/bash "${scriptPath}"`, { cwd, env: scrubbedEnv }, async (err, stdout, stderr) => {
            activeSwarms.delete(runId);
            clearTimeout(safetyTimer);
            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

            const output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const sandboxWarning = `[SANDBOX-WARNING] Docker is offline/inactive. Swarm running in native fallback sandbox. Environment sanitized (sensitive keys scrubbed).`;

            if (err) {
                console.warn(`[SWARM] Execution failed:`, err.message);
                try {
                    swarmRunsDB.update(runId, output.substring(0, 500) || err.message, 0, 'failed');
                } catch {}
                reject(new Error(`${sandboxWarning}\n\nSwarm completed with errors:\n${output || err.message}`));
                return;
            }

            try {
                swarmRunsDB.update(runId, output.substring(0, 500) || 'Success', 0, 'completed');
            } catch {}

            const finalOutput = `${sandboxWarning}\n\n✅ Swarm completed:\n${output || 'No output captured.'}`;

            // ── Phase B: Quality Evaluation ───────────────────────────────────────
            const currentRetryCount = (() => {
                try { return swarmRunsDB.getById(runId)?.retry_count || 0; } catch { return 0; }
            })();

            const { score, feedback, shouldRetry } = await reviewer.evaluateOutput(objective, finalOutput);

            if (score !== null) {
                try { swarmRunsDB.setQuality(runId, score, feedback); } catch (_e) {}
                console.log(`[REVIEWER] Quality score: ${score}/100 — ${feedback}`);
                if (score >= 80) {
                    reviewer.persistTopologyLearning(promptCategory, topology, score, objective).catch(() => {});
                }
            }

            // Auto-retry if score is below threshold and retries remain
            if (shouldRetry && currentRetryCount < reviewer.MAX_RETRIES && !opts._isRetry) {
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

            try {
                const pushNotifications = require('./services/push-notifications');
                pushNotifications.broadcastNotification({
                    title: 'Swarm Done',
                    body: `Quality Score: ${score || 'N/A'}/100. Objective: ${enrichedObjective.substring(0, 80)}...`,
                    url: '/mobile',
                    tag: 'swarm-done'
                });
            } catch (pushErr) {
                console.error('[SWARM] Push notification failed:', pushErr.message);
            }

            resolve({
                runId,
                output: finalOutput,
                bots
            });
        });

        activeSwarms.set(runId, { type: 'native', child, scriptPath });
    })).catch(err => {
        return { runId, output: `⚠️ ${err.message}`, bots: [] };
    });
}

function getCircuitStatus() {
    return {
        failures: swarmBreaker.failures,
        tripped: swarmBreaker.state === 'OPEN',
        resetAt: swarmBreaker.lastFailureTime ? swarmBreaker.lastFailureTime + swarmBreaker.cooldownMs : null,
        timeUntilResetMs: swarmBreaker.state === 'OPEN' ? Math.max(0, (swarmBreaker.lastFailureTime + swarmBreaker.cooldownMs) - Date.now()) : 0
    };
}

function cancelSwarm(runId) {
    let active = null;
    let activeId = runId;
    if (runId) {
        active = activeSwarms.get(runId);
    } else if (activeSwarms.size > 0) {
        activeId = activeSwarms.keys().next().value;
        active = activeSwarms.get(activeId);
    }

    if (!active) {
        return false;
    }

    console.log(`[SWARM] Cancelling active swarm session: ${activeId}`);

    if (active.type === 'docker') {
        try {
            active.container.stop().catch(() => {});
        } catch (e) {
            console.warn('[SWARM] Failed to stop Docker container:', e.message);
        }
    } else if (active.type === 'native') {
        try {
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${active.child.pid} /t /f`, (killErr) => {
                    if (killErr) active.child.kill('SIGTERM');
                });
            } else {
                active.child.kill('SIGTERM');
            }
        } catch (e) {
            console.warn('[SWARM] Failed to kill native child process:', e.message);
        }
    }

    if (active.scriptPath && fs.existsSync(active.scriptPath)) {
        try { fs.unlinkSync(active.scriptPath); } catch {}
    }

    try {
        swarmRunsDB.update(activeId, 'Swarm manually cancelled by user.', 0, 'cancelled');
    } catch {}

    activeSwarms.delete(activeId);
    return true;
}

module.exports = { isComplexPrompt, spawnSwarm, buildAgentSpawns, normalizeRole, getCircuitStatus, cancelSwarm };

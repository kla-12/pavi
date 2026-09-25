const logger = require('../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { db } = require('../db');
const { SESSION, sessionBroadcast, sessionLog, withSessionLock, saveSession, getPhoneCount } = require('../services/session');
const supremeArchitect = require('../supreme-architect');
const swarmOrchestrator = require('../swarm-orchestrator');

let patternMemory;
try { patternMemory = require('../pattern-memory'); } catch (e) { patternMemory = null; }

const projectRoot = path.join(__dirname, '..', '..');

// GET /api/select-folder
router.get('/select-folder', (req, res) => {
    const psScript = `Add-Type -AssemblyName System.windows.forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowNewFolderButton = $true; $result = $f.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})); if($result -eq [System.Windows.Forms.DialogResult]::OK){ $f.SelectedPath }`;
    exec(`powershell -STA -Command "${psScript}"`, (error, stdout) => {
        res.json({ path: stdout ? stdout.trim() : '' });
    });
});

// GET /api/select-zip
router.get('/select-zip', (req, res) => {
    const psScript = `Add-Type -AssemblyName System.windows.forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = "Zip Files (*.zip)|*.zip|All Files (*.*)|*.*"; $result = $f.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true})); if($result -eq [System.Windows.Forms.DialogResult]::OK){ $f.FileName }`;
    exec(`powershell -STA -Command "${psScript}"`, (error, stdout) => {
        res.json({ path: stdout ? stdout.trim() : '' });
    });
});

// GET /api/export
router.get('/export', (req, res) => {
    const zipName = `pavi_portable_${Date.now()}.zip`;
    const destPath = path.join(__dirname, '..', zipName);
    
    const psCommand = `powershell -Command "Get-ChildItem -Path '${path.join(__dirname, '..')}' -Exclude 'node_modules', 'notebook_llm_exports', '*.zip', '__ingest_temp_*' | Compress-Archive -DestinationPath '${destPath}' -Force"`;
    
    exec(psCommand, (error) => {
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        res.download(destPath, zipName, (err) => {
            if (!err) {
                setTimeout(() => {
                    try { fs.unlinkSync(destPath); } catch (e) {}
                }, 5000);
            }
        });
    });
});

// POST /api/import
router.post('/import', (req, res) => {
    const tempZip = path.join(__dirname, '..', `import_${Date.now()}.zip`);
    const writeStream = fs.createWriteStream(tempZip);
    req.pipe(writeStream);
    
    writeStream.on('finish', () => {
        logger.info(`[IMPORT] Received snapshot. Extracting...`);
        const psCommand = `powershell -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${path.join(__dirname, '..')}' -Force"`;
        
        exec(psCommand, (error) => {
            try { fs.unlinkSync(tempZip); } catch (e) {}
            if (error) {
                res.status(500).json({ error: error.message });
            } else {
                res.json({ status: 'Snapshot imported successfully. Please restart the dashboard to apply changes.' });
            }
        });
    });
});

// POST /api/sync-start
router.post('/sync-start', (req, res) => {
    try {
        const { mode, port, host, token } = req.body;
        const memory = require('../memory');
        const bin = memory.getAgentDBCmd();
        let cmd = "";

        if (mode === 'server') {
            cmd = `${bin} sync start-server --port ${port} --auth-token ${token}`;
        } else if (mode === 'client') {
            cmd = `${bin} sync connect ${host} ${port} --auth-token ${token} && ${bin} sync pull --server ${host}:${port} --incremental`;
        }

        if (cmd) {
            logger.info(`[SYNC] Executing: ${cmd}`);
            exec(cmd, { cwd: path.join(__dirname, '..') });
            res.json({ status: `Sync initiated as ${mode}` });
        } else {
            res.status(400).json({ error: 'Invalid mode' });
        }
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/upload-zip
router.post('/upload-zip', (req, res) => {
    try {
        const filename = req.query.filename || `upload_${Date.now()}.zip`;
        const tempPath = path.join(projectRoot, 'temp_uploads');
        if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath);
        
        const finalPath = path.join(tempPath, filename);
        const writeStream = fs.createWriteStream(finalPath);
        req.pipe(writeStream);
        
        writeStream.on('finish', () => {
            res.json({ path: finalPath });
        });
        writeStream.on('error', (err) => {
            res.status(500).json({ error: err.message });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/ingest-zip
router.post('/ingest-zip', async (req, res) => {
    try {
        const { zipPath, topicHint, workerUrl, workerModel, workerKeys, reviewerUrl, reviewerModel, reviewerKeys } = req.body;
        if (!zipPath || !workerUrl || !workerKeys) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const zipFilename = path.basename(zipPath || '');
        const archZipDecision = await supremeArchitect.evaluateRepo({
            owner: 'zip-upload',
            repo: zipFilename,
            fileList: topicHint ? [topicHint] : [zipFilename]
        });

        if (archZipDecision.verdict === 'REJECT') {
            return res.send(`[SUPREME-ARCHITECT] REJECT: ${archZipDecision.reason}\nIngestion skipped — no new knowledge would be gained.`);
        }
        if (archZipDecision.verdict === 'ESCALATE') {
            return res.send(`[SUPREME-ARCHITECT] ESCALATE (${archZipDecision.level}): ${archZipDecision.reason}\nIngestion parked — resolve via /api/architect/escalation/:id/resolve`);
        }
        
        logger.info(`[SUPREME-ARCHITECT] APPROVE zip: ${zipFilename} — ${archZipDecision.reason}`);

        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked'
        });

        const scriptPath = path.join(__dirname, '..', 'ingester.js');
        const { spawn } = require('child_process');
        const child = spawn('node', [scriptPath, zipPath, topicHint, workerUrl, workerModel, JSON.stringify(workerKeys), reviewerUrl, reviewerModel, JSON.stringify(reviewerKeys)], { cwd: projectRoot });

        child.stdout.on('data', data => { res.write(data); });
        child.stderr.on('data', data => { res.write(data); });

        child.on('close', code => {
            res.write(`\n[SYSTEM] Ingestion process exited with code ${code}`);
            if (code === 0 && workerUrl && workerKeys && workerKeys.length > 0) {
                res.write(`\n[AUTO-HARVESTER] Automatically spawning background harvester to deepen knowledge on: ${topicHint}`);
                
                const harvPath = path.join(__dirname, '..', 'harvester.js');
                const hTopic = `Deepen knowledge, how to do it, how to solve errors, and best practices for: ${topicHint}`;
                // Normalize localhost to 127.0.0.1 to prevent IPv6 resolution failure in the background harvester
                const harvesterUrl = workerUrl.includes('localhost') ? workerUrl.replace('localhost', '127.0.0.1') : workerUrl;
                const harvester = spawn('node', [harvPath, harvesterUrl, workerKeys[0], hTopic, '3', workerModel || 'gpt-3.5-turbo'], { cwd: projectRoot, detached: true, stdio: 'ignore' });
                harvester.unref();
            }
            res.end();
        });
    } catch (e) {
        if (!res.headersSent) {
            res.status(500).json({ error: e.message });
        }
    }
});

// POST /api/clarify
router.post('/clarify', async (req, res) => {
    try {
        const { prompt, apiUrl, apiKey } = req.body;
        if (!prompt || !apiUrl || !apiKey) {
            return res.status(400).json({ error: 'Missing prompt or API credentials' });
        }

        const systemPrompt = "You are a prompt engineer and clarifier. The user has provided a messy, vague, or ambiguous request. Your job is to extract ONLY the essential requirements and rewrite them into a clear, concise, and structured list of instructions for an AI developer. Do NOT include conversational filler, apologies, or extra lines. Output ONLY the clarified instructions.";
        
        const payload = {
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            max_tokens: 500
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error: ${response.status} - ${text}`);
        }

        const data = await response.json();
        let clarifiedText = '';
        if (data.choices && data.choices[0] && data.choices[0].message) {
            clarifiedText = data.choices[0].message.content;
        } else if (data.response) {
            clarifiedText = data.response;
        } else {
            clarifiedText = JSON.stringify(data);
        }

        res.json({ clarified: clarifiedText.trim() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/plan
router.post('/plan', async (req, res) => {
    try {
        let { prompt, apiUrl, apiModel, apiKeys, reviewerUrl, reviewerModel, reviewerKeys } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Missing prompt' });
        }

        const groqKey = process.env.GROQ_API_KEY || (reviewerKeys && reviewerKeys[0]) || (apiKeys && apiKeys[0] && apiKeys[0] !== 'local_mode' ? apiKeys[0] : null);

        const systemPrompt = "You are a senior technical architect. Before the worker writes code, generate a high-level markdown checklist of the implementation plan based on the user's request. Keep it concise. Do not write code. Just outline the steps to take.";
        
        let planText = null;
        let usedFallback = false;

        // Try primary worker API first if not skipping local in production
        const isLocalUrl = apiUrl && (apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1'));
        const skipLocal = isLocalUrl && process.env.NODE_ENV === 'production';

        if (apiUrl && apiKeys && apiKeys.length > 0 && !skipLocal) {
            try {
                const payload = {
                    model: apiModel || "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt }
                    ],
                    max_tokens: 800
                };
                for (let i = 0; i < apiKeys.length; i++) {
                    const key = apiKeys[i];
                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify(payload),
                        signal: AbortSignal.timeout(10000)
                    });
                    if (response.ok) {
                        const data = await response.json();
                        planText = data.choices ? data.choices[0].message.content : (data.response || null);
                        if (planText) break;
                    }
                }
            } catch (err) {
                logger.warn('[PLAN] Primary apiUrl failed, falling back to reviewer/Groq:', err.message);
            }
        }

        // Fallback to Reviewer (Groq Cloud) API
        if (!planText && (reviewerUrl || groqKey)) {
            const fallbackUrl = reviewerUrl || 'https://api.groq.com/openai/v1/chat/completions';
            const fallbackModel = reviewerModel || 'llama-3.3-70b-versatile';
            const fallbackKeys = (reviewerKeys && reviewerKeys.length > 0) ? reviewerKeys : [groqKey];

            for (const key of fallbackKeys) {
                if (!key || key === 'local_mode') continue;
                try {
                    const response = await fetch(fallbackUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({
                            model: fallbackModel,
                            messages: [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: prompt }
                            ],
                            max_tokens: 800
                        }),
                        signal: AbortSignal.timeout(15000)
                    });
                    if (response.ok) {
                        const data = await response.json();
                        planText = data.choices ? data.choices[0].message.content : (data.response || null);
                        if (planText) {
                            usedFallback = true;
                            break;
                        }
                    }
                } catch (err) {
                    logger.warn('[PLAN] Reviewer fallback failed:', err.message);
                }
            }
        }

        if (!planText) {
            throw new Error('Could not reach AI engine. Please configure your Groq API key in Settings.');
        }

        res.json({ plan: planText, usedFallback });
    } catch (e) {
        logger.error('[PLAN] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/simulate-notebook
router.post('/simulate-notebook', async (req, res) => {
    try {
        const { question, apiUrl, apiKey, apiModel } = req.body;
        if (!question || !apiUrl || !apiKey) {
            return res.status(400).json({ error: 'Missing question or API credentials' });
        }

        const exportDir = path.join(projectRoot, 'notebook_llm_exports');
        let contextData = '';
        
        if (fs.existsSync(exportDir)) {
            const files = fs.readdirSync(exportDir);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    const content = fs.readFileSync(path.join(exportDir, file), 'utf8');
                    contextData += `\n--- File: ${file} ---\n${content}\n`;
                }
            }
        }

        if (!contextData) {
            return res.json({ answer: "I don't have any harvested knowledge yet. Please run the API Harvester or Zip Ingester first so I can read the exported markdown files." });
        }

        if (contextData.length > 100000) {
            contextData = contextData.substring(0, 100000) + "\n\n...[TRUNCATED DUE TO LENGTH]";
        }

        const systemPrompt = `You are a NotebookLM Simulator. You have been provided with a large amount of exported knowledge. Answer the user's question based strictly on the provided context below. Do not make up answers outside the context.
        
CONTEXT:
${contextData}`;
        
        const payload = {
            model: apiModel || "gpt-3.5-turbo",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: question }
            ],
            max_tokens: 1500
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API Error: ${response.status} - ${text}`);
        }

        const data = await response.json();
        let answerText = data.choices ? data.choices[0].message.content : (data.response || "No response generated.");
        
        res.json({ answer: answerText });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/session
router.get('/session', (req, res) => {
    res.json({
        selectedFolder: SESSION.selectedFolder,
        status: SESSION.status,
        currentTask: SESSION.currentTask,
        logs: SESSION.logs.slice(-50),
        contextNotes: SESSION.contextNotes,
        phoneCount: getPhoneCount()
    });
});

// POST /api/session
router.post('/session', async (req, res) => {
    try {
        const { selectedFolder, status, currentTask } = req.body;
        if (global.saveDebounce) clearTimeout(global.saveDebounce);
        global.saveDebounce = setTimeout(() => {
            withSessionLock(async () => {
                if (selectedFolder !== undefined) SESSION.selectedFolder = selectedFolder;
                if (status !== undefined) SESSION.status = status;
                if (currentTask !== undefined) SESSION.currentTask = currentTask;
                saveSession();
                sessionBroadcast('session', { selectedFolder: SESSION.selectedFolder, status: SESSION.status, currentTask: SESSION.currentTask });
            });
        }, 300);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/session/note
router.post('/session/note', async (req, res) => {
    try {
        const { note } = req.body;
        if (!note || !note.trim()) throw new Error('Empty note');
        const entry = { note: note.trim(), ts: Date.now() };
        await withSessionLock(async () => {
            SESSION.contextNotes.push(entry);
            if (SESSION.contextNotes.length > 50) SESSION.contextNotes.shift();
            saveSession();
        });
        sessionBroadcast('context_note', entry);
        sessionLog(`[MOBILE] Context note saved: ${note.trim().slice(0, 60)}`);
        res.json({ ok: true, saved: entry });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// GET /api/metrics
router.get('/metrics', (req, res) => {
    try {
        const botsCount = db.prepare('SELECT COUNT(*) as c FROM bots').get().c;
        const skillsCount = db.prepare('SELECT COUNT(*) as c FROM skills').get().c;
        const queueCount = db.prepare('SELECT COUNT(*) as c FROM ingest_queue').get().c;
        const pendingQueue = db.prepare('SELECT COUNT(*) as c FROM ingest_queue WHERE status = ?').get('pending').c;
        const rateLimits = db.prepare('SELECT COUNT(*) as c FROM rate_limit_log').get().c;

        const memStats = process.memoryUsage();
        
        res.json({
            system: {
                uptimeMs: process.uptime() * 1000,
                memory: memStats,
                phoneCount: getPhoneCount()
            },
            database: {
                bots: botsCount,
                skills: skillsCount,
                queueTotal: queueCount,
                queuePending: pendingQueue,
                rateLimitEntries: rateLimits
            },
            circuitBreaker: swarmOrchestrator.getCircuitStatus ? swarmOrchestrator.getCircuitStatus() : null,
            patternMemory: patternMemory && patternMemory.getStats ? patternMemory.getStats() : null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/prune
router.post('/prune', (req, res) => {
    try {
        const result = patternMemory && patternMemory.prune ? patternMemory.prune() : { error: 'Not implemented' };
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ngrok-url
router.get('/ngrok-url', async (req, res) => {
    try {
        const ports = [4040, 4041];
        let ngrokUrl = null;
        
        for (const p of ports) {
            try {
                const response = await fetch(`http://localhost:${p}/api/tunnels`, { signal: AbortSignal.timeout(1000) });
                if (response.ok) {
                    const data = await response.json();
                    if (data.tunnels && data.tunnels.length > 0) {
                        // Prioritize HTTPS tunnel
                        const secureTunnel = data.tunnels.find(t => t.proto === 'https');
                        const tunnel = secureTunnel || data.tunnels[0];
                        ngrokUrl = tunnel.public_url;
                        break;
                    }
                }
            } catch (e) {}
        }
        
        if (ngrokUrl) {
            res.json({
                ngrokUrl,
                mobileUrl: `${ngrokUrl}/mobile`
            });
        } else {
            res.json({
                ngrokUrl: null,
                mobileUrl: null
            });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/local-ip
router.get('/local-ip', (req, res) => {
    try {
        const { getLanIP } = require('../services/session');
        const lanIP = getLanIP();
        res.json({
            localIp: lanIP,
            mobileUrl: `http://${lanIP}:3000/mobile`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/repo-stats
router.get('/repo-stats', (req, res) => {
    try {
        const stats = patternMemory ? patternMemory.repoStats : {};
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ingestion-summaries?limit=20
// Returns the most recent ingestion summaries (synthesis + reviewer output)
router.get('/ingestion-summaries', (req, res) => {
    try {
        const { db } = require('../db');
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const rows = db.prepare(
            `SELECT id, zip_name, topic_hint, what_is_it, who_uses_it, core_flow, best_pattern, tech_stack, reviewer_summary, reviewer_verdict, suggested_skills, created_at
             FROM ingestion_summaries
             ORDER BY created_at DESC
             LIMIT ?`
        ).all(limit);

        res.json(rows.map(r => ({
            ...r,
            suggested_skills: (() => { try { return JSON.parse(r.suggested_skills || '[]'); } catch { return []; } })(),
        })));
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ingestion-summaries/:id
// Returns a single ingestion summary with full verification report
router.get('/ingestion-summaries/:id', (req, res) => {
    try {
        const { db } = require('../db');
        const row = db.prepare('SELECT * FROM ingestion_summaries WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json({
            ...row,
            suggested_skills:    (() => { try { return JSON.parse(row.suggested_skills    || '[]');  } catch { return []; } })(),
            readme_verification: (() => { try { return JSON.parse(row.readme_verification || 'null'); } catch { return null; } })(),
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ingestion-summaries/:id/verification
// Returns just the verification report for a specific ingestion
router.get('/ingestion-summaries/:id/verification', (req, res) => {
    try {
        const { db } = require('../db');
        const row = db.prepare(
            'SELECT id, topic_hint, what_is_it, readme_verification FROM ingestion_summaries WHERE id = ?'
        ).get(req.params.id);

        if (!row) return res.status(404).json({ error: 'Ingestion summary not found' });

        let verification = null;
        try { verification = row.readme_verification ? JSON.parse(row.readme_verification) : null; } catch {}

        res.json({
            id:           row.id,
            topicHint:    row.topic_hint,
            whatIsIt:     row.what_is_it,
            verification,
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Mobile Intel Tab APIs ────────────────────────────────────────────────────

// GET /api/staging-skills — list all staged skills for review
router.get('/staging-skills', (req, res) => {
    try {
        const { stagingSkillsDB } = require('../db');
        const skills = stagingSkillsDB.getAll();
        res.json(skills);
    } catch(e) {
        res.json([]); // graceful empty
    }
});

// POST /api/staging-skills/promote — approve a staged skill into live skills
router.post('/staging-skills/promote', (req, res) => {
    try {
        const { stagingSkillsDB, skillsDB } = require('../db');
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, message: 'Missing skill id' });

        const allStaged = stagingSkillsDB.getAll();
        const skill = allStaged.find(s => s.id === id);
        if (!skill) return res.status(404).json({ success: false, message: 'Staged skill not found' });

        // Move to live skills
        const liveSkills = skillsDB.getAll();
        skill.status = 'promoted';
        skill.promotedAt = new Date().toISOString();
        liveSkills.push(skill);
        skillsDB.saveAll(liveSkills);

        // Remove from staging
        const remaining = allStaged.filter(s => s.id !== id);
        stagingSkillsDB.saveAll(remaining);

        res.json({ success: true, message: `Skill "${skill.tag}" promoted to live.` });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /api/staging-skills/discard — reject a staged skill
router.post('/staging-skills/discard', (req, res) => {
    try {
        const { stagingSkillsDB } = require('../db');
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, message: 'Missing skill id' });

        const allStaged = stagingSkillsDB.getAll();
        const skill = allStaged.find(s => s.id === id);
        if (!skill) return res.status(404).json({ success: false, message: 'Staged skill not found' });

        const remaining = allStaged.filter(s => s.id !== id);
        stagingSkillsDB.saveAll(remaining);

        res.json({ success: true, message: `Skill "${skill.tag}" discarded.` });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /api/skill-gaps — list detected skill gaps
router.get('/skill-gaps', (req, res) => {
    try {
        const gapsPath = path.join(__dirname, '..', 'skill-gaps.json');
        if (fs.existsSync(gapsPath)) {
            const gaps = JSON.parse(fs.readFileSync(gapsPath, 'utf8'));
            return res.json(Array.isArray(gaps) ? gaps : []);
        }
        res.json([]);
    } catch(e) {
        res.json([]);
    }
});

// GET /api/quarantine — list quarantined repos
router.get('/quarantine', (req, res) => {
    try {
        const rows = db.prepare('SELECT repoKey, score, data FROM repo_quarantine LIMIT 50').all();
        const repos = rows.map(r => {
            let data = {};
            try { data = JSON.parse(r.data || '{}'); } catch(_) {}
            return {
                repoKey: r.repoKey,
                reason: data.reason || 'Unknown',
                score: r.score || 0,
                graduated: data.graduated || false,
                created_at: data.created_at || null
            };
        });
        res.json(repos);
    } catch(e) {
        res.json([]);
    }
});

// GET /api/audit-log — mirror of /api/architect/audit-log for mobile
router.get('/audit-log', (req, res) => {
    try {
        let auditLog;
        try { auditLog = require('../audit-log'); } catch(_) {}
        if (!auditLog) return res.json([]);

        const rawLimit = parseInt(req.query.limit || '100', 10);
        const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 100 : rawLimit, 500);
        const rows = auditLog.read(limit);
        const entries = rows.map(r => {
            let data = {};
            try { data = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {}); } catch(_) {}
            return {
                ts: r.ts,
                event: r.event,
                tag: r.tag || data.tag || '',
                repo: r.repo || data.repo || ''
            };
        });
        res.json(entries);
    } catch(e) {
        res.json([]);
    }
});

module.exports = router;

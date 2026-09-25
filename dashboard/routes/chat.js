const logger = require('../utils/logger');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const localBot2 = require('../local-bot');
const shield = require('../shield');
const { SESSION, sessionBroadcast, sessionLog } = require('../services/session');
const { botsDB, skillsDB } = require('../db');
const swarmOrchestrator = require('../swarm-orchestrator');
const botUpgrader = require('../bot-upgrader');
const skillScanner = require('../skill-scanner');
const promptCache = require('../utils/prompt-cache');
const pluginLoader = require('../services/plugin-loader');
const sanitizer = require('../services/sanitizer');
const contextCompressor = require('../services/context-compressor');
const skillVectorIndex = require('../services/skill-vector-index');

// Rebuild vector index on load
skillVectorIndex.index.rebuildFromSkillsDB();

let patternMemory;
try { patternMemory = require('../pattern-memory'); } catch (e) { patternMemory = null; }

const BOTS_PATH = path.join(__dirname, '..', 'bots.json');
const projectRoot = path.join(__dirname, '..', '..');

function shouldSanitize() {
    const url = localBot2.workerUrl;
    return url && !url.includes('localhost') && !url.includes('127.0.0.1');
}

// POST /api/proxy-ai
router.post('/proxy-ai', async (req, res) => {
    try {
        const { prompt, role, systemPrompt, maxTokens, neutralize } = req.body;
        if (!prompt) throw new Error('Missing prompt');
        
        let finalPrompt = prompt;
        let shieldResult = null;
        if (neutralize !== false) {
            shieldResult = shield.neutralize(prompt);
            finalPrompt = shieldResult.spec + '\n\nCLARIFIED TASK:\n' + shieldResult.neutralized;
        }

        let finalSystemPrompt = systemPrompt || '';
        if (shouldSanitize()) {
            finalPrompt = sanitizer.sanitize(finalPrompt);
            if (finalSystemPrompt) {
                finalSystemPrompt = sanitizer.sanitize(finalSystemPrompt);
            }
        }

        const provider = 'localBot2'; // Since localBot2 handles it
        const model = 'default';
        const cachedResponse = promptCache.getCachedResponse(finalPrompt, finalSystemPrompt || '', provider, model);
        
        if (cachedResponse) {
            logger.info('[CACHE] Cache hit for proxy-ai');
            return res.json({
                content: cachedResponse,
                shield: shieldResult ? { confidence: shieldResult.confidence, strippedTerms: shieldResult.strippedTerms } : null,
                cached: true
            });
        }

        const content = await localBot2.call(finalPrompt, role || 'worker', finalSystemPrompt || null, maxTokens || 1500);
        
        promptCache.setCachedResponse(finalPrompt, finalSystemPrompt || '', provider, model, content);

        res.json({
            content,
            shield: shieldResult ? { confidence: shieldResult.confidence, strippedTerms: shieldResult.strippedTerms } : null
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/chat
router.post('/chat', async (req, res) => {
    try {
        const { messages, role, systemPrompt, maxTokens } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing or invalid messages array' });
        }

        let finalSystemPrompt = systemPrompt || '';
        try {
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
                let memoryContext = [];
                if (patternMemory) {
                    memoryContext = await patternMemory.recall(lastUserMsg.content, 3);
                }
                const matchedSkills = skillVectorIndex.index.search(lastUserMsg.content, 3);

                let injectedMemory = '';
                if (memoryContext && memoryContext.length > 0) {
                    injectedMemory += memoryContext.map(m => `[From Memory - ${m.key}]:\n${m.value}`).join('\n\n');
                }
                if (matchedSkills && matchedSkills.length > 0) {
                    if (injectedMemory) injectedMemory += '\n\n';
                    injectedMemory += `[From Skill Library]:\n` + matchedSkills.map(s => `- ${s.tag} (Relevance: ${(s.score * 100).toFixed(0)}%): ${s.description}`).join('\n');
                }

                if (injectedMemory) {
                    if (injectedMemory.length > 4000) {
                        injectedMemory = contextCompressor.compress(injectedMemory);
                    }
                    finalSystemPrompt = `You have access to the following offline memories. Use them to answer if relevant:\n\n${injectedMemory}\n\n` + finalSystemPrompt;
                }
            }
        } catch (e) {
            logger.warn('[CHAT] Could not fetch memory/skills for chat:', e.message);
        }
        
        let finalMessages = messages;
        if (shouldSanitize()) {
            finalSystemPrompt = sanitizer.sanitize(finalSystemPrompt);
            finalMessages = messages.map(m => ({
                role: m.role,
                content: sanitizer.sanitize(m.content)
            }));
        }

        const provider = 'localBot2';
        const model = 'default';
        const stringifiedMessages = JSON.stringify(finalMessages);
        const cachedResponse = promptCache.getCachedResponse(stringifiedMessages, finalSystemPrompt || '', provider, model);

        if (cachedResponse) {
            logger.info('[CACHE] Cache hit for chat');
            return res.json({ content: cachedResponse, cached: true });
        }

        const content = await localBot2.call(finalMessages, role || 'worker', finalSystemPrompt || null, maxTokens || 1500);
        
        promptCache.setCachedResponse(stringifiedMessages, finalSystemPrompt || '', provider, model, content);

        res.json({ content });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/rate-summary
router.get('/rate-summary', (req, res) => {
    res.json(localBot2.getRateSummary());
});

// GET /api/bots
router.get('/bots', (req, res) => {
    try {
        const botRegistry = botsDB.getAll();
        res.json(botRegistry);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/scan-skills
router.post('/scan-skills', (req, res) => {
    try {
        const result = skillScanner.scanSkillsFolder();
        let botRegistry = [];
        if (fs.existsSync(BOTS_PATH)) {
            botRegistry = JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8'));
            botsDB.saveAll(botRegistry);
        }
        botRegistry = botsDB.getAll();
        
        // Rebuild vector index on skill scan
        skillVectorIndex.index.rebuildFromSkillsDB();

        sessionLog(`[SKILL-SCAN] Scanned local skills: ${result.added} added/updated, ${result.skipped} skipped.`);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/bot-ingest
router.post('/bot-ingest', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'Missing url' });
        }

        const ghMatch = url.match(/github\.com\/([^/]+)\/([^/\s?#]+)(?:\/tree\/([^/\s?#]+))?/);
        if (!ghMatch) {
            return res.status(400).json({ error: 'Invalid GitHub URL' });
        }
        let [, owner, repo, branch = 'HEAD'] = ghMatch;
        if (repo.endsWith('.git')) repo = repo.slice(0, -4);

        const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
        const treeRes = await fetch(treeUrl, { headers: { 'User-Agent': 'Pavi-AI/1.0' } });
        if (!treeRes.ok) throw new Error(`GitHub API error: ${treeRes.status}`);
        const treeData = await treeRes.json();
        const botFiles = (treeData.tree || []).filter(f => f.type === 'blob' && f.path.endsWith('.bot.json'));

        if (botFiles.length === 0) throw new Error('No .bot.json files found in the repository.');

        let added = 0, skipped = 0;
        const added_bots = [];
        let bots = botsDB.getAll();

        for (const file of botFiles) {
            try {
                const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
                const fileRes = await fetch(rawUrl, { headers: { 'User-Agent': 'Pavi-AI/1.0' } });
                if (!fileRes.ok) { skipped++; continue; }
                const botDef = await fileRes.json();

                if (!botDef.name || !botDef.role) { skipped++; continue; }

                botDef.source = `${owner}/${repo}`;
                botDef.registeredAt = new Date().toISOString();
                botDef.active = true;
                botDef.version = botDef.version || '1.0.0';

                const existingIdx = bots.findIndex(b => b.name === botDef.name);
                if (existingIdx !== -1) {
                    if (botUpgrader.isNewer(botDef.version, bots[existingIdx].version)) {
                        bots[existingIdx] = { ...bots[existingIdx], ...botDef };
                        added_bots.push({ ...bots[existingIdx], _action: 'upgraded' });
                        added++;
                    } else {
                        skipped++;
                    }
                } else {
                    bots.push(botDef);
                    added_bots.push({ ...botDef, _action: 'added' });
                    added++;
                }
            } catch (e) { skipped++; }
        }

        fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
        botsDB.saveAll(bots);

        sessionLog(`[BOT-INGEST] ${owner}/${repo}: ${added} bots added/upgraded, ${skipped} skipped.`);
        res.json({ added, skipped, bots: added_bots });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// POST /api/bots/:name/upgrade
router.post('/bots/:name/upgrade', async (req, res) => {
    try {
        const botName = req.params.name;
        const result = await botUpgrader.upgradeBotByName(botName);
        let bots = [];
        if (fs.existsSync(BOTS_PATH)) {
            bots = JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8'));
            botsDB.saveAll(bots);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/bots/:name
router.delete('/bots/:name', (req, res) => {
    const botName = req.params.name;
    try {
        let bots = fs.existsSync(BOTS_PATH) ? JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8')) : [];
        const before = bots.length;
        bots = bots.filter(b => b.name !== botName);
        fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
        botsDB.saveAll(bots);
        res.json({ removed: before - bots.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/bots/:name/toggle
router.post('/bots/:name/toggle', (req, res) => {
    const botName = req.params.name;
    try {
        let bots = fs.existsSync(BOTS_PATH) ? JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8')) : [];
        const bot = bots.find(b => b.name === botName);
        if (!bot) {
            return res.status(404).json({ error: 'Bot not found' });
        }
        bot.active = !bot.active;
        fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
        botsDB.saveAll(bots);
        res.json({ name: botName, active: bot.active });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/route-chat
router.post('/route-chat', async (req, res) => {
    try {
        const { messages, role, systemPrompt, maxTokens, source } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing or invalid messages array' });
        }

        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const userText = lastUserMsg ? lastUserMsg.content : '';
        const isPhoneSource = source === 'mobile';

        const useSwarm = await swarmOrchestrator.isComplexPrompt(userText);
        sessionLog(`[ROUTE] Prompt "${userText.slice(0, 60)}…" [${isPhoneSource ? '📱 mobile' : '🖥 desktop'}] → ${useSwarm ? '🐝 SWARM' : '🤖 SINGLE'}`);

        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        if (useSwarm) {
            const { bots } = swarmOrchestrator.buildAgentSpawns(userText);
            const swarmPromise = swarmOrchestrator.spawnSwarm(userText, {
                cwd: SESSION.selectedFolder || path.join(__dirname, '..', '..')
            });

            res.write(`[ROUTING] swarm|${JSON.stringify(bots.map(b => ({ name: b.name, role: b.role })))}\n`);
            res.write(`[CONTENT] 🐝 **Swarm Activated!** I detected this is a complex task, so I've spun up a team of specialized bots to handle it.\n`);
            res.end();

            swarmPromise.then(({ output }) => {
                sessionLog(`[SWARM] Result: ${output.slice(0, 200)}`);
                sessionBroadcast('swarm_result', {
                    objective: userText.slice(0, 80),
                    result: output,
                    source: isPhoneSource ? 'mobile' : 'desktop'
                });
            }).catch(e => sessionLog(`[SWARM] Error: ${e.message}`));

        } else {
            let finalSystemPrompt = systemPrompt || '';

            if (SESSION.lastLearnedRepo) {
                const { owner, repo, ingested, label } = SESSION.lastLearnedRepo;
                const labelText = label ? `You told me this is the ${label}. ` : '';
                finalSystemPrompt = `You recently learned the GitHub repository '${owner}/${repo}' (${ingested} files) from the user's phone. ${labelText}If the user refers to it, use your pattern memory to answer based on that specific project.\n\n` + finalSystemPrompt;
            }

            try {
                if (userText) {
                    const isLearningQuery = userText.toLowerCase().includes('learn') || userText.toLowerCase().includes('wat you learn') || userText.toLowerCase().includes('new');

                    let searchQuery = userText;
                    if (isPhoneSource || isLearningQuery) {
                        searchQuery = `$github ${userText}`;
                        if (SESSION.lastLearnedRepo) {
                            searchQuery = `$github-${SESSION.lastLearnedRepo.owner}-${SESSION.lastLearnedRepo.repo} ${searchQuery}`;
                        }
                    }

                    let memoryContext = [];
                    if (patternMemory) {
                        memoryContext = await patternMemory.recall(searchQuery, 6);
                    }
                    const matchedSkills = skillVectorIndex.index.search(userText, 3);

                    let injectedContext = '';
                    if (memoryContext && memoryContext.length > 0) {
                        injectedContext += memoryContext.map(m => `[From Memory - ${m.key}]:\n${m.metadata ? `(Source: ${m.metadata})\n` : ''}${m.value || m.skeleton}`).join('\n\n');
                    }
                    if (matchedSkills && matchedSkills.length > 0) {
                        if (injectedContext) injectedContext += '\n\n';
                        injectedContext += `[From Skill Library]:\n` + matchedSkills.map(s => `- ${s.tag} (Relevance: ${(s.score * 100).toFixed(0)}%): ${s.description}`).join('\n');
                    }

                    if (injectedContext) {
                        if (injectedContext.length > 4000) {
                            injectedContext = contextCompressor.compress(injectedContext);
                        }
                        finalSystemPrompt = `You have access to the following recently learned data and offline memories:\n\n${injectedContext}\n\n` + finalSystemPrompt;

                        if (isPhoneSource) {
                            finalSystemPrompt = `IMPORTANT: This message was sent via the Pavi Mobile app. Use the memories provided above to answer based on the code/projects the user just ingested.\n` + finalSystemPrompt;
                        }
                    }
                }
            } catch (e) {
                logger.warn('[ROUTE-CHAT] Memory recall failed:', e.message);
            }

            // Plugin trigger matching & execution
            const matchedPluginInfo = pluginLoader.findPluginByTrigger(userText);
            if (matchedPluginInfo) {
                const { plugin, match } = matchedPluginInfo;
                sessionLog(`[PLUGIN] Triggered tool "${plugin.name}" via match: "${match}"`);

                let toolResultStr = '';
                try {
                    let params = {};
                    if (plugin.id === 'web-search') {
                        let query = userText;
                        const matchIndex = userText.toLowerCase().indexOf(match.toLowerCase());
                        if (matchIndex !== -1) {
                            query = userText.substring(matchIndex + match.length).trim();
                        }
                        if (!query) {
                            const regexMatch = userText.match(plugin.trigger);
                            query = (regexMatch && (regexMatch[1] || regexMatch[2] || regexMatch[3] || regexMatch[4])) || userText;
                        }
                        params = { q: query.trim() };

                        const result = await pluginLoader.executePlugin(plugin.id, params);
                        toolResultStr = `[TOOL RESULT — Web Search for "${params.q}"]:
Abstract: ${result.abstract || 'N/A'}
Answer: ${result.answer || 'N/A'}
Related Topics:
${(result.relatedTopics || []).map(t => `- ${t.text} (${t.url || 'no link'})`).join('\n')}`;
                    } else if (plugin.id === 'code-runner') {
                        let code = userText;
                        const codeBlockMatch = userText.match(/```(?:js|javascript)?([\s\S]*?)```/i);
                        if (codeBlockMatch) {
                            code = codeBlockMatch[1];
                        } else {
                            const matchIndex = userText.toLowerCase().indexOf(match.toLowerCase());
                            if (matchIndex !== -1) {
                                code = userText.substring(matchIndex + match.length).trim();
                            }
                        }
                        params = { code: code.trim() };

                        const result = await pluginLoader.executePlugin(plugin.id, params);
                        toolResultStr = `[TOOL RESULT — Code Runner]:
Success: ${result.success}
Output Result: ${result.result !== undefined ? result.result : 'N/A'}
Console Logs:
${(result.logs || []).map(l => `> ${l}`).join('\n') || 'None'}
${result.error ? `Error: ${result.error}` : ''}`;
                    }

                    if (toolResultStr) {
                        finalSystemPrompt = `You have access to the following real-time tool execution results. Incorporate this information to answer the user's prompt:\n\n${toolResultStr}\n\n` + finalSystemPrompt;
                        sessionLog(`[PLUGIN] Executed "${plugin.name}" successfully.`);
                    }
                } catch (err) {
                    sessionLog(`[PLUGIN] Executed "${plugin.name}" failed: ${err.message}`);
                }
            }

            // Expose active tool descriptions
            const availableTools = pluginLoader.getToolDescriptions();
            if (availableTools.length > 0) {
                finalSystemPrompt += `\n\nYou are equipped with the following interactive plugins/tools which you can suggest the user invoke by prefixing their prompt with the triggers below:\n` +
                    availableTools.map(t => {
                        const triggerDesc = t.name === 'Web Search' ? '"search [query]", "look up [query]", "google [query]"' : '"run code: [javascript snippet]"';
                        return `- ${t.name}: ${t.description} (Triggers: ${triggerDesc})`;
                    }).join('\n') + `\n\n`;
            }

            res.write(`[ROUTING] single\n`);
            try {
                let finalMessages = messages;
                if (shouldSanitize()) {
                    finalSystemPrompt = sanitizer.sanitize(finalSystemPrompt);
                    finalMessages = messages.map(m => ({
                        role: m.role,
                        content: sanitizer.sanitize(m.content)
                    }));
                }
                await localBot2.callStream(finalMessages, role || 'worker', finalSystemPrompt || null, maxTokens || 1500, (token) => {
                    res.write(`[TOKEN] ${token}\n`);
                });
            } catch (streamErr) {
                res.write(`[ERROR] ${streamErr.message}\n`);
            }
            res.end();
        }
    } catch (e) {
        if (!res.headersSent) {
            res.status(500).json({ error: e.message });
        } else {
            res.write(`[ERROR] ${e.message}\n`);
            res.end();
        }
    }
});

// POST /api/shield-preview
router.post('/shield-preview', (req, res) => {
    try {
        const { prompt } = req.body;
        const result = shield.neutralize(prompt || '');
        res.json({
            spec: result.spec,
            neutralized: result.neutralized,
            confidence: result.confidence,
            strippedTerms: result.strippedTerms
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// GET /api/skills
router.get('/skills', (req, res) => {
    try {
        const skillsPath = path.join(__dirname, '..', 'skills.json');
        if (!fs.existsSync(skillsPath)) {
            return res.json([]);
        }
        const data = fs.readFileSync(skillsPath, 'utf8');
        res.json(JSON.parse(data));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/skills
router.post('/skills', (req, res) => {
    try {
        const newSkill = req.body;
        if (!newSkill.tag || !newSkill.description) throw new Error("Invalid skill format");
        
        const skillsPath = path.join(__dirname, '..', 'skills.json');
        let skills = [];
        if (fs.existsSync(skillsPath)) skills = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
        
        if (!skills.some(s => s.tag === newSkill.tag)) {
            skills.push(newSkill);
            fs.writeFileSync(skillsPath, JSON.stringify(skills, null, 4));
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// GET /api/list-files
router.get('/list-files', (req, res) => {
    try {
        const dashboardRoot = path.join(__dirname, '..');
        const defaultRoot = path.join(dashboardRoot, '..');
        const dir = req.query.dir || defaultRoot;
        if (!fs.existsSync(dir)) {
            return res.status(404).json({ error: 'Directory not found' });
        }
        const walk = (d, base) => {
            let results = [];
            try {
                for (const f of fs.readdirSync(d)) {
                    if (f === 'node_modules' || f === '.git') continue;
                    const full = path.join(d, f);
                    const rel = path.join(base, f);
                    const stat = fs.statSync(full);
                    if (stat.isDirectory()) results = results.concat(walk(full, rel));
                    else results.push({ name: f, path: full, rel });
                }
            } catch (e) {}
            return results;
        };
        const files = walk(dir, '');
        res.json(files);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/execute
router.post('/execute', (req, res) => {
    try {
        const { command, cwd } = req.body;
        
        if (!command) {
            return res.status(400).json({ error: 'Command is required' });
        }

        if (!command.startsWith('npx claude-flow')) {
            return res.status(403).json({ error: 'Execution forbidden: Only claude-flow commands are allowed.' });
        }

        const dashboardRoot = path.join(__dirname, '..');
        const defaultRoot = path.join(dashboardRoot, '..');
        let targetCwd = defaultRoot;
        if (cwd) {
            if (fs.existsSync(cwd)) {
                targetCwd = cwd;
            } else {
                return res.status(400).json({ error: `Directory not found: ${cwd}` });
            }
        }

        logger.info(`Executing: ${command} in ${targetCwd}`);

        exec(command, { cwd: targetCwd }, (error, stdout, stderr) => {
            if (error) {
                return res.status(200).json({ error: error.message, stdout, stderr });
            }
            res.json({ stdout, stderr });
        });
    } catch (e) {
        res.status(400).json({ error: 'Invalid JSON body' });
    }
});

// POST /api/orchestrate
router.post('/orchestrate', async (req, res) => {
    try {
        const { prompt, cwd, targetFiles, workerUrl, workerModel, workerKeys, reviewerUrl, reviewerModel, reviewerKeys } = req.body;
        
        if (!prompt) {
            return res.status(400).json({ error: 'Missing prompt' });
        }
        
        // Resolve default values
        const configPath = path.join(__dirname, '..', 'config.json');
        let config = {};
        if (fs.existsSync(configPath)) {
            try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
        }
        
        let finalWorkerUrl = workerUrl || config.workerUrl || process.env.WORKER_URL || 'http://localhost:11434/v1/chat/completions';
        let finalWorkerModel = workerModel || config.workerModel || 'phi3:mini';
        let finalWorkerKeys = workerKeys || config.workerKeys || [config.apiKey || ''];
        
        let finalReviewerUrl = reviewerUrl || config.reviewerUrl || finalWorkerUrl;
        let finalReviewerModel = reviewerModel || config.reviewerModel || finalWorkerModel;
        let finalReviewerKeys = reviewerKeys || config.reviewerKeys || finalWorkerKeys;

        const isWorkerLocal = finalWorkerUrl.includes('localhost') || finalWorkerUrl.includes('127.0.0.1');
        const isReviewerRemote = finalReviewerUrl && !finalReviewerUrl.includes('localhost') && !finalReviewerUrl.includes('127.0.0.1');

        if (isWorkerLocal && (process.env.NODE_ENV === 'production' || isReviewerRemote)) {
            if (isReviewerRemote && finalReviewerKeys && finalReviewerKeys.length > 0 && finalReviewerKeys[0] !== 'local_mode') {
                logger.info('[ORCHESTRATE] Local worker URL detected in cloud; auto-routing Worker to Reviewer Cloud endpoint.');
                finalWorkerUrl = finalReviewerUrl;
                finalWorkerModel = 'llama-3.1-8b-instant';
                finalWorkerKeys = finalReviewerKeys;
            }
        }
        
        const targetDir = cwd || path.join(__dirname, '..', '..');
        const filesJson = JSON.stringify(targetFiles || []);
        
        // Spawn orchestrator.js
        const scriptPath = path.join(__dirname, '..', 'orchestrator.js');
        const { spawn } = require('child_process');
        
        logger.info(`[ORCHESTRATE] Spawning orchestrator for prompt: "${prompt.slice(0, 60)}..."`);
        
        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked'
        });
        
        const child = spawn('node', [
            scriptPath,
            finalWorkerUrl,
            finalWorkerModel,
            JSON.stringify(finalWorkerKeys),
            finalReviewerUrl,
            finalReviewerModel,
            JSON.stringify(finalReviewerKeys),
            prompt,
            targetDir,
            filesJson
        ], {
            cwd: targetDir,
            env: {
                ...process.env,
                PORT: process.env.PORT || '3000'
            }
        });
        
        child.stdout.on('data', data => {
            res.write(data);
        });
        
        child.stderr.on('data', data => {
            res.write(data);
        });
        
        child.on('close', code => {
            res.write(`\n[SYSTEM] Orchestration process completed with exit code ${code}\n`);
            res.end();
        });
    } catch (e) {
        logger.error('[ORCHESTRATE] Error:', e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: e.message });
        }
    }
});

module.exports = router;

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ── Pavi Evolution: Zero-Budget Pipeline ──────────────────────────────
let compressionEngine, architect;
try { compressionEngine = require('./compression-engine'); } catch(e) { compressionEngine = null; }
try { architect = require('./architect'); } catch(e) { architect = null; }

let driftDetector, telemetry;
try { driftDetector = require('./services/drift-detector'); } catch(e) { driftDetector = null; }
try { telemetry = require('./services/telemetry'); } catch(e) { telemetry = null; }


function runCmd(cmd, cwd) {
    return new Promise((resolve) => {
        // Fix: wrap paths with spaces properly in 'start' commands
        // e.g. 'start index.html' becomes 'start "" "C:\path with space\index.html"'
        let sanitizedCmd = cmd;
        const startMatch = cmd.match(/^start\s+(?:""\s+)?["']?([^"']+\.html)["']?$/i);
        if (startMatch) {
            const filePath = path.isAbsolute(startMatch[1]) ? startMatch[1] : path.join(cwd, startMatch[1]);
            sanitizedCmd = `start "" "${filePath}"`;
        }
        
        exec(sanitizedCmd, { cwd }, (error, stdout, stderr) => {
            if (error) resolve(`ERROR: ${error.message}\nSTDERR: ${stderr}`);
            else resolve(stdout || stderr || "Command executed successfully. No output.");
        });
    });
}

// ---------------- NEW TOOLS SCHEMA ----------------
const orchestratorTools = [
    {
        type: "function",
        function: {
            name: "runCommand",
            description: "Execute a terminal command.",
            parameters: { type: "object", properties: { cmd: { type: "string", description: "The shell command to run" } }, required: ["cmd"] }
        }
    },
    {
        type: "function",
        function: {
            name: "readFile",
            description: "Read file contents.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path to the file" } }, required: ["path"] }
        }
    },
    {
        type: "function",
        function: {
            name: "writeFile",
            description: "Create or edit a file.",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
        }
    },
    {
        type: "function",
        function: {
            name: "listDir",
            description: "List files in a directory.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
    },
    {
        type: "function",
        function: {
            name: "grepSearch",
            description: "Search for text in a directory.",
            parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query", "path"] }
        }
    },
    {
        type: "function",
        function: {
            name: "replaceFileContent",
            description: "Replace exact text in a file.",
            parameters: { type: "object", properties: { path: { type: "string" }, target: { type: "string" }, replacement: { type: "string" } }, required: ["path", "target", "replacement"] }
        }
    },
    {
        type: "function",
        function: {
            name: "browserTest",
            description: "Open a headless browser to test a local URL and extract console logs, HTML, or take a screenshot.",
            parameters: { 
                type: "object", 
                properties: { 
                    url: { type: "string" }, 
                    action: { type: "string", enum: ["getLogs", "getHTML", "screenshot"] } 
                }, 
                required: ["url", "action"] 
            }
        }
    },
    {
        type: "function",
        function: {
            name: "generateImage",
            description: "Generate an image asset and save it locally.",
            parameters: { type: "object", properties: { prompt: { type: "string" }, filename: { type: "string" } }, required: ["prompt", "filename"] }
        }
    },
    {
        type: "function",
        function: {
            name: "getSystemContext",
            description: "Get OS info and recently modified files to understand the current workspace context.",
            parameters: { type: "object", properties: { path: { type: "string", description: "Path to project root" } }, required: ["path"] }
        }
    },
    {
        type: "function",
        function: {
            name: "discoverCapabilities",
            description: "Query the Plugin Manager to discover available plugins and their capabilities/tools at runtime.",
            parameters: { type: "object", properties: { query: { type: "string", description: "Search query for specific capabilities or tools (optional)" } } }
        }
    },
    {
        type: "function",
        function: {
            name: "done",
            description: "Finish the task.",
            parameters: { type: "object", properties: { result: { type: "string", description: "Summary of what you did" } }, required: ["result"] }
        }
    }
];

// --- PLUGIN MANAGER INTEGRATION ---
let pluginManager;
try {
    pluginManager = require('./plugin-manager');
    pluginManager.loadPlugins();
    const extraTools = pluginManager.getAdditionalTools();
    if (extraTools && extraTools.length > 0) {
        orchestratorTools.push(...extraTools);
        console.log(`[PAVI] Loaded ${extraTools.length} extra tools from Plugin Manager.`);
    }
} catch (err) {
    console.warn(`[PAVI] Warning: Plugin manager failed to load: ${err.message}`);
}

async function askModel(url, modelName, keys, messages, tools = null) {
    // Determine if endpoint is a local offline model (e.g. Ollama/LM Studio)
    const isLocal = url.includes("localhost") || url.includes("127.0.0.1") || (!keys || keys.length === 0);
    const keyList = isLocal ? ["local_key"] : keys;

    for (let i = 0; i < keyList.length; i++) {
        const key = keyList[i];
        const payload = {
            model: modelName || "gpt-3.5-turbo",
            messages: messages,
            max_tokens: 2500
        };

        if (tools) {
            payload.tools = tools;
            payload.tool_choice = "auto";
        }

        const headers = { 'Content-Type': 'application/json' };
        if (!isLocal) {
            headers['Authorization'] = `Bearer ${key}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        if (response.status === 429 && !isLocal && i < keyList.length - 1) {
            console.log(`[PAVI] Key ${i+1} rate limited. Rotating to backup key...`);
            continue;
        }

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} - ${await response.text()}`);
        }

        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message;
        } else if (data.message) {
            // Support for Ollama /api/chat endpoint
            return data.message;
        } else if (data.response) {
            // Support for Ollama /api/generate endpoint
            return { role: "assistant", content: data.response };
        }
        return { role: "assistant", content: JSON.stringify(data) };
    }
}

async function stagePendingChange(filePath, originalContent, proposedContent) {
    const port = process.env.PORT || 3000;
    const runId = process.env.SWARM_RUN_ID || `run_${Date.now()}`;
    const payload = {
        filePath,
        originalContent,
        proposedContent,
        swarmRunId: runId
    };

    console.log(`[INTERCEPT] Staging write for: ${filePath} (runId: ${runId})`);
    
    const url = `http://localhost:${port}/api/files/pending`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
        throw new Error(`Server returned status ${res.status}: ${await res.text()}`);
    }
    
    const data = await res.json();
    return data.id;
}

async function orchestrate() {
    const args = process.argv.slice(2);
    if (args.length < 8) {
        console.error("Usage: node orchestrator.js <workerUrl> <workerModel> <workerKeysJson> <reviewerUrl> <reviewerModel> <reviewerKeysJson> <prompt> <targetDir> [targetFilesJson]");
        process.exit(1);
    }

    const workerUrl = args[0];
    const workerModel = args[1];
    const workerKeys = JSON.parse(args[2]);
    const reviewerUrl = args[3];
    const reviewerModel = args[4];
    const reviewerKeys = JSON.parse(args[5]);
    const userPrompt = args[6];
    const targetDir = args[7];
    const targetFiles = args[8] ? JSON.parse(args[8]) : [];

    console.log(`[PAVI] Starting Tier 4 Autonomous Pipeline for target: ${targetDir}`);
    if (telemetry) {
        telemetry.emit('orchestrator_started', { prompt: userPrompt, targetDir, targetFiles });
    }

    let memoryContext = "No prior memories found.";
    try {
        const memRes = await runCmd(`npx claude-flow memory search --query "${userPrompt.replace(/"/g, '\\"')}"`, targetDir);
        if (!memRes.includes("ERROR")) {
            memoryContext = memRes;
        }
    } catch (e) {}

    // Pre-load Targeted Files
    let targetedFileContent = "";
    if (targetFiles.length > 0) {
        console.log(`[PAVI] Pre-loading ${targetFiles.length} targeted files for context...`);
        for (const file of targetFiles) {
            const fullPath = path.isAbsolute(file) ? file : path.join(targetDir, file);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    targetedFileContent += `\n\n--- FILE: ${file} ---\n${content}\n`;
                } catch (e) {}
            }
        }
    }

    const maxLoops = 3;
    let iteration = 1;
    let isApproved = false;
    const capturedFiles = [];
    let finalSummary = "";

    // ── Stage 0: Zero-Budget Compression (try local expansion first) ────────
    let processedPrompt = userPrompt;
    let compressionStats = null;
    if (compressionEngine) {
        try {
            const result = await compressionEngine.run(userPrompt);
            compressionStats = result.stats;
            if (!result.apiCalled && result.code && result.code.trim().length > 20) {
                console.log(`[COMPRESSION] ✅ Local expansion succeeded (${result.stats.compression?.compressionRatio || '?'}x reduction). Injecting scaffold.`);
                // Prepend local scaffold to prompt so worker has a head start
                processedPrompt = `${userPrompt}\n\n[LOCAL_SCAFFOLD]\n${result.code}\n[/LOCAL_SCAFFOLD]`;
            } else {
                console.log(`[COMPRESSION] Local expansion insufficient — proceeding with full API call.`);
            }
        } catch(e) {
            console.log(`[COMPRESSION] Warning: ${e.message}. Proceeding normally.`);
        }
    }

    // ── Stage 0b: Architect — generate plan + Mermaid graph ────────────────
    if (architect) {
        try {
            const plan = await architect.plan(userPrompt, {
                targetFiles,
                emitMermaid: (chunk) => {
                    if (chunk.type === 'plan_graph') {
                        // Emit Mermaid tag for app.js to intercept and render
                        process.stdout.write(`[MERMAID_GRAPH]${chunk.mermaid}[/MERMAID_GRAPH]`);
                    }
                    if (chunk.type === 'spec_graph') {
                        process.stdout.write(`[SHIELD_CONFIDENCE:${plan?.shieldResult?.confidence || 0.9}]`);
                    }
                }
            });
            console.log(`[ARCHITECT] Plan locked: ${plan.id} (${plan.steps.length} steps)`);
        } catch(e) {
            console.log(`[ARCHITECT] Warning: ${e.message}. Proceeding without plan graph.`);
        }
    }


    const systemPrompt = `You are Pavi, an advanced Tier 4 autonomous AI agent. Your goal is to complete the user's request perfectly.
You have access to native tools. Use them to read files, write files, run commands, or test the browser.
When you have finished ALL work, call the "done" tool with a summary.

━━━ SKILL SYSTEM ━━━
You have been given skills in your context. READ THEM CAREFULLY before starting. 
If the task involves building a UI, game, or website, you MUST apply the $premium-ui skill rules exactly — no exceptions.
If the task involves a browser game (tic-tac-toe, chess, etc), ALSO apply $frontend-game rules.
Skills are NOT optional suggestions — treat them as MANDATORY specifications.

━━━ UI QUALITY RULES (ALWAYS ENFORCED) ━━━
1. NEVER write plain/minimal HTML with default browser styles. Every UI must look premium.
2. ALWAYS use dark gradient backgrounds, Google Fonts, and glassmorphism cards.
3. ALWAYS add CSS animations (popIn, fadeIn, pulse) to interactive elements.
4. Game board cells must be at LEAST 130x130px. Symbols must be at LEAST 3rem font size.
5. ALWAYS include: status display, score tracking, win/draw detection, and a restart button.
6. Write EVERYTHING in a single self-contained index.html file (inline CSS + JS).

━━━ EXECUTION RULES ━━━
- After writing files, ALWAYS open the result: use runCommand with: start "" "FULL_ABSOLUTE_PATH_TO_FILE"
- ALWAYS wrap file paths in double quotes to handle spaces in folder names (e.g. "C:\\Users\\MR HACKER\\...").
- Never say "done" without actually launching the output if the user asked to "run it" or "see it".

━━━ FILE EDITING STRATEGY (CRITICAL) ━━━
- REDESIGN / IMPROVE / ADD FEATURE / FIX BUG → Always use readFile first, then writeFile with the COMPLETE new file. Never do partial edits for these.
- TINY FIX (1-2 lines, e.g. one color or variable) → Only then use replaceFileContent, but ONLY after using readFile to confirm the exact target text exists verbatim.
- replaceFileContent WILL BREAK THE FILE if the target text doesn't match exactly. When in doubt, use writeFile with the full content.

━━━ CONTEXTUAL MEMORY ━━━
${memoryContext.substring(0, 500)}...

━━━ TARGETED FILE CONTENT ━━━
${targetedFileContent}
`;

    // Load skills (Static + Semantic Vector Search)
    let skillsContext = "";
    const loadedSkillTags = [];
    try {
        // 1. Static Skills
        const skillsPath = path.join(__dirname, 'skills.json');
        if (fs.existsSync(skillsPath)) {
            const skills = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
            for (const s of skills) {
                if (userPrompt.toLowerCase().includes(s.tag.toLowerCase()) || 
                    processedPrompt.toLowerCase().includes(s.tag.toLowerCase())) {
                    loadedSkillTags.push(s.tag);
                }
            }
            skillsContext = skills.map(s => `SKILL [${s.tag}]:\n${s.description}`).join('\n\n---\n\n');
        }

        // 2. Semantic Skills from AgentDB
        try {
            const memory = require('./memory');
            const semanticSkills = await memory.searchSkills(userPrompt, 3);
            if (semanticSkills && semanticSkills.length > 0) {
                for (const s of semanticSkills) {
                    if (!loadedSkillTags.includes(s.tag)) {
                        loadedSkillTags.push(s.tag);
                    }
                }
                const vectorSkills = semanticSkills.map(s => `VECTOR_SKILL [${s.tag}]:\n${s.description}\n${s.content || ""}`).join('\n\n---\n\n');
                skillsContext += `\n\n━━━ SEMANTICALLY RELEVANT PATTERNS (FROM AgentDB) ━━━\n${vectorSkills}`;
            }
        } catch(dbErr) {
            console.log(`[PAVI] AgentDB Search skipped (DB might be empty or initializing).`);
        }
    } catch(e) {}

    let workerMessages = [
        { role: "system", content: systemPrompt },
        // Use compression-processed prompt (has local scaffold if available)
        { role: "user", content: `━━━ AVAILABLE SKILLS (READ BEFORE STARTING) ━━━\n${skillsContext}\n\n━━━ YOUR TASK ━━━\n${processedPrompt}\n\nTarget Directory: ${targetDir}${targetFiles.length > 0 ? '\n\nFocus ONLY on these specific files selected by the user:\n' + targetFiles.join('\n') : ''}\n\nRemember: Apply any relevant skill rules EXACTLY as specified above.` }
    ];


    while (iteration <= maxLoops && !isApproved) {
        console.log(`\n[PAVI] --- Review Iteration ${iteration} ---`);
        if (telemetry) {
            telemetry.emit('orchestrator_loop_started', { iteration, maxLoops });
        }
        
        let workerDone = false;
        let workerLoops = 0;
        finalSummary = "";

        while (!workerDone && workerLoops < 15) {
            workerLoops++;
            console.log(`[WORKER] Generating action...`);
            
            try {
                const responseMsg = await askModel(workerUrl, workerModel, workerKeys, workerMessages, orchestratorTools);
                
                // Add the assistant's message back to the thread
                workerMessages.push(responseMsg);

                if (responseMsg.content && !responseMsg.tool_calls) {
                    console.log(`[WORKER] Message: ${responseMsg.content}`);
                }

                if (responseMsg.tool_calls && responseMsg.tool_calls.length > 0) {
                    for (const tc of responseMsg.tool_calls) {
                        let argsObj = {};
                        try {
                            argsObj = JSON.parse(tc.function.arguments);
                        } catch (e) {
                            workerMessages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: "Error parsing arguments JSON." });
                            continue;
                        }

                        const cmd = tc.function.name;
                        let outText = "";

                        if (cmd === "done") {
                            console.log(`[WORKER] Finished task.`);
                            finalSummary = argsObj.result || "Task completed.";
                            workerDone = true;
                            outText = "Success";
                        } else if (cmd === "runCommand") {
                            console.log(`[WORKER] Running command: ${argsObj.cmd}`);
                            // Ensure node/npm commands use a safe cwd
                            const safeCwd = (targetDir && targetDir.trim()) ? targetDir : process.cwd();
                            const out = await runCmd(argsObj.cmd, safeCwd);
                            outText = out.substring(0, 2000);
                        } else if (cmd === "readFile") {
                            console.log(`[WORKER] Reading file: ${argsObj.path}`);
                            try {
                                const content = fs.readFileSync(argsObj.path, 'utf8');
                                outText = content.substring(0, 3000);
                            } catch (err) { outText = `Error: ${err.message}`; }
                        } else if (cmd === "writeFile") {
                            console.log(`[WORKER] Intercepting write file: ${argsObj.path}`);
                            try {
                                const fullPath = path.isAbsolute(argsObj.path) ? argsObj.path : path.resolve(targetDir, argsObj.path);
                                let originalContent = "";
                                if (fs.existsSync(fullPath)) {
                                    originalContent = fs.readFileSync(fullPath, 'utf8');
                                }
                                const proposedContent = argsObj.content;
                                await stagePendingChange(fullPath, originalContent, proposedContent);
                                outText = "File write intercepted and staged for user approval. It will not be written to disk until approved.";
                            } catch (err) { outText = `Error staging pending change: ${err.message}`; }
                        } else if (cmd === "listDir") {
                            console.log(`[WORKER] Listing directory: ${argsObj.path}`);
                            try {
                                const files = fs.readdirSync(argsObj.path);
                                outText = files.join('\n');
                            } catch (err) { outText = `Error: ${err.message}`; }
                        } else if (cmd === "grepSearch") {
                            console.log(`[WORKER] Searching for '${argsObj.query}' in ${argsObj.path}`);
                            const out = await runCmd(`git grep -nI "${argsObj.query}" || grep -rnI "${argsObj.query}" .`, argsObj.path || targetDir);
                            outText = out.substring(0, 2000);
                        } else if (cmd === "replaceFileContent") {
                            console.log(`[WORKER] Intercepting replace content in file: ${argsObj.path}`);
                            try {
                                const fullPath = path.isAbsolute(argsObj.path) ? argsObj.path : path.resolve(targetDir, argsObj.path);
                                if (fs.existsSync(fullPath)) {
                                    const originalContent = fs.readFileSync(fullPath, 'utf8');
                                    if (originalContent.includes(argsObj.target)) {
                                        const proposedContent = originalContent.replace(argsObj.target, argsObj.replacement);
                                        await stagePendingChange(fullPath, originalContent, proposedContent);
                                        outText = "File modification intercepted and staged for user approval. It will not be written to disk until approved.";
                                    } else {
                                        outText = "Error: target text not found in file.";
                                    }
                                } else {
                                    outText = "Error: File not found.";
                                }
                            } catch (err) { outText = `Error staging pending change: ${err.message}`; }
                        } else if (cmd === "browserTest") {
                            console.log(`[WORKER] Browser Test: ${argsObj.url} [${argsObj.action}]`);
                            try {
                                const puppeteer = require('puppeteer');
                                const browser = await puppeteer.launch({ headless: true });
                                const page = await browser.newPage();
                                const logs = [];
                                page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
                                await page.goto(argsObj.url, { waitUntil: 'networkidle2' });
                                
                                if (argsObj.action === 'getLogs') {
                                    outText = `Browser Logs:\n${logs.join('\n') || "No logs."}`;
                                } else if (argsObj.action === 'getHTML') {
                                    const html = await page.content();
                                    outText = `HTML (truncated):\n${html.substring(0, 2000)}`;
                                } else if (argsObj.action === 'screenshot') {
                                    const snapPath = path.join(targetDir, `screenshot_${Date.now()}.png`);
                                    await page.screenshot({ path: snapPath });
                                    outText = `Screenshot saved to ${snapPath}`;
                                }
                                await browser.close();
                            } catch (err) { outText = `Browser Error: ${err.message}`; }
                        } else if (cmd === "generateImage") {
                            console.log(`[WORKER] Generating image: ${argsObj.filename}`);
                            try {
                                const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(argsObj.prompt)}?nologo=true`;
                                const res = await fetch(url);
                                const buffer = await res.arrayBuffer();
                                fs.writeFileSync(path.join(targetDir, argsObj.filename), Buffer.from(buffer));
                                outText = `Image generated and saved as ${argsObj.filename}`;
                            } catch (err) { outText = `Error: ${err.message}`; }
                        } else if (cmd === "discoverCapabilities") {
                            console.log(`[WORKER] Discovering plugin capabilities...`);
                            try {
                                if (pluginManager) {
                                    const tools = pluginManager.listTools();
                                    const query = argsObj.query ? argsObj.query.toLowerCase() : "";
                                    let filtered = tools;
                                    if (query) {
                                        filtered = tools.filter(t => 
                                            t.function.name.toLowerCase().includes(query) || 
                                            t.function.description.toLowerCase().includes(query)
                                        );
                                    }
                                    outText = JSON.stringify({
                                        success: true,
                                        query: argsObj.query || null,
                                        availableTools: filtered.map(t => ({
                                            name: t.function.name,
                                            description: t.function.description,
                                            parameters: t.function.parameters
                                        }))
                                    }, null, 2);
                                } else {
                                    outText = "Error: Plugin Manager is not initialized.";
                                }
                            } catch (err) {
                                outText = `Error discovering capabilities: ${err.message}`;
                            }
                        } else if (cmd === "getSystemContext") {
                            console.log(`[WORKER] Getting system context`);
                            try {
                                const osInfo = `${process.platform} ${process.arch} Node ${process.version}`;
                                const dir = argsObj.path || targetDir;
                                let recentFiles = [];
                                if (fs.existsSync(dir)) {
                                    const files = fs.readdirSync(dir);
                                    const stats = files.filter(f => !f.startsWith('.')).map(f => {
                                        try { return { name: f, time: fs.statSync(path.join(dir, f)).mtime.getTime() }; } 
                                        catch(e) { return null; }
                                    }).filter(f => f);
                                    stats.sort((a,b) => b.time - a.time);
                                    recentFiles = stats.slice(0, 5).map(f => f.name);
                                }
                                outText = `OS: ${osInfo}\nRecent Files: ${recentFiles.join(', ')}`;
                            } catch (err) { outText = `Error: ${err.message}`; }
                        } else {
                            if (pluginManager && pluginManager.plugins && pluginManager.plugins.some(p => p.tools && p.tools.some(t => t.function.name === cmd))) {
                                console.log(`[WORKER] Executing custom plugin tool: ${cmd}`);
                                try {
                                    outText = await pluginManager.executeCustomTool(cmd, argsObj);
                                } catch (err) { outText = `Plugin Error: ${err.message}`; }
                            } else {
                                outText = "Unknown tool call.";
                            }
                        }

                        workerMessages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            name: tc.function.name,
                            content: outText || "Success"
                        });
                    }
                }

                if (!responseMsg.tool_calls && !responseMsg.content) {
                     workerMessages.push({ role: "user", content: "You returned an empty response. You must call a tool or provide text." });
                }

            } catch (err) {
                console.error(`[WORKER] Fatal Error: ${err.message}`);
                workerDone = true; // Abort
            }
        }

        // Escalation Bypass: If Worker had zero errors, skip Premium Reviewer
        const hasErrors = workerMessages.some(m => m.role === "tool" && typeof m.content === "string" && (m.content.includes("Error:") || m.content.includes("Fatal Error:")));
        
        if (!hasErrors && finalSummary) {
            console.log(`[ESCALATION ENGINE] Worker completed tasks with zero runtime errors. Bypassing Premium Reviewer API to save limits.`);
            if (telemetry) {
                telemetry.emit('orchestrator_reviewer_bypassed', { iteration, finalSummary });
            }
            isApproved = true;
            break;
        }

        // Reviewer Phase (Escalated due to errors or uncertainty)
        console.log(`[ESCALATION ENGINE] Errors detected or Worker failed. Escalating to Premium Reviewer API for healing...`);
        
        const errorLogs = workerMessages.filter(m => m.role === "tool" && typeof m.content === "string" && m.content.includes("Error:")).map(m => m.content).join(" | ");
        const reviewPrompt = `You are a strict code reviewer. Evaluate the following summary of work done. The worker encountered errors during execution. Reply with 'REJECTED: ' followed by instructions on what the worker needs to fix to heal the process.
        
Task Summary: ${finalSummary}
Errors Encountered: ${errorLogs}`;

        try {
            const reviewMessages = [{ role: "user", content: reviewPrompt }];
            const reviewMsg = await askModel(reviewerUrl, reviewerModel, reviewerKeys, reviewMessages);
            const reviewResult = reviewMsg.content || "";
            
            if (reviewResult.trim().startsWith("APPROVED")) {
                console.log(`[REVIEWER] Status: APPROVED! Output is solid.`);
                if (telemetry) {
                    telemetry.emit('orchestrator_reviewer_approved', { iteration, finalSummary });
                }
                isApproved = true;
            } else {
                console.log(`[REVIEWER] Status: REJECTED!`);
                if (telemetry) {
                    telemetry.emit('orchestrator_reviewer_rejected', { iteration, reviewResult, errorLogs });
                }
                console.log(reviewResult);
                
                // --- HARVEST REJECTIONS FOR SELF-IMPROVEMENT ---
                try {
                    const harvester = require('./harvester');
                    const harvestResult = await harvester.capture({
                        workerOutput: workerMessages.filter(m => m.role === 'assistant' || m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m)).join('\n'),
                        critique: reviewResult,
                        originalPrompt: userPrompt
                    });
                    if (harvestResult && harvestResult.filePath) {
                        capturedFiles.push(harvestResult.filePath);
                        console.log(`[HARVESTER] Tracked rejection file for post-approval correction: ${harvestResult.filePath}`);
                    }
                } catch (err) {
                    console.log(`[HARVESTER] Failed to capture rejection: ${err.message}`);
                }
                
                workerMessages.push({ role: "user", content: `The reviewer rejected your work with the following feedback. Fix these issues:\n${reviewResult}` });
                iteration++;
                if (iteration <= maxLoops) console.log(`[PAVI] Sending back to Worker...`);
            }
        } catch (err) {
            console.error(`[REVIEWER] Error: ${err.message}`);
            break;
        }

        if (driftDetector) {
            try {
                const driftInfo = driftDetector.detectDrift();
                if (driftInfo && driftInfo.drifting) {
                    console.log(`[DRIFT_DETECTOR] WARNING: Worker performance drift detected! Recommendation: ${driftInfo.recommendation}`);
                }
                if (telemetry) {
                    telemetry.emit('drift_check', driftInfo);
                }
            } catch (driftErr) {
                console.warn('[ORCHESTRATOR] Drift detection failed:', driftErr.message);
            }
        }
    }

    if (!isApproved) {
        console.log(`\n[PAVI] Max retries reached. Forcing approval.`);
    }

    console.log(`[PAVI] Pipeline complete.`);

    if (isApproved && capturedFiles.length > 0) {
        console.log(`[ORCHESTRATOR] Updating ${capturedFiles.length} captured rejection files with final correction...`);
        for (const filePath of capturedFiles) {
            try {
                if (fs.existsSync(filePath)) {
                    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    existing.corrected = finalSummary;
                    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
                    console.log(`[ORCHESTRATOR] Updated correction in rejection file: ${filePath}`);
                }
            } catch (e) {
                console.error(`[ORCHESTRATOR] Failed to update correction for ${filePath}: ${e.message}`);
            }
        }
    }

    // Record skill usage in feedback loops (GAP-5)
    if (loadedSkillTags.length > 0) {
        try {
            const skillFeedback = require('./services/skill-feedback');
            for (const tag of loadedSkillTags) {
                console.log(`[ORCHESTRATOR] Recording usage for skill: ${tag} (Success: ${isApproved})`);
                skillFeedback.recordUsage(tag, isApproved);
            }
        } catch (e) {
            console.error(`[ORCHESTRATOR] Failed to record skill feedback: ${e.message}`);
        }
    }

    if (telemetry) {
        telemetry.emit('orchestrator_completed', { isApproved, finalSummary });
    }
}

orchestrate();

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ── Pavi Evolution: Singularity Loop ──────────────────────────────────────
const arena = require('./arena');
const patternMemory = require('./pattern-memory');

// ── Pavi Expansion: Autonomous Learning Pipeline ──────────────────────────
const intakeFilter    = require('./intake-filter');
const intentClassifier = require('./intent-classifier');
const gapDetector     = require('./gap-detector');
const skillWriter     = require('./skill-writer');
const auditLog        = require('./audit-log');


function runCmd(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout || stderr);
        });
    });
}

async function askModel(url, modelName, keys, prompt) {
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const payload = {
            model: modelName || "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1000
        };
        let retries = 3;
        while (retries > 0) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    body: JSON.stringify(payload)
                });
                
                if (response.status === 429 && i < keys.length - 1) {
                    console.log(`[INGESTER] Key ${i+1} rate limited. Rotating to backup key...`);
                    break; // Break the retry loop to continue to the next key
                }
                
                if (!response.ok) throw new Error(`API Error: ${response.status} - ${await response.text()}`);
                const data = await response.json();
                if (data.choices && data.choices[0] && data.choices[0].message) return data.choices[0].message.content;
                if (data.response) return data.response;
                return JSON.stringify(data);
            } catch (err) {
                if (err.message.includes('API Error')) {
                    throw err; // Don't retry client/server errors like 400 or 500 here unless specific
                }
                console.error(`[INGESTER] Fetch failed for URL: ${url} (Key index: ${i}). Retries left: ${retries - 1}. Error: ${err.message}`);
                retries--;
                if (retries === 0) {
                    throw err;
                }
                // Wait before retrying (exponential backoff)
                await new Promise(r => setTimeout(r, (4 - retries) * 1500));
            }
        }
    }
}

// Function to recursively read all files, skipping binaries
function readDirectory(dir, allFiles = []) {
    const files = fs.readdirSync(dir);
    for (let f of files) {
        const fullPath = path.join(dir, f);
        if (fs.statSync(fullPath).isDirectory()) {
            readDirectory(fullPath, allFiles);
        } else {
            // Ignore common binaries and useless folders
            if (!fullPath.match(/\.(png|jpg|jpeg|gif|exe|dll|zip|tar|gz|pdf|o|obj|bin|hex)$/i)) {
                allFiles.push(fullPath);
            }
        }
    }
    return allFiles;
}

async function ingest() {
    const args = process.argv.slice(2);
    if (args.length < 8) {
        console.error("Missing arguments");
        process.exit(1);
    }
    const workerModel = args[3];
    const workerKeys = JSON.parse(args[4]);
    let reviewerUrl = args[5];
    const reviewerModel = args[6];
    const reviewerKeys = JSON.parse(args[7]);
    const zipPath = args[0];
    let topicHint = args[1];
    let workerUrl = args[2];

    // Normalize localhost to 127.0.0.1 to avoid Windows IPv6 loopback resolution failures
    if (workerUrl && workerUrl.includes('localhost')) workerUrl = workerUrl.replace('localhost', '127.0.0.1');
    if (reviewerUrl && reviewerUrl.includes('localhost')) reviewerUrl = reviewerUrl.replace('localhost', '127.0.0.1');

    // If topicHint is empty, derive it from the zip filename
    const effectiveTopicHint = (topicHint && topicHint.trim() && topicHint !== 'undefined')
        ? topicHint
        : path.basename(zipPath, '.zip').replace(/-main$/, '').replace(/[-_]/g, ' ');
    topicHint = effectiveTopicHint;

    console.log(`[INGESTER] Starting Brain Dump for: ${zipPath}`);
    const tempDir = path.join(__dirname, '..', '__ingest_temp_' + Date.now());

    try {
        console.log(`[INGESTER] Step 1/7: Checking archive safety and unzipping...`);
        const stats = fs.statSync(zipPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        if (fileSizeMB > 200) {
            throw new Error(`Zip Bomb Protection: File size (${fileSizeMB.toFixed(2)} MB) exceeds the 200MB safety limit.`);
        }
        
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        
        // Use PowerShell to extract
        await runCmd(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`);
        console.log(`[INGESTER] Extraction complete.`);

        console.log(`[INGESTER] Step 2/7: Scanning logic files for patterns and secrets...`);
        const files = readDirectory(tempDir);
        let codeContext = "";
        
        const keyRegex = /(?:gsk_[a-zA-Z0-9]{25,}|sk-(?:proj-)?[a-zA-Z0-9\-_]{30,})/g;
        let foundKeys = new Set();
        
        for (let file of files) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                // Basic check to ensure it's text (if it includes null bytes, skip)
                if (content.indexOf('\0') === -1) {
                    codeContext += `\n--- File: ${path.basename(file)} ---\n${content.substring(0, 10000)}\n`;
                    
                    // Secret File/Key Extraction
                    let match;
                    while ((match = keyRegex.exec(content)) !== null) {
                        if (!foundKeys.has(match[0])) {
                            foundKeys.add(match[0]);
                            console.log(`\n[SECRET_KEY_FOUND] ${match[0]}\n`);
                        }
                    }
                }
            } catch(e) {}
        }

        // ── DEPENDENCY GRAPH: Extract package.json / requirements.txt ────────────────
        let depGraph = {};
        for (const file of files) {
            const basename = path.basename(file).toLowerCase();
            if (basename === 'package.json') {
                try {
                    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
                    depGraph.npm = {
                        name: pkg.name,
                        main_deps: Object.keys(pkg.dependencies || {}).slice(0, 20),
                        dev_deps: Object.keys(pkg.devDependencies || {}).slice(0, 10),
                        scripts: Object.keys(pkg.scripts || {})
                    };
                    console.log(`[INGESTER] 📦 Found package.json: ${depGraph.npm.main_deps.length} dependencies`);
                } catch(e) {}
            }
            if (basename === 'requirements.txt' || basename === 'pyproject.toml') {
                try {
                    const content = fs.readFileSync(file, 'utf8');
                    const deps = content.split('\n')
                        .map(l => l.trim().split(/[>=<!=]/)[0].trim())
                        .filter(l => l && !l.startsWith('#'));
                    depGraph.python = { deps: deps.slice(0, 30) };
                    console.log(`[INGESTER] 🐍 Found Python deps: ${deps.length} packages`);
                } catch(e) {}
            }
            if (basename === 'cargo.toml') {
                depGraph.rust = { detected: true };
            }
            if (basename === 'go.mod') {
                depGraph.go = { detected: true };
            }
        }

        // Inject dep graph into codeContext as a high-signal prefix
        if (Object.keys(depGraph).length > 0) {
            const depSummary = `\n--- DEPENDENCY MANIFEST ---\n${JSON.stringify(depGraph, null, 2)}\n--- END MANIFEST ---\n`;
            codeContext = depSummary + codeContext;
            console.log(`[INGESTER] 🔗 Dependency graph injected into analysis context`);
        }

        // ── README PRIORITY EXTRACTION ────────────────────────────────────────────
        let readmeContent = '';
        for (const file of files) {
            const basename = path.basename(file).toLowerCase();
            if (basename === 'readme.md' || basename === 'readme.txt' || basename === 'readme') {
                try {
                    readmeContent = fs.readFileSync(file, 'utf8').substring(0, 5000);
                    console.log(`[INGESTER] 📖 README extracted (${readmeContent.length} chars) — injecting as priority context`);
                } catch(e) {}
                break;
            }
        }

        // Inject README at the VERY TOP of codeContext (highest signal)
        if (readmeContent) {
            codeContext = `\n=== PROJECT README (HIGHEST PRIORITY) ===\n${readmeContent}\n=== END README ===\n\n` + codeContext;
        }

        // ── STEP 2b: CODE CARTOGRAPHER (zero LLM cost) ────────────────────────────────
        console.log(`[INGESTER] Step 2b/7: Running structural code cartography (free)...`);
        let codeMap = null;
        try {
            const cartographer = require('./services/code-cartographer');
            codeMap = cartographer.cartograph(files, tempDir);
            console.log(`[INGESTER] 🗺️  CodeMap: ${codeMap.routeTree.length} routes, ${codeMap.domainEntities.length} entities, ${codeMap.integrations.length} integrations, ${codeMap.featureGroups.length} feature groups`);
            if (codeMap.projectDescription) {
                console.log(`[INGESTER] 📋 Project: "${codeMap.projectDescription.substring(0, 100)}"`);
            }

            // Inject CodeMap as structured JSON prefix into codeContext (after README, before files)
            const codeMapSummary = `\n=== STRUCTURAL CODE MAP (AUTO-EXTRACTED, NO LLM) ===\n${JSON.stringify(codeMap, null, 2)}\n=== END CODE MAP ===\n\n`;
            codeContext = codeMapSummary + codeContext;

            // Override topicHint with project description if we found a better one
            if (codeMap.projectDescription && codeMap.projectDescription.length > 10 && topicHint === path.basename(zipPath, '.zip').replace(/-main$/, '').replace(/[-_]/g, ' ')) {
                topicHint = codeMap.projectDescription.substring(0, 120);
                console.log(`[INGESTER] 📌 Topic override from CodeMap: "${topicHint}"`);
            }

            // Persist CodeMap to DB
            try {
                const { db } = require('./db');
                db.prepare(`INSERT OR REPLACE INTO code_maps (id, zip_name, topic_hint, code_map, created_at) VALUES (?, ?, ?, ?, ?)`)
                  .run(require('crypto').randomUUID(), path.basename(zipPath), topicHint, JSON.stringify(codeMap), Date.now());
            } catch (_) {}

        } catch(e) {
            console.warn(`[INGESTER] Step 2b: Cartography failed (non-critical): ${e.message}`);
            codeMap = null;
        }

        // ── INTAKE GATE: Domain score before any LLM call ─────────────────
        const repoKey = `github.com/${topicHint.replace(/[^a-zA-Z0-9/_-]/g, '_')}`;
        const sampleContext = codeContext.slice(0, 50000);
        const intakeResult = intakeFilter.gate(repoKey, files, sampleContext, topicHint);
        console.log(`[INGESTER] Intake gate result: ${intakeResult.outcome.toUpperCase()} (score: ${intakeResult.score})`);
        console.log(`[INGESTER] ${intakeResult.notification}`);

        if (intakeResult.outcome === 'rejected') {
            console.log(`[INGESTER] Repo rejected — stopping ingestion pipeline.`);
            return; // Skip all LLM calls
        }

        if (intakeResult.outcome === 'quarantine') {
            console.log(`[INGESTER] Repo quarantined — skipping LLM analysis. Will rescore nightly.`);
            if (intakeResult.rescuedPatterns.length > 0) {
                console.log(`[INGESTER] Rescued ${intakeResult.rescuedPatterns.length} universal pattern(s): ${intakeResult.rescuedPatterns.join(', ')}`);
                // Store just the universal patterns in memory (no LLM call)
                await patternMemory.store(
                    `quarantine-rescue-${Date.now()}`,
                    `Universal patterns rescued from quarantined repo: ${intakeResult.rescuedPatterns.join(', ')}`,
                    `quarantine:${repoKey}`
                );
            }
            return;
        }

        // Partial ingest: trim context to universal patterns only
        if (intakeResult.outcome === 'partial') {
            console.log(`[INGESTER] Partial ingest — limiting analysis to rescued patterns only.`);
            const rescued = intakeResult.rescuedPatterns;
            if (rescued.length === 0) {
                console.log(`[INGESTER] No universal patterns to rescue. Stopping.`);
                return;
            }
            // Filter code context to only sections containing universal patterns
            const lines = codeContext.split('\n');
            codeContext = lines.filter(l => rescued.some(p => l.toLowerCase().includes(p))).join('\n').slice(0, 5000);
        }
        // ──────────────────────────────────────────────────────────────────

        // Auto-inject harvested keys into the active rotation pool!
        for (let key of foundKeys) {
            if (!workerKeys.includes(key)) workerKeys.unshift(key); // Put new keys first
            if (!reviewerKeys.includes(key)) reviewerKeys.unshift(key);
        }

        // ── STEP 3: DEEP SEMANTIC EXTRACTION (multi-chunk) ────────────────────────
        console.log(`[INGESTER] Step 3/7: Deep semantic extraction across all code chunks...`);
        const chunkedExtractor = require('./services/chunked-extractor');
        const { mergedKnowledge: chunkKnowledge, chunkCount } = await chunkedExtractor.extractAll(
            codeContext, topicHint, askModel, workerUrl, workerModel, workerKeys, codeMap
        );
        console.log(`[INGESTER] Multi-chunk extraction complete (${chunkCount} chunks processed).`);

        if (chunkCount === 0) {
            console.error(`[INGESTER] Fatal Error: 0 chunks extracted. Worker LLM (${workerUrl}) is unreachable.`);
            console.error(`[INGESTER] Tip: If using Ollama, run 'ollama serve' and make sure your model is pulled.`);
            console.error(`[INGESTER] Tip: If using an online API, check your API key in Settings > Maker & Checker Engine.`);
            console.error(`[INGESTER] Brain Dump aborted — no knowledge was absorbed.`);
            
            // Mark as failed so we can retry
            try {
                const zipName = path.basename(zipPath);
                const { db } = require('./db');
                db.prepare(`UPDATE architect_known_repos SET ingestion_status='failed' WHERE owner='zip-upload' AND repo=?`).run(zipName);
            } catch (_) {}
            
            process.exit(1);
        }

        // chunkKnowledge is always a non-empty string (header template) even when all chunks fail.
        // Check for actual extracted content by testing if any real data sections are non-trivial.
        const hasRealContent = chunkKnowledge && chunkKnowledge.length > 200 &&
            !/## Knowledge Extracted from 0\//.test(chunkKnowledge);

        // Fall back to single-shot only if chunk extraction truly yielded nothing
        const analysis = hasRealContent ? chunkKnowledge : await askModel(workerUrl, workerModel, workerKeys,
            `Analyze this codebase about "${topicHint}". Extract key patterns, algorithms, and architecture:\n\n${codeContext.substring(0, 6000)}`
        );
        if (!hasRealContent) {
            console.log(`[INGESTER] Chunked extraction yielded no real content. Using single-shot fallback.`);
        }
        console.log(`[INGESTER] Analysis complete (${analysis.length} chars).`);

        // ── STEP 3b: SYNTHESIS PASS ───────────────────────────────────────────────────
        console.log(`[INGESTER] Step 3b/7: Synthesis pass — asking worker LLM the big picture questions...`);
        let synthesis = {
            whatIsIt: topicHint,
            whoUsesIt: '',
            coreFlow: '',
            bestPattern: '',
            techStack: '',
        };

        try {
            const synthesisPrompt = `You have just analyzed a software project called "${codeMap?.projectName || topicHint}".

PROJECT METADATA (from static analysis):
- Description: ${codeMap?.projectDescription || topicHint}
- Entry point: ${codeMap?.entryPoint || 'unknown'}
- API routes: ${codeMap?.routeTree?.length || 0} endpoints
- Domain entities: ${codeMap?.domainEntities?.map(e => e.name).join(', ') || 'unknown'}
- Integrations: ${codeMap?.integrations?.map(i => `${i.package}(${i.purpose})`).join(', ') || 'none detected'}

FEATURE ANALYSIS SUMMARY:
${analysis.substring(0, 8000)}

Answer EXACTLY these 5 questions. Be direct and specific. No preamble. No filler sentences.
Reference actual code details (function names, routes, models) when possible.

WHAT_IS_IT: What does this application do in one sentence? (max 30 words)
WHO_USES_IT: Who are the intended users and what problem does it solve for them? (max 40 words)
CORE_FLOW: Describe the primary data flow: what the user does → what the system does → what the result is. (max 60 words)
BEST_PATTERN: What is the single most reusable architectural pattern in this codebase? Explain it generically so it applies to other projects. (max 80 words)
TECH_STACK: Format exactly as: Frontend: X | Backend: Y | Database: Z | Queue: Q | Auth: A (use "None" for missing layers)`;

            const synthesisRaw = await askModel(workerUrl, workerModel, workerKeys, synthesisPrompt);
            console.log(`[INGESTER] Synthesis response received (${synthesisRaw.length} chars).`);

            // ── Parse synthesis output ────────────────────────────────────────────────
            const extractField = (text, label) => {
                const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`);
                const m = text.match(re);
                return m ? m[1].trim().replace(/\n/g, ' ') : '';
            };

            synthesis = {
                whatIsIt:    extractField(synthesisRaw, 'WHAT_IS_IT')   || topicHint,
                whoUsesIt:   extractField(synthesisRaw, 'WHO_USES_IT')  || '',
                coreFlow:    extractField(synthesisRaw, 'CORE_FLOW')    || '',
                bestPattern: extractField(synthesisRaw, 'BEST_PATTERN') || '',
                techStack:   extractField(synthesisRaw, 'TECH_STACK')   || '',
            };

            if (synthesis.whatIsIt) {
                console.log(`[INGESTER] 💡 "${synthesis.whatIsIt}"`);
            }
        } catch(e) {
            console.warn(`[INGESTER] Synthesis pass failed (non-critical, continuing): ${e.message}`);
            // synthesis keeps default values — pipeline continues
        }

        // Build synthesizedAnalysis — prepend synthesis block to feed the reviewer
        const synthesizedAnalysis = synthesis.whatIsIt
            ? `## SYNTHESIS\n\n**What it is:** ${synthesis.whatIsIt}\n**Who uses it:** ${synthesis.whoUsesIt}\n**Core flow:** ${synthesis.coreFlow}\n**Best pattern:** ${synthesis.bestPattern}\n**Tech stack:** ${synthesis.techStack}\n\n---\n\n## FULL FEATURE ANALYSIS\n\n${analysis}`
            : analysis;

        console.log(`[INGESTER] Step 4/7: Verifying with Reviewer Model...`);

        const reviewerPrompt = `You are an expert software architect conducting a final review of a codebase analysis.

PROJECT: ${codeMap?.projectName || topicHint}
ONE-LINE SUMMARY: ${synthesis.whatIsIt || topicHint}
ROUTE COUNT: ${codeMap?.routeTree?.length || 0}
DOMAIN ENTITIES: ${codeMap?.domainEntities?.map(e => e.name).join(', ') || 'none detected'}
INTEGRATIONS: ${codeMap?.integrations?.map(i => `${i.package}(${i.purpose})`).join(', ') || 'none'}

ANALYSIS TO REVIEW:
${synthesizedAnalysis.substring(0, 10000)}

Respond in EXACTLY this format (all 5 sections required):

VERIFICATION: [State whether the analysis is accurate, or flag specific hallucinations/inaccuracies. Be brief.]
ENRICHMENT: [Add any important patterns or insights the feature analysis missed. Or write "None missed."]
SUMMARY: [Write a single paragraph of 100-150 words that any developer can read to immediately understand this codebase. Be specific: mention the stack, the core features, the data model, and the primary design pattern.]
SKILLS:
- $tag-name: one sentence describing a reusable skill learned from this codebase
- $tag-name: one sentence describing a reusable skill learned from this codebase
- $tag-name: one sentence describing a reusable skill learned from this codebase
VERDICT: EXCELLENT | GOOD | PARTIAL | POOR — [one sentence explaining the quality of the knowledge extracted]`;

        const verifiedKnowledge = await askModel(reviewerUrl, reviewerModel, reviewerKeys, reviewerPrompt);
        console.log(`[INGESTER] Verification complete (${verifiedKnowledge.length} chars).`);

        // ── Parse reviewer output ─────────────────────────────────────────────────────
        const parseReviewerField = (text, label) => {
            const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`);
            const m = text.match(re);
            return m ? m[1].trim() : '';
        };

        const skillsText = parseReviewerField(verifiedKnowledge, 'SKILLS');
        const reviewerSkills = skillsText
            .split('\n')
            .filter(l => l.trim().startsWith('-'))
            .map(l => {
                const m = l.match(/\$([a-z0-9-]+):\s*(.+)/);
                return m ? { tag: `$${m[1]}`, description: m[2].trim() } : null;
            })
            .filter(Boolean);

        const verdictLine = parseReviewerField(verifiedKnowledge, 'VERDICT');
        const verdict = ['EXCELLENT', 'GOOD', 'PARTIAL', 'POOR'].find(v => verdictLine.startsWith(v)) || 'PARTIAL';

        const reviewerOutput = {
            verification: parseReviewerField(verifiedKnowledge, 'VERIFICATION'),
            enrichment:   parseReviewerField(verifiedKnowledge, 'ENRICHMENT'),
            summary:      parseReviewerField(verifiedKnowledge, 'SUMMARY'),
            skills:       reviewerSkills,
            verdict,
            verdictLine,
        };

        console.log(`[INGESTER] Reviewer verdict: ${reviewerOutput.verdict}`);
        if (reviewerOutput.summary) {
            console.log(`[INGESTER] Summary preview: ${reviewerOutput.summary.substring(0, 100)}...`);
        }
        console.log(`[INGESTER] Reviewer suggested ${reviewerOutput.skills.length} skills: ${reviewerOutput.skills.map(s => s.tag).join(', ')}`);

        // ── Persist to ingestion_summaries ───────────────────────────────────────────
        try {
            const { db } = require('./db');
            db.prepare(`INSERT OR REPLACE INTO ingestion_summaries
                (id, zip_name, topic_hint, what_is_it, who_uses_it, core_flow, best_pattern,
                 tech_stack, reviewer_summary, reviewer_verdict, suggested_skills, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(
                require('crypto').randomUUID(),
                path.basename(zipPath),
                topicHint,
                synthesis.whatIsIt,
                synthesis.whoUsesIt,
                synthesis.coreFlow,
                synthesis.bestPattern,
                synthesis.techStack,
                reviewerOutput.summary,
                reviewerOutput.verdict,
                JSON.stringify(reviewerOutput.skills),
                Date.now()
              );
            console.log(`[INGESTER] ✅ Ingestion summary saved to DB.`);
        } catch(e) {
            console.warn(`[INGESTER] Warning: Failed to save ingestion summary to DB: ${e.message}`);
        }

        console.log(`\n=========================================\n[PAVI OUTPUT STREAM]\n=========================================\n${verifiedKnowledge}\n=========================================\n`);

        // ── STEP 4b: README VERIFICATION ─────────────────────────────────────────────
        console.log(`[INGESTER] Step 4b/7: README verification and discrepancy detection...`);
        let verificationReport = null;

        try {
            if (typeof readmeContent !== 'undefined' && readmeContent && readmeContent.length > 15) {
                const readmeVerifier = require('./services/readme-verifier');

                // Static extraction — zero LLM cost
                const readmePurpose = readmeVerifier.extractReadmePurpose(readmeContent);
                console.log(`[INGESTER] README claimed purpose: "${readmePurpose.claimedPurpose.substring(0, 80)}..."`);
                console.log(`[INGESTER] README tech mentions: ${readmePurpose.techMentions.join(', ') || 'none'}`);

                // Static comparison — zero LLM cost
                const comparison = readmeVerifier.compareClaimVsReality(readmePurpose, synthesis, codeMap);
                console.log(`[INGESTER] README vs code match: ${(comparison.matchScore * 100).toFixed(0)}% (${comparison.confidence} confidence)`);

                if (comparison.discrepancies.length > 0) {
                    console.log(`[INGESTER] ⚠️  ${comparison.discrepancies.length} discrepancy/discrepancies detected:`);
                    comparison.discrepancies.forEach(d => console.log(`   • ${d}`));
                } else {
                    console.log(`[INGESTER] ✅ README matches code. No discrepancies.`);
                }

                // LLM verification — only if confidence is low OR discrepancies found
                let llmVerification = null;
                if (comparison.confidence !== 'high' || comparison.discrepancies.length > 0) {
                    console.log(`[INGESTER] Running targeted LLM verification (confidence: ${comparison.confidence}, discrepancies: ${comparison.discrepancies.length})...`);

                    const verifyPrompt = `Compare this README claim against what the code actually does.

README CLAIMS: "${readmePurpose.claimedPurpose}"
README TECH MENTIONS: ${readmePurpose.techMentions.join(', ') || 'none specified'}

CODE ACTUALLY DOES: ${synthesis.whatIsIt}
ACTUAL TECH STACK: ${synthesis.techStack}
DETECTED DISCREPANCIES: ${comparison.discrepancies.join('; ') || 'none'}

Answer in EXACTLY this format:
MATCH: YES | PARTIAL | NO
EXPLANATION: [one sentence — why it matches, partially matches, or doesn't match]
LIKELY_CAUSE: outdated-readme | wrong-repo | correct-but-vague | genuinely-different | incomplete-analysis`;

                    try {
                        llmVerification = await askModel(workerUrl, workerModel, workerKeys, verifyPrompt);
                        const matchLine = (llmVerification.match(/MATCH:\s*(\w+)/) || [])[1] || 'UNKNOWN';
                        console.log(`[INGESTER] LLM verification verdict: ${matchLine}`);
                    } catch(e) {
                        console.warn(`[INGESTER] LLM verification call failed (non-critical): ${e.message}`);
                        llmVerification = null;
                    }
                }

                // Build report
                verificationReport = {
                    readmeClaimedPurpose: readmePurpose.claimedPurpose,
                    readmeTechMentions:   readmePurpose.techMentions,
                    readmeBadges:         readmePurpose.badges,
                    readmeHasCI:          readmePurpose.hasCI,
                    synthesisClaim:       synthesis.whatIsIt,
                    synthesisTechStack:   synthesis.techStack,
                    matchScore:           comparison.matchScore,
                    confidence:           comparison.confidence,
                    discrepancies:        comparison.discrepancies,
                    llmVerification:      llmVerification,
                    checkedAt:            new Date().toISOString(),
                };

                // Persist to DB (column was created in Phase 3 schema)
                try {
                    const { db } = require('./db');
                    db.prepare(`UPDATE ingestion_summaries SET readme_verification = ? WHERE zip_name = ? AND topic_hint = ?`)
                      .run(JSON.stringify(verificationReport), path.basename(zipPath), topicHint);
                    console.log(`[INGESTER] README verification report saved to DB.`);
                } catch(_) {}

            } else {
                console.log(`[INGESTER] Step 4b/7: No README content — skipping README verification.`);
            }
        } catch(e) {
            console.warn(`[INGESTER] README verification failed (non-critical, pipeline continues): ${e.message}`);
            verificationReport = null;
        }

        console.log(`[INGESTER] Step 5/7: Exporting to NotebookLM markdown file...`);
        const safeTopic = topicHint.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 30);
        
        try {
            const exportDir = path.join(__dirname, '..', 'notebook_llm_exports');
            if (!fs.existsSync(exportDir)) {
                fs.mkdirSync(exportDir, { recursive: true });
            }

            const safeFileName = `ingestion_${safeTopic}.md`;
            const exportPath = path.join(exportDir, safeFileName);
            
            const verificationSection = verificationReport ? `
## README Verification Report

| Field | Value |
|-------|-------|
| README claims | ${verificationReport.readmeClaimedPurpose.substring(0, 100)} |
| Code does | ${verificationReport.synthesisClaim.substring(0, 100)} |
| Match score | ${(verificationReport.matchScore * 100).toFixed(0)}% (${verificationReport.confidence} confidence) |
| Discrepancies | ${verificationReport.discrepancies.length === 0 ? 'None ✅' : verificationReport.discrepancies.map(d => `⚠️ ${d}`).join('; ')} |
${verificationReport.llmVerification ? `| LLM verdict | ${verificationReport.llmVerification.replace(/\n/g, ' ').substring(0, 200)} |` : ''}
` : '';

            const markdownContent = `\n# Ingestion: ${topicHint}\n\n## Analysis Details - ${new Date().toISOString()}\n\n### Original Code Context Summary\n(Extracted from zip: ${path.basename(zipPath)})\n\n### Verified Knowledge\n${verifiedKnowledge}\n${verificationSection}\n---\n`;

            fs.appendFileSync(exportPath, markdownContent);
            console.log(`[INGESTER] Successfully exported knowledge to: ${exportPath}`);
        } catch(e) {
            console.error(`[INGESTER] Warning: Failed to export to NotebookLM markdown. (${e.message})`);
        }

        console.log(`[INGESTER] Analyzing for New Skills...`);

        // ── Use reviewer-suggested skills if quality is good (skip redundant LLM call) ──
        if (['EXCELLENT', 'GOOD'].includes(reviewerOutput.verdict) && reviewerOutput.skills.length >= 2) {
            console.log(`[INGESTER] Reviewer verdict ${reviewerOutput.verdict} + ${reviewerOutput.skills.length} skills — using reviewer skills, skipping separate skill extraction.`);

            // Write skills to skills_quarantine.json (same format as existing skill writer)
            const quarantinePath = path.join(__dirname, 'skills_quarantine.json');
            let quarantine = [];
            try {
                if (fs.existsSync(quarantinePath)) quarantine = JSON.parse(fs.readFileSync(quarantinePath, 'utf8'));
            } catch (_) {}
            for (const skill of reviewerOutput.skills) {
                quarantine.push({
                    skill: { tag: skill.tag, summary: skill.description, sourceRepo: topicHint },
                    suggestedBy: 'reviewer-phase3',
                    quarantinedAt: new Date().toISOString(),
                });
            }
            try { fs.writeFileSync(quarantinePath, JSON.stringify(quarantine, null, 4)); } catch (_) {}

        } else {
            console.log(`[INGESTER] Verdict ${reviewerOutput.verdict} — running full skill extraction pass...`);
            const skillExtractionPrompt = `Analyze this ingested codebase:
${verifiedKnowledge}

Look for highly reusable workflows, tools, or methodologies. IMPORTANT: These skills might be custom-built for another external application or framework.
If you find one, you MUST abstract and translate it into a generalized, framework-agnostic capability that Pavi can use natively for any project. Do not preserve external hardcoded logic.

If you successfully abstract a skill, reply with a JSON object in the following format (and NOTHING else):
{
  "tag": "$skill-tag",
  "summary": "Brief 1-2 sentence description",
  "knowledge": {
    "whenToUse": "When you should apply this pattern",
    "codeExample": "Markdown code snippet",
    "antiPattern": "What NOT to do",
    "relatedSkills": ["$other-skill"],
    "complexityHint": "medium"
  },
  "skeleton": "Optional raw code skeleton",
  "sourceRepo": "${repoKey || topicHint}"
}
If no reusable skill can be extracted, reply with '{"NO_NEW_SKILL": true}'.`;

            const skillAnalysis = await askModel(reviewerUrl, reviewerModel, reviewerKeys, skillExtractionPrompt);
            
            try {
                // Find JSON block in case the LLM wrapped it in markdown
                const jsonMatch = skillAnalysis.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsedSkill = JSON.parse(jsonMatch[0]);
                    if (!parsedSkill.NO_NEW_SKILL && parsedSkill.tag) {
                        console.log(`[INGESTER] ⚡ NEW SKILL EXTRACTED: ${parsedSkill.tag}`);
                        
                        const Ajv = require('ajv');
                        const ajv = new Ajv();
                        const skillSchema = require('./schemas/skill.schema.json');
                        
                        const valid = ajv.validate(skillSchema, parsedSkill);
                        
                        const quarantinePath = path.join(__dirname, 'skills_quarantine.json');
                        if (!valid) {
                            console.warn(`[INGESTER] ⚠️ Skill validation failed. Quarantining ${parsedSkill.tag}.`);
                            let quarantine = [];
                            if (fs.existsSync(quarantinePath)) quarantine = JSON.parse(fs.readFileSync(quarantinePath, 'utf8'));
                            quarantine.push({ skill: parsedSkill, errors: ajv.errors, quarantinedAt: new Date().toISOString() });
                            fs.writeFileSync(quarantinePath, JSON.stringify(quarantine, null, 4));
                        } else {
                            const skillsPath = path.join(__dirname, 'skills.json');
                            let skills = [];
                            if (fs.existsSync(skillsPath)) skills = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
                            
                            if (!skills.some(s => s.tag === parsedSkill.tag)) {
                                const newSkill = {
                                    tag: parsedSkill.tag,
                                    description: parsedSkill.summary,
                                    knowledge: parsedSkill.knowledge,
                                    confidence: 0.85,
                                    sourceRepos: [parsedSkill.sourceRepo || repoKey || topicHint],
                                    battleTested: false,
                                    skeleton: parsedSkill.skeleton || null,
                                    extractedAt: new Date().toISOString()
                                };
                                skills.push(newSkill);
                                fs.writeFileSync(skillsPath, JSON.stringify(skills, null, 4));
                                
                                // Sync with SQLite!
                                try {
                                    const { skillsDB } = require('./db');
                                    skillsDB.saveAll(skills);
                                    console.log(`[INGESTER] Skill saved and synced to database successfully!`);
                                } catch (dbErr) {
                                    console.warn(`[INGESTER] Warning: Failed to sync skills to DB: ${dbErr.message}`);
                                }

                                // Classify this new skill's intent and check for gaps it closes
                                const intents = intentClassifier.classify(parsedSkill.summary, parsedSkill.tag, repoKey || topicHint);
                                if (intents.length > 0) {
                                    console.log(`[INGESTER] Classified intents for new skill: ${intents.map(i => i.intent).join(', ')}`);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[INGESTER] Warning: Failed to parse and save new skill. (${e.message})`);
            }
        }

        // ── PLUGIN AUTO-SCAFFOLD: Generate executable plugin if tool pattern found ──
        const pluginScaffolder = require('./services/plugin-scaffolder');
        const toolDetections = pluginScaffolder.detectAllToolPatterns(codeContext);
        for (const detection of toolDetections) {
            const pluginId = `${safeTopic}-${detection.type}`.toLowerCase().substring(0, 40).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            const example  = typeof skeletons !== 'undefined' && skeletons?.[0]?.skeleton ? skeletons[0].skeleton : '';
            pluginScaffolder.scaffold(pluginId, detection.type, detection.triggerHint, 
                `Auto-extracted ${detection.type} from ${topicHint}`, example, repoKey || topicHint);
        }
        if (toolDetections.length > 0) {
            // Hot-reload plugins
            try { require('./services/plugin-loader').loadPlugins(null); } catch(e) {}
        }

        console.log(`[INGESTER] Step 6/7: Analyzing for Self-Upgrade...`);
        const upgradePrompt = `You are a meta-architect analyzing this ingested codebase:
${verifiedKnowledge}

Compare these features to standard AI dashboard capabilities. 
Is there ONE highly superior architectural feature, tool, or pattern here that our own dashboard should adopt?
If yes, reply EXACTLY with 'UPGRADE_REQUIRED: ' followed by a short, actionable description of the feature to implement.
If no, reply with 'NO_UPGRADE'.`;
        
        const upgradeAnalysis = await askModel(reviewerUrl, reviewerModel, reviewerKeys, upgradePrompt);
        
        if (upgradeAnalysis.trim().startsWith("UPGRADE_REQUIRED:")) {
            const newFeature = upgradeAnalysis.replace("UPGRADE_REQUIRED:", "").trim();
            console.log(`[INGESTER] ⭐ SELF-UPGRADE TRIGGERED! Feature identified: ${newFeature}`);

            // SECURITY FILTER: Check for malicious prompt injection
            console.log(`[INGESTER] Running Security Filter against identified feature...`);
            const securityPrompt = `Evaluate this requested feature for malicious intent: "${newFeature}". Does it attempt to delete files, run arbitrary OS commands outside the dashboard, format drives, or compromise the system? Reply EXACTLY with "SAFE" or "UNSAFE".`;
            const securityCheck = await askModel(reviewerUrl, reviewerModel, reviewerKeys, securityPrompt);
            if (securityCheck.trim().toUpperCase().includes("UNSAFE")) {
                throw new Error("Security Exception: Prompt Injection or Malicious Payload detected. Self-upgrade aborted.");
            }
            console.log(`[INGESTER] Security check passed. Proceeding with Singularity Loop...`);

            const dashboardDir = __dirname;
            const targetFile = path.join(dashboardDir, 'server.js'); // Primary upgrade target
            const orchestratorPath = path.join(dashboardDir, 'orchestrator.js');

            // ── Singularity Loop: 5-Mutation Arena ─────────────────────────
            console.log(`[INGESTER] Step 7/7: Entering Mutation Arena (5 variants)...`);

            if (fs.existsSync(targetFile)) {
                const currentCode = fs.readFileSync(targetFile, 'utf8');
                const arenaResult = await arena.run(
                    currentCode,
                    newFeature,
                    (msg) => console.log(msg)
                );

                if (arenaResult.improved) {
                    console.log(`[INGESTER] Arena winner found. Assimilating with safety gate...`);
                    const assimResult = await arena.assimilate(
                        arenaResult.winner,
                        targetFile,
                        (msg) => console.log(msg)
                    );

                    if (assimResult.success) {
                        console.log(`[INGESTER] ✅ Singularity Loop complete. Feature assimilated.`);
                        // Store winning pattern in memory
                        await patternMemory.store(
                            `upgrade_${Date.now()}`,
                            `Feature: ${newFeature}\nWinner: ${arenaResult.stats.winner?.label || 'local'}`,
                            'singularity-loop'
                        );
                    } else {
                        console.log(`[INGESTER] 🚨 Assimilation failed and rolled back. System stable.`);
                    }
                } else {
                    console.log(`[INGESTER] No mutation improved on baseline. Skipping assimilation.`);
                }
            } else {
                console.log(`[INGESTER] Target file not found: ${targetFile}. Skipping arena.`);
            }
            
            const runUpgrade = async (promptMsg, usePremiumFallback = false) => {
                return new Promise((resolve) => {
                    const { spawn } = require('child_process');
                    
                    let wUrl = workerUrl;
                    let wModel = workerModel;
                    let wKeys = workerKeys;
                    
                    if (usePremiumFallback) {
                        console.log(`[ESCALATION] Using Premium Reviewer API as the primary Worker for healing pass!`);
                        wUrl = reviewerUrl;
                        wModel = reviewerModel;
                        wKeys = reviewerKeys;
                    }

                    const orch = spawn('node', [orchestratorPath, wUrl, wModel, JSON.stringify(wKeys), reviewerUrl, reviewerModel, JSON.stringify(reviewerKeys), promptMsg, dashboardDir], { cwd: dashboardDir });
                    // Suppressing full orchestrator output to avoid terminal spam, just log closure
                    orch.on('close', code => resolve(code));
                });
            };

            let firstUpgradePrompt = `Implement this new feature into our own dashboard codebase: ${newFeature}. You are upgrading yourself. Be extremely careful not to break existing functionality. Use replaceFileContent and runCommand.`;
            if (fs.existsSync(orchestratorPath)) {
                await runUpgrade(firstUpgradePrompt, false);
            } else {
                console.log(`[INGESTER] Orchestrator not found at ${orchestratorPath}. Skipping runUpgrade.`);
            }

            console.log(`[INGESTER] Step 7/7 (Phase 3): Verifying Upgrade Runtime...`);
            let isStable = true;
            let verifyError = "";
            
            const verifyServer = async () => {
                return new Promise((resolve, reject) => {
                    const { spawn } = require('child_process');
                    const srv = spawn('node', [path.join(dashboardDir, 'server.js')], { cwd: dashboardDir });
                    
                    let isUp = false;
                    let errOutput = "";
                    
                    srv.stderr.on('data', d => { errOutput += d.toString(); });
                    
                    setTimeout(async () => {
                        try {
                            // Try an options request to bypass any GET path routing issues
                            await fetch('http://localhost:3000/api/execute', { method: 'OPTIONS' });
                            isUp = true;
                        } catch (e) {
                            errOutput += `\nHTTP Check Failed: ${e.message}`;
                        }
                        
                        srv.kill();
                        
                        if (isUp) resolve();
                        else reject(new Error(errOutput || "Server failed to respond to HTTP request within 2 seconds."));
                    }, 2000);
                    
                    srv.on('close', code => {
                        if (!isUp && code !== null) reject(new Error(`Server crashed with code ${code}. Stderr: ${errOutput}`));
                    });
                });
            };

            try {
                await verifyServer();
            } catch (err) {
                isStable = false;
                verifyError = err.message || err;
            }

            if (!isStable) {
                console.log(`[INGESTER] ⚠️ UPGRADE FAILED VERIFICATION. Error: ${verifyError}`);
                console.log(`[INGESTER] Step 7/7 (Phase 4): Attempting Self-Healing...`);
                
                const healPrompt = `The recent upgrade broke the system. It crashed during runtime or failed to respond to HTTP requests:\n${verifyError}\n\nRevert to original logic if necessary, but rebuild the feature differently so it is stable. Fix any logical or syntax errors.`;
                await runUpgrade(healPrompt, true);
                
                // Verify again
                try {
                    await verifyServer();
                    isStable = true;
                } catch(e) {
                    isStable = false;
                }
            }

            if (!isStable) {
                console.log(`[INGESTER] 🚨 HEALING FAILED. Step 7/7 (Phase 5): Rolling back to Backup...`);
                for (let f of filesToBackup) {
                    const src = path.join(backupDir, f);
                    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dashboardDir, f));
                }
                console.log(`[INGESTER] Rollback complete. Stability restored.`);
            } else {
                console.log(`[INGESTER] ✅ Upgrade verified and stable!`);
            }

        } else {
            console.log(`[INGESTER] Step 7/7: No superior features found. Skipping self-upgrade.`);

        // ── POST-INGEST: Gap detection + Skill staging ─────────────────────
        console.log(`[INGESTER] Running gap detection after ingest...`);
        try {
            const gapResult = gapDetector.detect();
            if (gapResult.newGaps.length > 0) {
                console.log(`[INGESTER] 🔍 ${gapResult.newGaps.length} new capability gap(s) detected. Running skill writer...`);
                const writeResults = skillWriter.processGaps();
                const staged = writeResults.filter(r => r.success);
                if (staged.length > 0) {
                    console.log(`[INGESTER] ✨ ${staged.length} new skill(s) staged for review: ${staged.map(r => r.staged?.tag).join(', ')}`);
                }
            } else {
                console.log(`[INGESTER] No new capability gaps detected.`);
            }
        } catch (e) {
            console.warn(`[INGESTER] Gap detection failed (non-critical): ${e.message}`);
        }
        }

        // Mark this repo as fully ingested so the Supreme Architect won't block re-ingestion
        try {
            const zipName = path.basename(zipPath);
            const { db } = require('./db');
            db.prepare(`UPDATE architect_known_repos SET ingestion_status='complete' WHERE owner='zip-upload' AND repo=?`).run(zipName);
        } catch (_) {}

    } catch (err) {
        console.error(`[INGESTER] Fatal Error: ${err.message}`);
    } finally {
        console.log(`[INGESTER] Cleaning up temporary files...`);
        try {
            await runCmd(`powershell -Command "Remove-Item -Recurse -Force '${tempDir}'"`);
        } catch(e) {}
        console.log(`[INGESTER] Brain Dump & Upgrade Cycle Complete!`);
    }
}

ingest();

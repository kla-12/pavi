const { exec } = require('child_process');

async function harvest() {
    const args = process.argv.slice(2);
    if (args.length < 4) {
        console.error("Usage: node harvester.js <apiUrl> <apiKey> <topic> <loops>");
        process.exit(1);
    }

    const apiUrl = args[0];
    const apiKey = args[1];
    const topic = args[2];
    const loops = parseInt(args[3], 10) || 1;
    const apiModel = args[4] || "gpt-3.5-turbo";

    console.log(`[HARVESTER] Starting harvest for topic: "${topic}" | Target Loops: ${loops}`);

    console.log(`[HARVESTER] Generating dynamic questions based on topic...`);
    let dynamicQuestions = [];
    try {
        const payload = {
            model: apiModel,
            messages: [{ role: "user", content: `You are an expert technical researcher. Based on the topic: "${topic}", generate exactly ${loops} highly specific, probing questions. These questions should uncover deep architectural patterns, security flaws, best practices, and common bugs. Output ONLY a JSON array of strings, with no other text or markdown.` }],
            max_tokens: 500
        };
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            const data = await response.json();
            let content = data.choices ? data.choices[0].message.content : data.response || "[]";
            const match = content.match(/```(?:json)?([\s\S]*?)```/);
            if (match) content = match[1];
            dynamicQuestions = JSON.parse(content.trim());
        }
    } catch (e) {
        console.error(`[HARVESTER] Failed to generate dynamic questions. Falling back to default.`);
    }

    if (!Array.isArray(dynamicQuestions) || dynamicQuestions.length < loops) {
        for(let j=dynamicQuestions.length; j<loops; j++) dynamicQuestions.push(`Provide a highly advanced, obscure, or unique technical pattern regarding: ${topic}.`);
    }

    for (let i = 1; i <= loops; i++) {
        console.log(`[HARVESTER] --- Iteration ${i} of ${loops} ---`);
        let question = dynamicQuestions[i-1];
        console.log(`[HARVESTER] Question: ${question}`);
        
        console.log(`[HARVESTER] Querying API: ${apiUrl}`);
        
        try {
            // Very generic JSON structure for typical Chat completions APIs (like OpenAI)
            const payload = {
                model: apiModel, // Dynamic model selection
                messages: [{ role: "user", content: question }],
                max_tokens: 500
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[HARVESTER] API Error: ${response.status} - ${errText}`);
                break; // Stop on API error
            }

            const data = await response.json();
            
            // Try to extract content safely, fallback to whole JSON if structure is weird
            let harvestedKnowledge = "";
            if (data.choices && data.choices[0] && data.choices[0].message) {
                harvestedKnowledge = data.choices[0].message.content;
            } else if (data.response) {
                harvestedKnowledge = data.response; // Ollama style
            } else {
                harvestedKnowledge = JSON.stringify(data); // Fallback
            }
            
            console.log(`[HARVESTER] Successfully extracted ${harvestedKnowledge.length} characters of knowledge.`);
            console.log(`[HARVESTER] Exporting to NotebookLM markdown file...`);

            const fs = require('fs');
            const path = require('path');
            const exportDir = path.join(__dirname, '..', 'notebook_llm_exports');
            if (!fs.existsSync(exportDir)) {
                fs.mkdirSync(exportDir, { recursive: true });
            }

            const safeFileName = `harvest_${topic.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 30)}.md`;
            const exportPath = path.join(exportDir, safeFileName);
            
            const markdownContent = `\n## Iteration ${i} - ${new Date().toISOString()}\n\n### Query\n${question}\n\n### Harvested Knowledge\n${harvestedKnowledge}\n\n---\n`;

            try {
                fs.appendFileSync(exportPath, markdownContent);
                console.log(`[HARVESTER] Saved knowledge to: ${exportPath}`);

                // ── Index into AgentDB with skeleton compression (250x storage reduction) ──
                const memory = require('./memory');
                const tag = `$harvested-${topic.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${i}`;

                // L3: Compressed skeleton storage (primary — minimal footprint)
                const compressResult = await memory.storeCompressed(tag, harvestedKnowledge, `topic:${topic}|q:${question.slice(0,60)}`);
                console.log(`[HARVESTER] Skeleton stored. Compression ratio: ${compressResult?.compressionRatio?.toFixed(1) || '?'}x`);

                // L2: Also store minimal skill tag for backwards-compat semantic search
                await memory.storeSkill(tag, `Harvested: ${question.slice(0, 100)}`, '');
                console.log(`[HARVESTER] Knowledge indexed (compressed) into AgentDB.`);
            } catch (err) {
                console.error(`[HARVESTER] Export/Index Error:`, err.message);
            }

            // Small delay between loops to prevent rate limiting
            if (i < loops) {
                console.log(`[HARVESTER] Cooling down for 2 seconds before next request...`);
                await new Promise(r => setTimeout(r, 2000));
            }

        } catch (err) {
            console.error(`[HARVESTER] Fatal Error during iteration: ${err.message}`);
            break;
        }
    }
    
    console.log(`[HARVESTER] Harvest complete.`);
}

async function capture(data) {
    const { workerOutput, critique, originalPrompt, corrected } = data;
    console.log(`[HARVESTER] Capturing rejection for future training...`);
    const fs = require('fs');
    const path = require('path');
    const captureDir = path.join(__dirname, '..', 'notebook_llm_exports', 'rejections');
    if (!fs.existsSync(captureDir)) {
        fs.mkdirSync(captureDir, { recursive: true });
    }
    const safeFileName = data.fileName || `reject_${Date.now()}.json`;
    const exportPath = path.join(captureDir, safeFileName);
    
    // Merge if exists
    let record = { ...data, fileName: safeFileName };
    if (fs.existsSync(exportPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
            record = { ...existing, ...data, fileName: safeFileName };
        } catch (e) {
            // ignore
        }
    }
    
    fs.writeFileSync(exportPath, JSON.stringify(record, null, 2));

    try {
        const memory = require('./memory');
        const tag = `$rejected-pattern-${Date.now()}`;
        const content = `PROMPT:\n${originalPrompt}\n\nOUTPUT:\n${workerOutput}\n\nCRITIQUE:\n${critique}\n\nCORRECTED:\n${corrected || ''}`;
        await memory.storeCompressed(tag, content, `reject|${(originalPrompt || '').slice(0,30)}`);
        console.log(`[HARVESTER] Rejection indexed for training.`);
    } catch(e) {
        // memory module might not be fully initialized
    }
    return { filePath: exportPath };
}

function exportDPODataset(outputPath) {
    const fs = require('fs');
    const path = require('path');
    const rejectionsDir = path.join(__dirname, '..', 'notebook_llm_exports', 'rejections');
    
    if (!fs.existsSync(rejectionsDir)) {
        return { success: false, error: "No rejections directory found" };
    }
    
    const files = fs.readdirSync(rejectionsDir).filter(f => f.endsWith('.json'));
    let count = 0;
    
    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    
    const lines = [];
    
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(rejectionsDir, file), 'utf8');
            const data = JSON.parse(content);
            
            // Only export complete pairs where we have both a prompt, the rejected output, and a corrected/chosen version
            if (data.originalPrompt && data.workerOutput && data.corrected) {
                const dpoRecord = {
                    prompt: data.originalPrompt,
                    rejected: data.workerOutput,
                    chosen: data.corrected,
                    critique: data.critique || ""
                };
                lines.push(JSON.stringify(dpoRecord));
                count++;
            }
        } catch (e) {
            console.error(`[HARVESTER] Failed to parse rejection file ${file}:`, e);
        }
    }
    
    fs.writeFileSync(outputPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
    console.log(`[HARVESTER] Exported ${count} DPO/RLHF training pairs to: ${outputPath}`);
    return { success: true, count, outputPath };
}

if (require.main === module) {
    harvest();
}

module.exports = { harvest, capture, exportDPODataset };

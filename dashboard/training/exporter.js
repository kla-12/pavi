'use strict';
/**
 * exporter.js — Training Dataset Export Pipelines
 *
 * Exports training_feedback_dataset rows as ChatML, Alpaca, and DPO JSONL
 * datasets for automated fine-tuning of local models.
 */

const fs   = require('fs');
const path = require('path');

const EXPORT_DIR = path.join(__dirname, 'exports');

function ensureExportDir() {
    if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

function getRows() {
    try {
        const { trainingFeedbackDatasetDB } = require('../db');
        return trainingFeedbackDatasetDB.getAll();
    } catch (e) {
        console.error('[EXPORTER] Failed to read training dataset:', e.message);
        return [];
    }
}

/**
 * Export all training data as ChatML JSONL.
 * Format: {"messages": [{"role":"user","content":"..."}, {"role":"assistant","content":"..."}]}
 * @returns {{ path: string, count: number }}
 */
function exportChatML() {
    ensureExportDir();
    const rows = getRows();
    const outPath = path.join(EXPORT_DIR, `chatml_${Date.now()}.jsonl`);
    const lines = [];

    for (const row of rows) {
        if (!row.prompt || !row.swarm_output) continue;
        const entry = {
            messages: [
                { role: 'system', content: 'You are Pavi, an expert AI coding assistant that produces high-quality implementations.' },
                { role: 'user', content: row.prompt },
                { role: 'assistant', content: row.swarm_output }
            ]
        };
        lines.push(JSON.stringify(entry));
    }

    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`[EXPORTER] ChatML exported: ${lines.length} samples → ${path.basename(outPath)}`);
    return { path: outPath, count: lines.length };
}

/**
 * Export all training data as Alpaca JSONL.
 * Format: {"instruction":"...","input":"","output":"..."}
 * @returns {{ path: string, count: number }}
 */
function exportAlpaca() {
    ensureExportDir();
    const rows = getRows();
    const outPath = path.join(EXPORT_DIR, `alpaca_${Date.now()}.jsonl`);
    const lines = [];

    for (const row of rows) {
        if (!row.prompt || !row.swarm_output) continue;
        const entry = {
            instruction: row.prompt,
            input: '',
            output: row.swarm_output
        };
        lines.push(JSON.stringify(entry));
    }

    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`[EXPORTER] Alpaca exported: ${lines.length} samples → ${path.basename(outPath)}`);
    return { path: outPath, count: lines.length };
}

/**
 * Export as DPO JSONL (Direct Preference Optimization).
 * Pairs high-score outputs (chosen) with low-score outputs (rejected) on similar prompts.
 * Format: {"prompt":"...","chosen":"...","rejected":"..."}
 * @param {number} scoreThreshold - Score above this = chosen, below = rejected (default: 70)
 * @returns {{ path: string, count: number }}
 */
function exportDPO(scoreThreshold = 70) {
    ensureExportDir();
    const rows = getRows();
    const outPath = path.join(EXPORT_DIR, `dpo_${Date.now()}.jsonl`);

    const chosen   = rows.filter(r => r.score !== null && r.score >= scoreThreshold && r.prompt && r.swarm_output);
    const rejected = rows.filter(r => r.score !== null && r.score < scoreThreshold && r.prompt && r.swarm_output);

    const lines = [];

    // Strategy 1: Pair by exact prompt match
    const rejectedByPrompt = {};
    for (const r of rejected) {
        const key = r.prompt.trim().substring(0, 200);
        if (!rejectedByPrompt[key]) rejectedByPrompt[key] = [];
        rejectedByPrompt[key].push(r);
    }

    const usedRejected = new Set();
    for (const c of chosen) {
        const key = c.prompt.trim().substring(0, 200);
        if (rejectedByPrompt[key] && rejectedByPrompt[key].length > 0) {
            const r = rejectedByPrompt[key].shift();
            usedRejected.add(r.id);
            lines.push(JSON.stringify({
                prompt: c.prompt,
                chosen: c.swarm_output,
                rejected: r.swarm_output
            }));
        }
    }

    // Strategy 2: Cross-pair remaining (best chosen with worst rejected)
    const remainingRejected = rejected.filter(r => !usedRejected.has(r.id));
    const maxCross = Math.min(chosen.length, remainingRejected.length, 50);
    for (let i = 0; i < maxCross; i++) {
        lines.push(JSON.stringify({
            prompt: chosen[i].prompt,
            chosen: chosen[i].swarm_output,
            rejected: remainingRejected[i].swarm_output
        }));
    }

    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(`[EXPORTER] DPO exported: ${lines.length} preference pairs → ${path.basename(outPath)}`);
    return { path: outPath, count: lines.length };
}

module.exports = { exportChatML, exportAlpaca, exportDPO, EXPORT_DIR };

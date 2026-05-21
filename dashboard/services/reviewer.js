'use strict';
/**
 * reviewer.js — Swarm Output Quality Evaluator
 *
 * Uses local Ollama to score a swarm's output on a 0–100 scale.
 * Scores below RETRY_THRESHOLD trigger automatic re-execution.
 */

const RETRY_THRESHOLD = 45;   // Score below this triggers a retry
const MAX_RETRIES     = 2;    // Maximum automatic retries per run

/**
 * Ask the local Ollama model to evaluate swarm output quality.
 * @param {string} originalPrompt - What the user originally asked for
 * @param {string} swarmOutput    - The raw output produced by the swarm
 * @returns {Promise<{ score: number, feedback: string, shouldRetry: boolean }>}
 */
async function evaluateOutput(originalPrompt, swarmOutput) {
    try {
        const localBot = require('../local-bot');

        const systemPrompt = `You are a strict but fair software engineering quality reviewer.
Your job is to evaluate whether an AI swarm successfully completed a given objective.
Always respond with ONLY valid JSON in this exact format:
{ "score": <0-100>, "feedback": "<one sentence>", "issues": ["<issue1>", "<issue2>"] }`;

        const evalPrompt = `ORIGINAL OBJECTIVE:
${originalPrompt.slice(0, 400)}

SWARM OUTPUT:
${swarmOutput.slice(0, 1500)}

Evaluate the output. Score 0=complete failure, 50=partial, 80=good, 95+=excellent.
Deduct points for: errors in output, objective not addressed, missing implementation steps.
Respond with JSON only.`;

        const raw = await localBot.call(evalPrompt, 'reviewer', systemPrompt, 400);

        // Parse JSON from response
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in reviewer response');

        const parsed = JSON.parse(jsonMatch[0]);
        const score = Math.max(0, Math.min(100, parseInt(parsed.score) || 0));
        const feedback = parsed.feedback || 'No feedback provided.';
        const issues = parsed.issues || [];
        const shouldRetry = score < RETRY_THRESHOLD;

        // Route to training harvester
        try {
            const { trainingFeedbackDatasetDB } = require('../db');
            const crypto = require('crypto');
            trainingFeedbackDatasetDB.insert(
                crypto.randomUUID(),
                originalPrompt,
                swarmOutput,
                score,
                feedback,
                issues
            );
            console.log(`[REVIEWER] Saved eval to training_feedback_dataset. Score: ${score}`);
        } catch (dbErr) {
            console.error('[REVIEWER] Failed to route to training harvester:', dbErr.message);
        }

        return {
            score,
            feedback,
            issues,
            shouldRetry
        };
    } catch (e) {
        console.warn('[REVIEWER] Evaluation failed (non-fatal):', e.message);
        // Return neutral score on failure — do NOT block swarm completion
        return { score: null, feedback: null, issues: [], shouldRetry: false };
    }
}

/**
 * Classify a prompt into a category for topology learning.
 * @param {string} prompt
 * @returns {string}
 */
function classifyPrompt(prompt) {
    const lower = prompt.toLowerCase();
    if (/test|spec|coverage|jest|vitest/.test(lower))          return 'testing';
    if (/security|audit|vulnerability|pentest/.test(lower))    return 'security';
    if (/refactor|clean|optimize|performance/.test(lower))     return 'refactoring';
    if (/build|deploy|ci|cd|pipeline|docker/.test(lower))      return 'devops';
    if (/api|route|endpoint|rest|graphql/.test(lower))         return 'api';
    if (/ui|frontend|component|react|css|html/.test(lower))    return 'frontend';
    if (/database|sql|schema|migration|model/.test(lower))     return 'database';
    if (/document|readme|comment|explain/.test(lower))         return 'documentation';
    return 'general';
}

/**
 * Persist a high-quality run's topology → category mapping to pattern memory.
 * Called only for runs scoring 80+.
 */
async function persistTopologyLearning(category, topology, score, promptSample) {
    if (score < 80) return;
    try {
        const patternMemory = require('../pattern-memory');
        const key = `topology-learning-${category}-${topology}-${Date.now()}`;
        const content = `Topology: ${topology} | Category: ${category} | Score: ${score}/100 | Prompt sample: ${promptSample.slice(0, 100)}`;
        await patternMemory.store(key, content, `topology:${topology} category:${category}`);
        console.log(`[REVIEWER] Persisted topology learning: ${topology} → ${category} (${score})`);
    } catch (_e) {}
}

module.exports = { evaluateOutput, classifyPrompt, persistTopologyLearning, RETRY_THRESHOLD, MAX_RETRIES };

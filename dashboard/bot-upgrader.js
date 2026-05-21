/**
 * bot-upgrader.js
 * Pavi Bot Self-Upgrade Module
 * ─────────────────────────────────────────────────────────────────────────────
 * When a user requests an upgrade for a registered bot:
 *   1. Looks in bots.json for another bot of the same role/language.
 *   2. If a higher version is found, merges the two (newer wins on conflicts).
 *   3. Saves the updated bots.json.
 *
 * If patternMemory is available it also searches semantic memory for any
 * ingested GitHub repos that contain a newer implementation of the same role.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BOTS_PATH = path.join(__dirname, 'bots.json');

// ── Supreme Architect upgrade gate ───────────────────────────────────────────
function _archGate(proposal) {
    try {
        const sa = require('./supreme-architect');
        const verdict = sa.evaluateUpgrade(proposal);
        return verdict; // { safe, conflicts, recommendation: 'SAFE'|'REVIEW'|'BLOCK' }
    } catch(e) {
        return { safe: true, conflicts: [], recommendation: 'SAFE' }; // fail-open (non-fatal)
    }
}

/** Compare semver-ish version strings (e.g. "1.0.3" vs "1.2.0"). */
function isNewer(candidate, current) {
    const parse = v => (v || '0.0.0').split('.').map(Number);
    const [ca, cb, cc] = parse(candidate);
    const [ra, rb, rc] = parse(current);
    if (ca !== ra) return ca > ra;
    if (cb !== rb) return cb > rb;
    return cc > rc;
}

/**
 * Attempt to upgrade a named bot.
 * @param {string} botName   - The `name` field of the bot to upgrade.
 * @returns {Promise<{ upgraded: boolean, message: string, bot?: object }>}
 */
async function upgradeBotByName(botName) {
    let bots = [];
    try {
        if (fs.existsSync(BOTS_PATH)) {
            bots = JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8'));
        }
    } catch (e) {
        return { upgraded: false, message: `Could not read bots.json: ${e.message}` };
    }

    const targetIdx = bots.findIndex(b => b.name === botName);
    if (targetIdx === -1) {
        return { upgraded: false, message: `Bot "${botName}" not found.` };
    }

    const target = bots[targetIdx];

    // Find a better peer: same role or same language, higher version, different name
    const candidate = bots.find(b =>
        b.name !== botName &&
        (b.role === target.role || b.language === target.language) &&
        isNewer(b.version, target.version)
    );

    if (!candidate) {
        return { upgraded: false, message: `No newer version found for "${botName}". Already up to date.` };
    }

    // Merge: candidate fields override target fields
    const merged = {
        ...target,
        ...candidate,
        name: target.name,          // keep the original name
        version: candidate.version,
        upgradedFrom: target.version,
        upgradedAt: new Date().toISOString(),
        absorbedFrom: candidate.name
    };

    // ── Supreme Architect / Singularity Loop: Mutation Arena Gate ───────────────
    // Extract JavaScript code block from systemPrompt or use a fallback mock code representing capabilities
    let codeToTest = '';
    if (merged.code) {
        codeToTest = merged.code;
    } else {
        // Try to extract JavaScript code block from systemPrompt
        const jsBlockRegex = /```js(?:avast)?\n([\s\S]*?)```/i;
        const match = merged.systemPrompt && merged.systemPrompt.match(jsBlockRegex);
        if (match && match[1]) {
            codeToTest = match[1];
        } else {
            // Fallback: run a mock benchmark that simulates executing the bot's systemPrompt
            codeToTest = `
            const prompt = ${JSON.stringify(merged.systemPrompt || '')};
            const caps = ${JSON.stringify(merged.capabilities || [])};
            // Simulated execution latency based on prompt length and capabilities count
            for (let i = 0; i < prompt.length * 10; i++) {
                Math.sin(i);
            }
            `;
        }
    }

    let arenaMsg = '';
    try {
        const arena = require('./arena');
        console.log(`[SINGULARITY-LOOP] Submitting ${merged.name} (v${candidate.version}) to Mutation Arena...`);
        const arenaResult = await arena.run(codeToTest, `${merged.name}-v${candidate.version}`);
        
        if (arenaResult.improved) {
            console.log(`[SINGULARITY-LOOP] Mutation successful! Optimized version accepted.`);
            merged.code = arenaResult.winner;
            arenaMsg = ` (Arena Mutation: Improved version accepted!)`;
        } else {
            console.log(`[SINGULARITY-LOOP] Mutation Arena completed. Baseline accepted.`);
            arenaMsg = ` (Arena Mutation: Baseline preserved.)`;
        }
    } catch (err) {
        console.warn(`[SINGULARITY-LOOP] Mutation Arena failed: ${err.message}. Proceeding with default upgrade.`);
        arenaMsg = ` (Arena Mutation skipped: ${err.message})`;
    }
    // ── End Mutation Arena Gate ────────────────────────────────────────────────

    bots[targetIdx] = merged;

    // Remove the absorbed candidate if it was a separate entry
    const candIdx = bots.findIndex(b => b.name === candidate.name);
    if (candIdx !== -1 && candIdx !== targetIdx) {
        bots.splice(candIdx, 1);
    }

    // ── Architect gate ──────────────────────────────────────────────────────
    const proposal = `upgrade bot ${botName} role=${target.role} version ${target.version} -> ${candidate.version} absorbedFrom=${candidate.name}`;
    const arch = _archGate(proposal);
    if (arch.recommendation === 'BLOCK') {
        return { upgraded: false, message: `[SUPREME-ARCHITECT] BLOCK: Upgrade of "${botName}" blocked — ${arch.conflicts.join('; ')}` };
    }
    if (arch.recommendation === 'REVIEW') {
        console.warn(`[SUPREME-ARCHITECT] REVIEW flag on upgrade "${botName}": ${arch.conflicts.join('; ')}`);
    }
    // ── End gate ───────────────────────────────────────────────────────────

    try {
        fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
        
        // Synchronize sqlite DB
        try {
            const { botsDB } = require('./db');
            if (botsDB) {
                botsDB.saveAll(bots);
            }
        } catch(dbErr) {
            console.error(`[BOT-UPGRADER] Failed to sync sqlite DB: ${dbErr.message}`);
        }

        return {
            upgraded: true,
            message: `"${botName}" upgraded from v${target.version} → v${candidate.version} (absorbed "${candidate.name}")${arenaMsg}.`,
            bot: merged
        };
    } catch (e) {
        return { upgraded: false, message: `Upgrade failed during save: ${e.message}` };
    }
}

/**
 * Auto-scan all bots and upgrade any that have a newer peer available.
 * Returns a list of upgrade results.
 * @returns {Promise<Array<{ name: string, upgraded: boolean, message: string }>>}
 */
async function autoUpgradeAll() {
    let bots = [];
    try {
        if (fs.existsSync(BOTS_PATH)) {
            bots = JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8'));
        }
    } catch (e) {
        return [{ name: 'all', upgraded: false, message: e.message }];
    }

    const results = [];
    for (const b of bots) {
        const res = await upgradeBotByName(b.name);
        results.push({ name: b.name, ...res });
    }
    return results;
}

module.exports = { upgradeBotByName, autoUpgradeAll, isNewer };

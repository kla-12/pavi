const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Pavi Evolution: Tiered Memory ────────────────────────────────────────────
const patternMemory = require('./pattern-memory');

/**
 * Pavi Memory System - Wrapper for AgentDB + Tiered Cognitive Array
 *
 * L1: In-memory session cache (patternMemory.cache)
 * L2: AgentDB HNSW vector index (semantic search, guarded by Bloom filter)
 * L3: Skeleton-compressed archive (250x smaller footprint)
 */
class PaviMemory {
    constructor(dbPath = '.agents.db') {
        this.dbPath = path.resolve(__dirname, dbPath);
    }

    getAgentDBCmd() {
        const localCli = path.join(__dirname, 'node_modules', 'agentdb', 'dist', 'src', 'cli', 'agentdb-cli.js');
        if (fs.existsSync(localCli)) return `node "${localCli}"`;
        const rootCli = path.join(__dirname, '..', 'node_modules', 'agentdb', 'dist', 'src', 'cli', 'agentdb-cli.js');
        if (fs.existsSync(rootCli)) return `node "${rootCli}"`;

        const ext = process.platform === 'win32' ? '.cmd' : '';
        const localBin = path.join(__dirname, 'node_modules', '.bin', `agentdb${ext}`);
        if (fs.existsSync(localBin)) return `"${localBin}"`;
        const rootBin = path.join(__dirname, '..', 'node_modules', '.bin', `agentdb${ext}`);
        if (fs.existsSync(rootBin)) return `"${rootBin}"`;
        return 'npx -y agentdb';
    }

    /**
     * [NEW L3] Store content as compressed skeleton — ~250x reduction.
     * Use this instead of storeSkill for large code/text blobs.
     */
    async storeCompressed(key, content, metadata = '') {
        return patternMemory.store(key, content, metadata);
    }

    /**
     * [NEW L2] Semantic HNSW nearest-neighbor search with Bloom pre-filter.
     * Query → Bloom O(1) → HNSW → results
     */
    async searchSemantic(query, k = 5) {
        return patternMemory.recall(query, k);
    }

    /**
     * [NEW L1] Probabilistic O(1) membership check.
     * Returns false = definitely not stored. true = probably stored.
     */
    bloomCheck(key) {
        return patternMemory.bloomCheck(key);
    }

    /**
     * [NEW] Memory stats: Bloom count, cache size, compression ratios.
     */
    getMemoryStats() {
        return patternMemory.getStats();
    }

    /**
     * Store a skill into AgentDB
     */
    async storeSkill(tag, description, content = "") {
        try {
            const bin = this.getAgentDBCmd();
            const cmd = `${bin} skill create "${tag.replace(/"/g, '\\"')}" "${description.replace(/"/g, '\\"')}" "${content.replace(/"/g, '\\"')}"`;
            execSync(cmd, { cwd: __dirname, stdio: 'pipe' });
            return true;
        } catch (e) {
            const errorOutput = e.stderr ? e.stderr.toString() : e.message;
            if (errorOutput.includes('UNIQUE constraint failed') || errorOutput.includes('skills.name')) {
                // Ignore gracefully - skill is already known
                return true;
            }
            console.error(`[MEMORY] Error storing skill: ${e.message}`);
            return false;
        }
    }

    /**
     * Search for skills semantically
     */
    async searchSkills(query, k = 5) {
        try {
            const bin = this.getAgentDBCmd();
            const cmd = `${bin} skill search "${query.replace(/"/g, '\\"')}" ${k} -f json`;
            const output = execSync(cmd, { cwd: __dirname }).toString();
            return JSON.parse(output);
        } catch (e) {
            console.error(`[MEMORY] Error searching skills: ${e.message}`);
            return [];
        }
    }

    /**
     * Store a task memory (Reflexion episode)
     */
    async storeTask(taskId, objective, confidence, success, summary) {
        try {
            const bin = this.getAgentDBCmd();
            const cmd = `${bin} reflexion store "${taskId}" "${objective.replace(/"/g, '\\"')}" ${confidence} ${success} "${summary.replace(/"/g, '\\"')}"`;
            execSync(cmd, { cwd: __dirname });
            return true;
        } catch (e) {
            console.error(`[MEMORY] Error storing task memory: ${e.message}`);
            return false;
        }
    }

    /**
     * Retrieve relevant past memories
     */
    async retrieveMemories(query, k = 5, threshold = 0.5) {
        try {
            const bin = this.getAgentDBCmd();
            const cmd = `${bin} reflexion retrieve "${query.replace(/"/g, '\\"')}" ${k} ${threshold} -f json`;
            const output = execSync(cmd, { cwd: __dirname }).toString();
            return JSON.parse(output);
        } catch (e) {
            console.error(`[MEMORY] Error retrieving memories: ${e.message}`);
            return [];
        }
    }
}

module.exports = new PaviMemory();

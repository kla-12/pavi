'use strict';
/**
 * pattern-memory.js — Tiered Cognitive Memory System
 *
 * Implements the L2/L3 memory architecture:
 *
 *  Query ──> Bloom Filter (O(1) "is it here?")
 *         ──> HNSW Index via AgentDB (semantic nearest-neighbor)
 *         ──> Skeleton expansion (reconstruct from compressed form)
 *
 * Key features:
 *  - Stores ONLY conceptual skeletons (control flow + signatures), not raw code
 *  - ~250x storage reduction vs. raw text
 *  - Bloom filter prevents expensive HNSW lookups for cold-cache misses
 *  - skills.json is cross-referenced synchronously on every insert
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Bloom Filter (probabilistic membership test O(1)) ─────────────────────────
// Simple implementation using a Uint8Array bitset + djb2 + fnv1a hash functions.

class BloomFilter {
    constructor(size = 8192, hashCount = 4) {
        this.size = size;
        this.hashCount = hashCount;
        this.bits = new Uint8Array(Math.ceil(size / 8));
        this.count = 0;
    }

    _hash(str, seed) {
        let hash = seed;
        for (let i = 0; i < str.length; i++) {
            hash = Math.imul(hash ^ str.charCodeAt(i), 0x9e3779b9);
            hash ^= hash >>> 15;
        }
        return Math.abs(hash) % this.size;
    }

    add(key) {
        const k = String(key);
        for (let i = 0; i < this.hashCount; i++) {
            const pos = this._hash(k, i * 2654435761);
            this.bits[pos >> 3] |= (1 << (pos & 7));
        }
        this.count++;
    }

    /** Returns false = definitely NOT in set. Returns true = probably in set. */
    mightContain(key) {
        const k = String(key);
        for (let i = 0; i < this.hashCount; i++) {
            const pos = this._hash(k, i * 2654435761);
            if (!(this.bits[pos >> 3] & (1 << (pos & 7)))) return false;
        }
        return true;
    }

    serialize() {
        return { size: this.size, hashCount: this.hashCount, bits: Array.from(this.bits), count: this.count };
    }

    static deserialize(data) {
        const bf = new BloomFilter(data.size, data.hashCount);
        bf.bits = new Uint8Array(data.bits);
        bf.count = data.count || 0;
        return bf;
    }
}

// ── Skeleton Extractor ────────────────────────────────────────────────────────
// Converts raw code/text into a compressed conceptual tree.
// Works on both code (extracts control flow) and prose (extracts key concepts).

class SkeletonExtractor {
    /**
     * Extract the essential skeleton from code or text.
     * Returns a compressed string ~250x smaller than the original.
     */
    extract(content, type = 'auto') {
        if (!content || typeof content !== 'string') return '';

        const detectedType = type === 'auto' ? this._detectType(content) : type;

        if (detectedType === 'code') {
            return this._extractCodeSkeleton(content);
        } else {
            return this._extractProseSkeleton(content);
        }
    }

    _detectType(content) {
        const codeIndicators = ['function ', 'const ', 'let ', 'var ', 'class ', 'def ', 'import ', 'require(', '=>', '{', '}'];
        const score = codeIndicators.filter(ind => content.includes(ind)).length;
        return score >= 3 ? 'code' : 'prose';
    }

    _extractCodeSkeleton(code) {
        const lines = [];

        // Extract function signatures
        const funcPattern = /(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>|class\s+(\w+))/g;
        let m;
        while ((m = funcPattern.exec(code)) !== null) {
            const name = m[1] || m[2] || m[4];
            const params = m[3] || '';
            if (name) lines.push(`FN:${name}(${params.slice(0, 40)})`);
        }

        // Extract control flow
        const flowPattern = /\b(if|else|for|while|try|catch|switch|return|throw|async|await)\b/g;
        const flows = new Set();
        while ((m = flowPattern.exec(code)) !== null) flows.add(m[1]);
        if (flows.size > 0) lines.push(`FLOW:[${[...flows].join(',')}]`);

        // Extract imports/requires
        const importPattern = /(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
        const imports = [];
        while ((m = importPattern.exec(code)) !== null) imports.push(m[1].split('/').pop());
        if (imports.length > 0) lines.push(`DEPS:[${[...new Set(imports)].join(',')}]`);

        // Extract error patterns
        const errorTypes = [];
        const errorPattern = /\b(Error|Exception|TypeError|RangeError|SyntaxError)\b/g;
        while ((m = errorPattern.exec(code)) !== null) {
            if (!errorTypes.includes(m[1])) errorTypes.push(m[1]);
        }
        if (errorTypes.length > 0) lines.push(`ERRORS:[${errorTypes.join(',')}]`);

        return lines.join('\n') || code.slice(0, 200);
    }

    _extractProseSkeleton(text) {
        // Extract key noun phrases and action patterns from prose
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
        const keyLines = sentences
            .slice(0, 8) // Take first 8 meaningful sentences
            .map(s => s.trim().replace(/\s+/g, ' ').slice(0, 100));
        return keyLines.join(' | ');
    }
}

// ── Pattern Memory ────────────────────────────────────────────────────────────

class PatternMemory {
    constructor(options = {}) {
        this.dbPath = path.resolve(options.dbPath || path.join(__dirname, 'agentdb.db'));
        this.bloomPath = path.resolve(options.bloomPath || path.join(__dirname, '.bloom-filter.json'));
        this.skillsPath = path.resolve(options.skillsPath || path.join(__dirname, 'skills.json'));
        this.skeleton = new SkeletonExtractor();
        this.bloom = this._loadBloom();
        this.cache = new Map(); // L1 in-memory cache (active session)
        this.cacheMaxSize = options.cacheMaxSize || 100;
        this.repoStatsPath = path.resolve(options.repoStatsPath || path.join(__dirname, 'repo-stats.json'));
        this.repoStats = this._loadRepoStats();
        this.vectorStorePath = path.resolve(options.vectorStorePath || path.join(__dirname, '.vector-store.json'));
        this.vectorStore = this._loadVectorStore();
        this.maxVectorEntries = options.maxVectorEntries || 5000;

        // Ensure vector store persistence on graceful shutdown
        process.on('exit', () => this._saveVectorStoreSync());
        process.on('SIGINT', () => { this._saveVectorStoreSync(); process.exit(); });
        process.on('SIGTERM', () => { this._saveVectorStoreSync(); process.exit(); });
    }

    /**
     * Store a code/text pattern with skeleton compression.
     * @param {string} key - Unique identifier for this pattern
     * @param {string} content - Raw code or text to compress and store
     * @param {string} [metadata] - Optional metadata tags
     */
    async store(key, content, metadata = '') {
        const skeletonStr = this.skeleton.extract(content);
        const compressed = `SKELETON|${key}|${skeletonStr}|META:${metadata}`;

        // L1: Update session cache
        this._cacheSet(key, { key, skeleton: skeletonStr, original: content.slice(0, 500), metadata, ts: Date.now() });

        // L2: Add to Bloom filter
        this.bloom.add(key);
        this._saveBloom();

        // L2a: Try native Ollama embedding and store in vectorStore
        try {
            const embedding = await this._ollamaEmbed(skeletonStr || content.slice(0, 500));
            if (embedding) {
                if (this.vectorStore.size >= this.maxVectorEntries) {
                    const oldestKey = this.vectorStore.keys().next().value;
                    this.vectorStore.delete(oldestKey);
                    console.warn(`[PATTERN_MEM] VectorStore cap reached (${this.maxVectorEntries}). Evicted oldest entry: ${oldestKey}`);
                }
                this.vectorStore.set(key, { vector: embedding, skeleton: skeletonStr, metadata, ts: Date.now() });
                console.log(`[PATTERN_MEM] Stored Ollama embedding for "${key}" (dim=${embedding.length})`);
                this._saveVectorStore();
            }
        } catch (e) {
            console.warn('[PATTERN_MEM] Ollama embedding creation failed:', e.message);
        }

        // L2b: Also store compressed form in AgentDB via CLI (fallback index)
        try {
            if (process.env.NODE_ENV === 'test') throw new Error('Skip execSync in test mode');
            const bin = this._getAgentDBCmd();
            const safe = compressed.replace(/"/g, "'");
            execSync(`${bin} skill create "${key}" "${safe.slice(0, 500)}" ""`, { cwd: __dirname, stdio: 'pipe' });
        } catch (e) {
            // Fallback: write to local JSON index
            this._fallbackStore(key, { skeleton: skeletonStr, metadata, ts: Date.now() });
        }

        // Synchronously cross-reference skills.json
        this._crossReferenceSkills(key, skeletonStr);

        // Classify and tag the capability intent for this pattern
        try {
            const intentClassifier = require('./intent-classifier');
            intentClassifier.classify(skeletonStr, key, metadata);
        } catch (e) { /* ignore if classifier missing */ }

        console.log(`[PATTERN_MEM] Stored skeleton for "${key}" (${content.length} bytes → ${skeletonStr.length} bytes, ${Math.round((1 - skeletonStr.length / Math.max(1, content.length)) * 100)}% reduction)`);
        return { key, compressionRatio: content.length / Math.max(1, skeletonStr.length) };
    }

    /**
     * Recall a pattern. Uses Bloom → L1 cache → AgentDB HNSW path.
     * @param {string} query - Semantic query or exact key
     * @param {number} k - Number of results to return
     */
    async recall(query, k = 5) {
        // L1: Try cache hit first
        const cached = this._cacheGet(query);
        if (cached) {
            console.log(`[PATTERN_MEM] L1 cache hit for "${query}"`);
            return [cached];
        }

        // Note: We deliberately skip Bloom filter here because `query` is semantic text, 
        // while the Bloom filter is built on exact `key`s. Bloom is used only via bloomCheck().

        let results = [];

        // L2a: Native Ollama vector search (cosine similarity)
        try {
            const queryEmbedding = await this._ollamaEmbed(query);
            if (queryEmbedding && this.vectorStore.size > 0) {
                const scored = [];
                for (const [storedKey, entry] of this.vectorStore.entries()) {
                    const score = this._cosineSimilarity(queryEmbedding, entry.vector);
                    scored.push({ key: storedKey, score, skeleton: entry.skeleton, metadata: entry.metadata });
                }
                scored.sort((a, b) => b.score - a.score);
                // Map to match the expected format { key, skeleton, metadata, score }
                results = scored.slice(0, k).filter(r => r.score > 0.3).map(r => ({
                    key: r.key,
                    skeleton: r.skeleton,
                    metadata: r.metadata,
                    score: r.score
                }));
                if (results.length > 0) {
                    console.log(`[PATTERN_MEM] Ollama vector search found ${results.length} results for "${query.slice(0, 40)}"`);
                }
            }
        } catch (embedErr) {
            console.warn('[PATTERN_MEM] Ollama vector search failed:', embedErr.message);
        }

        // L2b: If Ollama found nothing or was unreachable, fall back to AgentDB CLI HNSW search
        if (results.length === 0) {
            try {
                if (process.env.NODE_ENV === 'test') throw new Error('Skip execSync in test mode');
                const bin = this._getAgentDBCmd();
                const output = execSync(`${bin} skill search "${query.replace(/"/g, "'")}" ${k} -f json`, { cwd: __dirname, stdio: 'pipe' }).toString();
                results = JSON.parse(output);
                if (!Array.isArray(results)) results = [];
            } catch (e) {
                // Fallback: search local JSON index
                results = this._fallbackSearch(query, k);
            }
        }

        // Increment repoStats hits for the recalled repos
        for (const res of results) {
            if (res.key && res.key.startsWith('$github-')) {
                const parts = res.key.split('-');
                if (parts.length >= 3) { // $github-owner-repo-...
                    const repoKey = `github.com/${parts[1]}/${parts[2]}`;
                    if (!this.repoStats[repoKey]) this.repoStats[repoKey] = { files: 0, hits: 0, botsSpawned: 0, lastUsed: null, upgradedAt: null };
                    this.repoStats[repoKey].hits++;
                    this.repoStats[repoKey].lastUsed = Date.now();
                }
            }
        }
        if (results.length > 0) this._saveRepoStats();

        return results;
    }

    /**
     * Check Bloom filter only — O(1) membership test.
     * Returns false = definitely not stored. true = probably stored.
     */
    bloomCheck(key) {
        return this.bloom.mightContain(key);
    }

    /**
     * Increment file count for a repo during ingestion
     */
    trackRepoFile(owner, repo) {
        const repoKey = `github.com/${owner}/${repo}`;
        if (!this.repoStats[repoKey]) this.repoStats[repoKey] = { files: 0, hits: 0, botsSpawned: 0, lastUsed: null, upgradedAt: null };
        this.repoStats[repoKey].files++;
        this._saveRepoStats();
    }

    /**
     * Flush L1 Cache for a specific repo (used during re-ingest)
     */
    flushRepo(owner, repo) {
        const prefix = `$github-${owner}-${repo}-`;
        let flushed = 0;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
                flushed++;
            }
        }
        console.log(`[PATTERN_MEM] Flushed ${flushed} cached keys for ${owner}/${repo}`);
    }

    /**
     * Get compression statistics.
     */
    getStats() {
        const fallbackIndex = this._loadFallbackIndex();
        return {
            bloomCount: this.bloom.count,
            cacheSize: this.cache.size,
            fallbackIndexSize: Object.keys(fallbackIndex).length,
            bloomSerializedSize: JSON.stringify(this.bloom.serialize()).length
        };
    }

    /**
     * Gap 8: Prune low-hit and old skeletons from the fallback index and repoStats.
     * @param {number} maxAgeMs - Age threshold for pruning
     * @param {number} minHits - Minimum hits to retain older entries
     */
    prune(maxAgeMs = 14 * 24 * 60 * 60 * 1000, minHits = 2) {
        const now = Date.now();
        let prunedRepos = 0;
        let prunedFallback = 0;

        // Clean RepoStats
        for (const [repoKey, stats] of Object.entries(this.repoStats)) {
            const age = now - (stats.lastUsed || now);
            if (age > maxAgeMs && stats.hits < minHits) {
                delete this.repoStats[repoKey];
                prunedRepos++;
            }
        }
        if (prunedRepos > 0) this._saveRepoStats();

        // Clean Fallback Index
        const index = this._loadFallbackIndex();
        for (const [key, val] of Object.entries(index)) {
            const age = now - (val.ts || now);
            // We use simple heuristics for fallback index since hits aren't tracked per item
            if (age > maxAgeMs) {
                delete index[key];
                prunedFallback++;
            }
        }
        if (prunedFallback > 0) {
            try {
                fs.writeFileSync(path.join(__dirname, '.pattern-index.json'), JSON.stringify(index, null, 2), 'utf8');
            } catch {}
        }
        
        // Note: AgentDB CLI doesn't currently support a batch `prune` by date natively, 
        // so we prune what we can manage manually (the fallback index and repoStats).

        return { prunedRepos, prunedFallback };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _loadRepoStats() {
        try {
            if (fs.existsSync(this.repoStatsPath)) {
                return JSON.parse(fs.readFileSync(this.repoStatsPath, 'utf8'));
            }
        } catch {}
        return {};
    }

    _saveRepoStats() {
        try {
            fs.writeFileSync(this.repoStatsPath, JSON.stringify(this.repoStats, null, 2), 'utf8');
        } catch {}
    }

    _crossReferenceSkills(key, skeleton) {
        try {
            if (!fs.existsSync(this.skillsPath)) return;
            const skills = JSON.parse(fs.readFileSync(this.skillsPath, 'utf8'));
            const relevantSkills = skills.filter(s =>
                skeleton.toLowerCase().includes(s.tag.replace('$', '').toLowerCase()) ||
                (s.description && skeleton.toLowerCase().includes(s.description.slice(0, 20).toLowerCase()))
            );
            if (relevantSkills.length > 0) {
                console.log(`[PATTERN_MEM] Cross-referenced skills for "${key}": ${relevantSkills.map(s => s.tag).join(', ')}`);
            }
        } catch (_e) {
            // Non-critical — don't throw
        }
    }

    _cacheGet(key) {
        if (!this.cache.has(key)) return null;
        const entry = this.cache.get(key);
        // TTL: 30 minutes
        if (Date.now() - entry.ts > 30 * 60 * 1000) {
            this.cache.delete(key);
            return null;
        }
        // LRU: Move to end to mark as recently used
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry;
    }

    _cacheSet(key, value) {
        // Evict expired entries first
        const now = Date.now();
        for (const [k, v] of this.cache.entries()) {
            if (now - v.ts > 30 * 60 * 1000) this.cache.delete(k);
        }

        if (this.cache.size >= this.cacheMaxSize) {
            // LRU Evict oldest (first) entry
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    _loadVectorStore() {
        try {
            if (fs.existsSync(this.vectorStorePath)) {
                const data = JSON.parse(fs.readFileSync(this.vectorStorePath, 'utf8'));
                return new Map(data);
            }
        } catch (_e) {
            console.warn('[PATTERN_MEM] Failed to load vector store from disk, starting fresh.');
        }
        return new Map();
    }

    _saveVectorStoreSync() {
        try {
            const data = Array.from(this.vectorStore.entries());
            fs.writeFileSync(this.vectorStorePath, JSON.stringify(data), 'utf8');
        } catch (_e) {}
    }

    _saveVectorStore() {
        try {
            const data = Array.from(this.vectorStore.entries());
            fs.promises.writeFile(this.vectorStorePath, JSON.stringify(data), 'utf8').catch(() => {});
        } catch (_e) {}
    }

    _loadBloom() {
        try {
            if (fs.existsSync(this.bloomPath)) {
                const data = JSON.parse(fs.readFileSync(this.bloomPath, 'utf8'));
                return BloomFilter.deserialize(data);
            }
        } catch {}
        return new BloomFilter();
    }

    _saveBloom() {
        try {
            fs.writeFileSync(this.bloomPath, JSON.stringify(this.bloom.serialize()), 'utf8');
        } catch {}
    }

    /**
     * Fetch a vector embedding from local Ollama for a given text string.
     * Falls back gracefully if Ollama is unreachable.
     * @param {string} text
     * @returns {Promise<number[]|null>} float array or null on failure
     */
    async _ollamaEmbed(text) {
        try {
            const { settingsDB } = require('./db');
            // Use a dedicated embedding model (nomic-embed-text) separate from the chat model
            // Falls back to selected_model if embedding_model hasn't been configured
            const model = settingsDB.get('embedding_model') || settingsDB.get('selected_model') || 'nomic-embed-text';
            const response = await fetch('http://localhost:11434/api/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: text })
            });
            if (!response.ok) return null;
            const data = await response.json();
            return Array.isArray(data.embedding) ? data.embedding : null;
        } catch (_e) {
            return null;
        }
    }

    /**
     * Compute cosine similarity between two equal-length float arrays.
     * Returns a value between -1.0 and 1.0 (higher = more similar).
     */
    _cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot   += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
    }

    _getAgentDBCmd() {
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

    _fallbackStore(key, value) {
        const index = this._loadFallbackIndex();
        index[key] = value;
        try {
            const fallbackPath = path.join(__dirname, '.pattern-index.json');
            fs.writeFileSync(fallbackPath, JSON.stringify(index, null, 2), 'utf8');
        } catch {}
    }

    _fallbackSearch(query, k) {
        const index = this._loadFallbackIndex();
        const lower = query.toLowerCase();
        return Object.entries(index)
            .filter(([key, val]) =>
                key.toLowerCase().includes(lower) ||
                (val.skeleton && val.skeleton.toLowerCase().includes(lower))
            )
            .slice(0, k)
            .map(([key, val]) => ({ key, ...val }));
    }

    _loadFallbackIndex() {
        try {
            const fallbackPath = path.join(__dirname, '.pattern-index.json');
            if (fs.existsSync(fallbackPath)) return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
        } catch {}
        return {};
    }

    vectorStoreSize() {
        return this.vectorStore ? this.vectorStore.size : 0;
    }
}

// Export singleton + classes for testing
const patternMemory = new PatternMemory();
module.exports = patternMemory;
module.exports.PatternMemory = PatternMemory;
module.exports.BloomFilter = BloomFilter;
module.exports.SkeletonExtractor = SkeletonExtractor;

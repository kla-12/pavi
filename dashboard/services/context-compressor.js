'use strict';
/**
 * context-compressor.js — Structural Pruning Pipeline
 *
 * Compresses code context to save tokens for local LLM models.
 * Strips comments, collapses blanks, truncates strings, and sorts
 * chunks by relevance to a query.
 */

/**
 * Compress code text by removing low-signal content.
 * @param {string} codeText
 * @param {object} [options]
 * @param {boolean} [options.keepImports=false]
 * @param {boolean} [options.keepLogs=false]
 * @returns {string}
 */
function compress(codeText, options = {}) {
    if (!codeText || typeof codeText !== 'string') return '';

    const { keepImports = false, keepLogs = false } = options;
    let result = codeText;

    // Strip multi-line comments (/* ... */ and /** ... */)
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');

    // Strip single-line comments (// ...) but not URLs (http:// https://)
    result = result.replace(/(?<!:)\/\/(?!\/)[^\n]*/g, '');

    // Strip import/require statements
    if (!keepImports) {
        result = result.replace(/^(?:const|let|var)\s+\{?[^}]*\}?\s*=\s*require\([^)]+\);?\s*$/gm, '');
        result = result.replace(/^import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '');
        result = result.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
    }

    // Strip console.log/warn/error
    if (!keepLogs) {
        result = result.replace(/^\s*console\.(log|warn|error|info|debug)\([^)]*\);?\s*$/gm, '');
    }

    // Truncate long string literals (>100 chars)
    result = result.replace(/(["'`])([^"'`\n]{100,})\1/g, (match, quote, content) => {
        return quote + content.substring(0, 50) + '...' + quote;
    });

    // Collapse consecutive blank lines into single blank line
    result = result.replace(/\n{3,}/g, '\n\n');

    // Trim leading/trailing whitespace
    result = result.trim();

    return result;
}

/**
 * Split text into chunks and return them sorted by keyword relevance to the query.
 * @param {string} text
 * @param {string} query
 * @param {number} [chunkSize=2000]
 * @returns {Array<{ chunk: string, score: number, index: number }>}
 */
function chunkByRelevance(text, query, chunkSize = 2000) {
    if (!text || !query) return [];

    // Split into chunks
    const chunks = [];
    const lines = text.split('\n');
    let current = '';
    let lineCount = 0;

    for (const line of lines) {
        if (current.length + line.length > chunkSize && current.length > 0) {
            chunks.push(current);
            current = '';
        }
        current += line + '\n';
        lineCount++;
    }
    if (current.trim()) chunks.push(current);

    // Score each chunk by keyword overlap with query
    const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);

    const scored = chunks.map((chunk, index) => {
        const lower = chunk.toLowerCase();
        let score = 0;
        for (const word of queryWords) {
            const matches = (lower.match(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
            score += matches;
        }
        // Bonus for function definitions
        const fnMatches = (chunk.match(/(?:function|async function|const\s+\w+\s*=\s*(?:async\s+)?\()/g) || []).length;
        score += fnMatches * 0.5;

        return { chunk, score, index };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
}

/**
 * Get compression statistics.
 * @param {string} original
 * @param {string} compressed
 * @returns {{ originalTokens: number, compressedTokens: number, reductionPct: number }}
 */
function getStats(original, compressed) {
    const originalTokens = Math.ceil((original || '').length / 4);
    const compressedTokens = Math.ceil((compressed || '').length / 4);
    const reductionPct = originalTokens > 0
        ? parseFloat(((1 - compressedTokens / originalTokens) * 100).toFixed(1))
        : 0;

    return { originalTokens, compressedTokens, reductionPct };
}

module.exports = { compress, chunkByRelevance, getStats };

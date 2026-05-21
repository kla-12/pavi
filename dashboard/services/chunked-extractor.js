'use strict';
/**
 * chunked-extractor.js — Feature-Grouped Semantic Knowledge Extractor
 *
 * Strategy:
 *   IF codeMap.featureGroups is available (from Phase 1 code-cartographer):
 *     → Group files by feature (route + service + model together)
 *     → Each LLM call gets a complete feature with full narrative prompt
 *     → Batch concurrency: 3 features at a time (not all at once)
 *
 *   ELSE (no codeMap, fallback):
 *     → Old size-based chunking (kept as chunkByFileSize())
 *     → Rigid PATTERNS/ALGORITHMS/FUNCTIONS template (kept as buildLegacyPrompt())
 */

const FEATURE_CHUNK_MAX  = 12000;  // max chars per feature chunk
const LEGACY_CHUNK_SIZE  = 8000;   // chars per legacy chunk
const MAX_LEGACY_CHUNKS  = 10;
const FEATURE_BATCH_SIZE = 3;      // parallel LLM calls at a time

// ── Pattern keywords for backward-compat patterns[] return value ─────────────
const PATTERN_KEYWORDS = [
    'repository pattern', 'middleware chain', 'singleton', 'event-driven',
    'observer pattern', 'factory pattern', 'decorator pattern', 'command pattern',
    'strategy pattern', 'proxy pattern', 'pub/sub', 'circuit breaker',
    'retry logic', 'rate limiting', 'pagination', 'caching', 'queue',
    'dependency injection', 'service layer', 'mvc', 'rest api', 'graphql',
    'jwt', 'oauth', 'webhook', 'batch processing', 'streaming',
];

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE-BASED CHUNKING (primary path when codeMap is available)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract the content of a specific file from the codeContext string.
 * codeContext format: "--- File: filename.js ---\n(content)\n--- File: ..."
 *
 * @param {string} codeContext
 * @param {string} relPath - relative path as it appears in codeContext (basename)
 * @returns {string} file content or empty string
 */
function extractFileFromContext(codeContext, relPath) {
    const basename = relPath.split('/').pop();
    // Try both full path and basename
    const patterns = [
        new RegExp(`--- File: ${escapeRegex(relPath)} ---\\n([\\s\\S]*?)(?=\\n--- File:|$)`),
        new RegExp(`--- File: ${escapeRegex(basename)} ---\\n([\\s\\S]*?)(?=\\n--- File:|$)`),
    ];
    for (const re of patterns) {
        const m = codeContext.match(re);
        if (m) return m[1].trim();
    }
    return '';
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a feature chunk object from a featureGroup and codeContext.
 */
function buildFeatureChunk(featureGroup, codeContext, codeMap) {
    // Collect content for all files in this feature group
    let content = '';
    for (const filePath of featureGroup.files) {
        const fileContent = extractFileFromContext(codeContext, filePath);
        if (fileContent) {
            content += `\n\n// === ${filePath} ===\n${fileContent}`;
        }
    }

    // Truncate if over limit
    let truncated = false;
    if (content.length > FEATURE_CHUNK_MAX) {
        content = content.substring(0, FEATURE_CHUNK_MAX);
        truncated = true;
    }

    // Find related imports (what does this feature connect to OUTSIDE the group)
    const groupFileSet = new Set(featureGroup.files);
    const relatedImports = new Set();
    for (const f of featureGroup.files) {
        for (const imp of (codeMap.importGraph[f] || [])) {
            if (!groupFileSet.has(imp)) relatedImports.add(imp.split('/').pop());
        }
    }

    // Find integrations relevant to this feature's code
    const relevantIntegrations = (codeMap.integrations || [])
        .filter(i => content.toLowerCase().includes(i.package.toLowerCase()))
        .map(i => `${i.package} (${i.purpose})`)
        .slice(0, 5);

    return {
        featureName: featureGroup.name,
        files: featureGroup.files,
        content,
        truncated,
        relatedImports: [...relatedImports].slice(0, 5),
        relevantIntegrations,
    };
}

/**
 * Build the narrative prompt for a feature chunk.
 */
function buildFeaturePrompt(chunk, codeMap, topicHint) {
    const projectDesc = codeMap.projectDescription || codeMap.projectName || topicHint;
    const entryPoint  = codeMap.entryPoint || 'unknown';
    const allRoutes   = (codeMap.routeTree || []).length;
    const entities    = (codeMap.domainEntities || []).map(e => e.name).join(', ') || 'none';
    const stackLine   = (codeMap.integrations || []).slice(0, 4).map(i => i.package).join(', ') || 'none';

    return `You are analyzing the "${chunk.featureName}" feature of a software project.

PROJECT CONTEXT:
- Project: ${projectDesc}
- Entry point: ${entryPoint}
- Total API routes in project: ${allRoutes}
- Domain entities: ${entities}
- Key dependencies: ${stackLine}

FEATURE SCOPE:
- Files in this feature: ${chunk.files.join(', ')}
- Connects to: ${chunk.relatedImports.join(', ') || 'nothing outside this feature'}
- Integrations used here: ${chunk.relevantIntegrations.join(', ') || 'none detected'}
${chunk.truncated ? '- [NOTE: Content was truncated to 12000 chars]\n' : ''}
Your task: Explain this feature as a senior developer would in a code review.

Answer ALL 6 questions. Be concrete, not generic. Use function names from the code.

1. WHAT: What does this feature do for the end user? (1-2 sentences max)
2. HOW: What is the technical flow from HTTP request to database response? (numbered steps)
3. DATA: What data does it read/write? Describe the schema or shape of data.
4. PATTERNS: What design patterns does it use? Name them specifically.
5. ERRORS: How does it handle failures? What happens when something goes wrong?
6. REUSE: What part of this code is generic/reusable in a different project?

FEATURE CODE:
${chunk.content}`;
}

/**
 * Process a single feature chunk — call LLM and return structured result.
 */
async function processFeatureChunk(chunk, codeMap, topicHint, askModel, url, model, keys) {
    const prompt = buildFeaturePrompt(chunk, codeMap, topicHint);
    try {
        const narrative = await askModel(url, model, keys, prompt);
        return {
            featureName: chunk.featureName,
            files: chunk.files,
            narrative: narrative || '[empty response]',
            success: true,
        };
    } catch(e) {
        console.warn(`[CHUNKED_EXTRACTOR] Feature "${chunk.featureName}" failed: ${e.message}`);
        return {
            featureName: chunk.featureName,
            files: chunk.files,
            narrative: `[EXTRACTION FAILED: ${e.message}]`,
            success: false,
        };
    }
}

/**
 * Run feature-based extraction.
 * Processes features in batches of FEATURE_BATCH_SIZE.
 */
async function extractByFeature(codeContext, topicHint, askModel, url, model, keys, codeMap) {
    const { featureGroups = [] } = codeMap;

    if (featureGroups.length === 0) {
        console.log('[CHUNKED_EXTRACTOR] No feature groups in codeMap — falling back to size-based chunking');
        return null; // caller will use legacy path
    }

    const featureNames = featureGroups.map(g => g.name);
    console.log(`[CHUNKED_EXTRACTOR] Feature-based chunking: ${featureGroups.length} features identified`);
    console.log(`[CHUNKED_EXTRACTOR] Feature groups: ${featureNames.join(' | ')}`);

    // Build all feature chunks
    const featureChunks = featureGroups.map(fg => buildFeatureChunk(fg, codeContext, codeMap));

    // Process in batches of FEATURE_BATCH_SIZE
    const featureResults = [];
    const totalBatches = Math.ceil(featureChunks.length / FEATURE_BATCH_SIZE);

    for (let i = 0; i < featureChunks.length; i += FEATURE_BATCH_SIZE) {
        const batchNum = Math.floor(i / FEATURE_BATCH_SIZE) + 1;
        const batch = featureChunks.slice(i, i + FEATURE_BATCH_SIZE);
        const batchNames = batch.map(c => c.featureName).join(', ');
        console.log(`[CHUNKED_EXTRACTOR] Processing feature batch ${batchNum}/${totalBatches}: ${batchNames}...`);

        const batchResults = await Promise.all(
            batch.map(chunk => processFeatureChunk(chunk, codeMap, topicHint, askModel, url, model, keys))
        );
        featureResults.push(...batchResults);

        for (const r of batchResults) {
            if (r.success) {
                console.log(`[CHUNKED_EXTRACTOR] Feature "${r.featureName}" analyzed: ${r.narrative.length} chars`);
            }
        }
    }

    const successCount = featureResults.filter(r => r.success).length;
    console.log(`[CHUNKED_EXTRACTOR] Feature extraction complete: ${successCount}/${featureResults.length} features analyzed`);

    // Build merged knowledge document
    const projectDesc = codeMap.projectDescription || codeMap.projectName || topicHint;
    const routeList   = (codeMap.routeTree || []).map(r => `${r.method} ${r.path}  (${r.file})`).join('\n') || 'None detected';
    const entityList  = (codeMap.domainEntities || []).map(e => `- ${e.name}: ${e.fields.slice(0, 6).join(', ')}`).join('\n') || 'None detected';
    const integList   = (codeMap.integrations || []).map(i => `- ${i.package}: ${i.purpose}`).join('\n') || 'None detected';

    const featureSections = featureResults.map(r =>
        `#### Feature: ${r.featureName}\n_Files: ${r.files.join(', ')}_\n\n${r.narrative}`
    ).join('\n\n---\n\n');

    const mergedKnowledge = `## Codebase Analysis: ${projectDesc}

### Project Overview
- **Name:** ${codeMap.projectName || topicHint}
- **Description:** ${projectDesc}
- **Language:** ${codeMap.language || 'unknown'}
- **Entry Point:** ${codeMap.entryPoint || 'unknown'}
- **Total Routes:** ${(codeMap.routeTree || []).length}
- **Domain Entities:** ${(codeMap.domainEntities || []).map(e => e.name).join(', ') || 'none'}

### Route Tree
\`\`\`
${routeList}
\`\`\`

### Key Integrations
${integList}

### Feature Analysis

${featureSections}

### Domain Entities
${entityList}
`;

    // Extract pattern keywords for backward-compat patterns[] return value
    const combinedText = featureResults.map(r => r.narrative).join(' ').toLowerCase();
    const patterns = PATTERN_KEYWORDS.filter(kw => combinedText.includes(kw));

    return {
        mergedKnowledge,
        chunkCount: successCount,
        patterns,
        featureResults, // extra field (ignored by ingester.js, safe to add)
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY SIZE-BASED CHUNKING (fallback when no codeMap)
// ═══════════════════════════════════════════════════════════════════════════════

function chunkByFileSize(codeContext) {
    const chunks = [];
    const files = codeContext.split(/\n--- File: /);
    let current = '';
    for (const file of files) {
        if (current.length + file.length > LEGACY_CHUNK_SIZE) {
            if (current.trim()) chunks.push(current.trim());
            current = '--- File: ' + file;
        } else {
            current += '\n--- File: ' + file;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.slice(0, MAX_LEGACY_CHUNKS);
}

function buildLegacyPrompt(chunk, chunkIndex, totalChunks, topicHint) {
    const hasRoutes   = /router\.(get|post|put|delete)|app\.(get|post)/i.test(chunk);
    const hasModels   = /schema|model|mongoose|sequelize|class .* extends/i.test(chunk);
    const hasServices = /service|manager|handler|processor/i.test(chunk);
    const hasUtils    = /util|helper|lib|common/i.test(chunk);

    const focus = hasRoutes   ? 'API endpoints and route patterns' :
                  hasModels   ? 'data models and database schema' :
                  hasServices ? 'service layer logic and algorithms' :
                  hasUtils    ? 'reusable utility functions' :
                  'general code patterns and architecture';

    return `You are extracting knowledge from chunk ${chunkIndex+1}/${totalChunks} of a codebase about: ${topicHint}.
Focus especially on: ${focus}.

Extract:
1. PATTERNS: Any reusable design patterns (name + how it works in 1-2 sentences)
2. ALGORITHMS: Any non-trivial algorithms or optimization strategies
3. FUNCTIONS: The 3 most important function names and their purpose
4. DEPENDENCIES: Any notable external libraries used and why
5. ERRORS: Any error-handling strategies worth noting

Be concise. Each point should be 1-2 sentences max. Skip boilerplate code.

CODE CHUNK:
${chunk}

Reply in this EXACT format:
PATTERNS: [comma-separated list of pattern:description pairs]
ALGORITHMS: [description or NONE]
FUNCTIONS: [name:purpose, name:purpose, name:purpose]
DEPENDENCIES: [lib:reason, lib:reason or NONE]
ERRORS: [strategy description or NONE]`;
}

async function extractLegacy(codeContext, topicHint, askModel, url, model, keys) {
    const chunks = chunkByFileSize(codeContext);
    console.log(`[CHUNKED_EXTRACTOR] Legacy size-based chunking: ${chunks.length} chunks`);

    const promises = chunks.map((chunk, i) => {
        const prompt = buildLegacyPrompt(chunk, i, chunks.length, topicHint);
        return askModel(url, model, keys, prompt).catch(e => {
            console.warn(`[CHUNKED_EXTRACTOR] Chunk ${i+1} failed: ${e.message}`);
            return null;
        });
    });

    const results = await Promise.all(promises);
    const valid = results.filter(Boolean);

    const allPatterns = [], allAlgorithms = [], allFunctions = [], allDependencies = [], allErrors = [];
    for (const result of valid) {
        const patternMatch = result.match(/PATTERNS:\s*(.+)/);
        const algoMatch    = result.match(/ALGORITHMS:\s*(.+)/);
        const fnMatch      = result.match(/FUNCTIONS:\s*(.+)/);
        const depMatch     = result.match(/DEPENDENCIES:\s*(.+)/);
        const errMatch     = result.match(/ERRORS:\s*(.+)/);
        if (patternMatch && !patternMatch[1].includes('NONE')) allPatterns.push(patternMatch[1]);
        if (algoMatch    && !algoMatch[1].includes('NONE'))    allAlgorithms.push(algoMatch[1]);
        if (fnMatch)    allFunctions.push(fnMatch[1]);
        if (depMatch    && !depMatch[1].includes('NONE'))       allDependencies.push(depMatch[1]);
        if (errMatch    && !errMatch[1].includes('NONE'))       allErrors.push(errMatch[1]);
    }

    const mergedKnowledge = [
        `## Knowledge Extracted from ${valid.length}/${chunks.length} chunks of: ${topicHint}`,
        `\n### Design Patterns Found:\n${[...new Set(allPatterns)].join('\n')}`,
        `\n### Algorithms & Strategies:\n${[...new Set(allAlgorithms)].join('\n')}`,
        `\n### Key Functions:\n${allFunctions.join('\n')}`,
        `\n### Notable Dependencies:\n${[...new Set(allDependencies)].join('\n')}`,
        `\n### Error Handling Strategies:\n${[...new Set(allErrors)].join('\n')}`,
    ].join('\n');

    return { mergedKnowledge, chunkCount: valid.length, patterns: allPatterns };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract knowledge from a codebase.
 *
 * @param {string}   codeContext - Full code context string
 * @param {string}   topicHint  - User's topic label
 * @param {Function} askModel   - async (url, model, keys, prompt) => string
 * @param {string}   url        - LLM endpoint URL
 * @param {string}   model      - LLM model name
 * @param {Array}    keys       - API keys array
 * @param {object|null} codeMap - CodeMap from code-cartographer (Phase 1), or null
 * @returns {Promise<{mergedKnowledge: string, chunkCount: number, patterns: string[]}>}
 */
async function extractAll(codeContext, topicHint, askModel, url, model, keys, codeMap = null) {
    // Use feature-based chunking if codeMap is available
    if (codeMap && Array.isArray(codeMap.featureGroups) && codeMap.featureGroups.length > 0) {
        const result = await extractByFeature(codeContext, topicHint, askModel, url, model, keys, codeMap);
        if (result) return result;
    }

    // Fallback to legacy size-based chunking
    console.log('[CHUNKED_EXTRACTOR] No codeMap available — falling back to size-based chunking');
    return extractLegacy(codeContext, topicHint, askModel, url, model, keys);
}

module.exports = { extractAll, chunkByFile: chunkByFileSize };

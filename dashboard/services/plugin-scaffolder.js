'use strict';
/**
 * plugin-scaffolder.js — Auto-generates executable Pavi plugins from ingested knowledge
 * 
 * When the ingester detects an API client, CLI tool, or data converter pattern,
 * this service generates a valid plugin/index.js and hot-reloads it.
 * 
 * Detected tool types → Plugin trigger regex mapping:
 *   REST API client   → /call\s+<name>|use\s+<name>\s+api/i
 *   Data converter    → /convert\s+to\s+<format>|parse\s+<format>/i
 *   File processor    → /process\s+file|analyze\s+file/i
 */

const fs   = require('fs');
const path = require('path');
const audit = require('../audit-log');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

// Patterns that suggest tool-like capabilities
const TOOL_INDICATORS = [
    { match: /axios|fetch|got|request.*http/i,     type: 'api-client',    triggerHint: 'api|fetch|request' },
    { match: /csv|xlsx|json.*parse|xml.*parse/i,   type: 'data-converter', triggerHint: 'convert|parse|transform' },
    { match: /fs\.read|readFile|writeFile/i,        type: 'file-processor', triggerHint: 'process file|read file|write file' },
    { match: /spawn|exec.*cmd|shell|cli/i,          type: 'cli-wrapper',   triggerHint: 'run command|execute shell' },
    { match: /scrape|cheerio|puppeteer|playwright/i,type: 'web-scraper',   triggerHint: 'scrape|extract from website' },
    { match: /smtp|nodemailer|sendgrid|email/i,     type: 'email-sender',  triggerHint: 'send email|email' },
    { match: /twilio|sms|telegram|slack.*webhook/i, type: 'messaging',     triggerHint: 'send message|notify|sms' },
    { match: /cron|schedule|interval|setInterval/i, type: 'scheduler',     triggerHint: 'schedule|run every|cron' },
];

/**
 * Detect all tool-like patterns that match.
 * @param {string} codeContext
 * @returns {Array<{ match: RegExp, type: string, triggerHint: string }>}
 */
function detectAllToolPatterns(codeContext) {
    return TOOL_INDICATORS.filter(ind => ind.match.test(codeContext));
}

/**
 * Detect if ingested code contains tool-like patterns.
 * @param {string} codeContext
 * @returns {{ detected: boolean, type: string|null, triggerHint: string|null }}
 */
function detectToolPattern(codeContext) {
    const all = detectAllToolPatterns(codeContext);
    if (all.length > 0) {
        return { detected: true, type: all[0].type, triggerHint: all[0].triggerHint };
    }
    return { detected: false, type: null, triggerHint: null };
}

/**
 * Generate a plugin scaffold from ingested knowledge.
 * @param {string} pluginId - Folder name for the plugin (e.g. "github-api-client")
 * @param {string} type - Tool type (e.g. "api-client")
 * @param {string} triggerHint - Regex trigger pattern hint
 * @param {string} description - Short description from skill extraction
 * @param {string} codeExample - Code skeleton example
 * @param {string} sourceRepo - Ingested repo source path
 */
function scaffold(pluginId, type, triggerHint, description, codeExample = '', sourceRepo = '') {
    const pluginDir = path.join(PLUGINS_DIR, pluginId);
    
    // Don't overwrite existing plugins
    if (fs.existsSync(pluginDir)) {
        console.log(`[PLUGIN_SCAFFOLDER] Plugin "${pluginId}" already exists — skipping.`);
        return false;
    }
    
    fs.mkdirSync(pluginDir, { recursive: true });
    
    const safeId = pluginId.replace(/-/g, '_');
    const triggerRegex = triggerHint.split('|').map(t => t.trim()).join('|');
    
    const template = `'use strict';
// Auto-scaffolded by Pavi Plugin Scaffolder from ingested repo knowledge
// Type: ${type} | Generated: ${new Date().toISOString()}
// TODO: Review and complete the execute() function with real implementation

const logger = require('../../utils/logger');

module.exports = {
    name: '${pluginId}',
    version: '1.0.0',
    description: '${description.replace(/'/g, "\\'")}',
    type: 'tool',
    isAutoScaffolded: true,
    sourceRepo: '${sourceRepo.replace(/'/g, "\\'")}',
    trigger: /${triggerRegex}/i,

    describe() {
        return {
            name: '${safeId}',
            description: '${description.replace(/'/g, "\\'")}',
            parameters: {
                input: { type: 'string', description: 'The input data or query for this tool' },
                options: { type: 'object', description: 'Optional parameters', required: false }
            }
        };
    },

    async execute({ input, options = {} }) {
        if (!input) throw new Error('Missing input parameter');
        logger.info(\`[PLUGIN: ${pluginId}] Executing with input: \${input.substring(0, 100)}\`);
        
        // ── TODO: Implement using the pattern below ────────────────────────────
        // Reference skeleton from ingested repo:
        // Source Repo: ${sourceRepo}
${codeExample ? codeExample.split('\n').map(l => '        // ' + l).join('\n') : '        // No example available — implement based on description'}
        // ──────────────────────────────────────────────────────────────────────

        // Placeholder response until implemented
        return {
            success: true,
            message: 'Plugin scaffolded — implement execute() function',
            input,
            type: '${type}'
        };
    },

    init(app) {
        logger.info('[PLUGIN: ${pluginId}] Initialized');
    }
};
`;
    
    fs.writeFileSync(path.join(pluginDir, 'index.js'), template);
    
    // Emit PLUGIN_SCAFFOLDED event to audit trail
    audit.log(audit.EVENT_TYPES.PLUGIN_SCAFFOLDED, {
        tag: pluginId,
        repo: sourceRepo,
        type: type
    });

    console.log(`[PLUGIN_SCAFFOLDER] ⚡ Auto-scaffolded plugin: "${pluginId}" (type: ${type})`);
    return true;
}

module.exports = { detectToolPattern, detectAllToolPatterns, scaffold };

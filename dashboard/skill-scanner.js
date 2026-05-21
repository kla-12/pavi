/**
 * skill-scanner.js
 * Pavi SKILL.md → Bot Registry Scanner
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads all SKILL.md files from the .agents/skills/ directory,
 * parses their YAML frontmatter, and registers them into bots.json.
 *
 * SKILL.md frontmatter format (dual-block):
 *   Block 1 (outer): name, description          ← always present
 *   Block 2 (inner): name, type, color,          ← optional, richer metadata
 *                    description, capabilities, priority
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const BOTS_PATH   = path.join(__dirname, 'bots.json');
const SKILLS_ROOT = path.join(__dirname, '..', '.agents', 'skills');

// Map claude-flow agent types → our role vocabulary
const TYPE_TO_ROLE = {
    developer:    'coder',
    coder:        'coder',
    tester:       'tester',
    reviewer:     'reviewer',
    architect:    'architect',
    researcher:   'researcher',
    coordinator:  'coordinator',
    security:     'security',
    planner:      'architect',
    analyst:      'researcher',
    optimizer:    'coder',
    'security-architect': 'security',
    'performance-engineer': 'coder'
};

// Detect primary language/speciality from capabilities or name
function detectLanguage(name = '', caps = []) {
    const all = [name, ...caps].join(' ').toLowerCase();
    if (all.includes('python'))     return 'python';
    if (all.includes('typescript') || all.includes('ts')) return 'typescript';
    if (all.includes('javascript') || all.includes('js')) return 'javascript';
    if (all.includes('rust'))       return 'rust';
    if (all.includes('go'))         return 'go';
    if (all.includes('java'))       return 'java';
    if (all.includes('mobile') || all.includes('react-native')) return 'mobile';
    if (all.includes('sql') || all.includes('database')) return 'sql';
    if (all.includes('security'))   return 'security';
    if (all.includes('neural') || all.includes('ml')) return 'ml';
    return null;
}

/**
 * Parse YAML frontmatter blocks from a SKILL.md string.
 * Returns the first meaningful block found.
 */
function parseFrontmatter(content) {
    // Find all ---...--- blocks
    const blocks = [];
    const regex = /^---\s*\n([\s\S]*?)^---\s*$/gm;
    let match;
    while ((match = regex.exec(content)) !== null) {
        blocks.push(match[1]);
    }

    const results = blocks.map(block => {
        const obj = {};
        for (const line of block.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const key = line.slice(0, colonIdx).trim();
            const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (key && val && !key.startsWith(' ') && !key.startsWith('-')) {
                obj[key] = val;
            }
        }
        // Parse capabilities list
        const capMatch = block.match(/capabilities:\s*\n((?:\s+-[^\n]+\n?)*)/);
        if (capMatch) {
            obj.capabilities = capMatch[1]
                .split('\n')
                .map(l => l.replace(/^\s+-\s*/, '').trim())
                .filter(Boolean);
        }
        return obj;
    });

    // Prefer the richer (second) block if it has a `type` field
    return results.find(r => r.type) || results[0] || {};
}

/**
 * Extract the system prompt from a SKILL.md:
 * everything after the last --- frontmatter block, up to ~800 chars.
 */
function extractSystemPrompt(content) {
    const lastDash = content.lastIndexOf('\n---\n');
    if (lastDash === -1) return '';
    const body = content.slice(lastDash + 5).trim();
    // Strip markdown headings, keep plain text
    return body
        .replace(/^#+\s+/gm, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .slice(0, 800)
        .trim();
}

const PLUGINS_ROOT = path.join(__dirname, 'plugins');

function scanPluginsFolder(bots, addedBots) {
    if (!fs.existsSync(PLUGINS_ROOT)) return { added: 0, skipped: 0 };

    const folders = fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true })
                      .filter(d => d.isDirectory())
                      .map(d => d.name);

    let added = 0, skipped = 0;

    for (const folder of folders) {
        const pluginPath = path.join(PLUGINS_ROOT, folder, 'index.js');
        if (!fs.existsSync(pluginPath)) { skipped++; continue; }

        try {
            // Clear require cache to get fresh exports
            try { delete require.cache[require.resolve(pluginPath)]; } catch (e) {}
            const plugin = require(pluginPath);

            const name = plugin.name || folder;
            const description = plugin.description || `Auto-scaffolded plugin: ${name}`;
            const version = plugin.version || '1.0.0';

            const botDef = {
                name,
                role: 'coder',
                language: 'javascript',
                description,
                version,
                source: 'plugins (local)',
                isAutoScaffolded: plugin.isAutoScaffolded || false,
                sourceRepo: plugin.sourceRepo || null,
                active: true,
                capabilities: ['plugin', plugin.type || 'tool'],
                registeredAt: new Date().toISOString()
            };

            // Remove null/undefined fields
            Object.keys(botDef).forEach(k => botDef[k] == null && delete botDef[k]);

            const existingIdx = bots.findIndex(b => b.name === name);
            if (existingIdx !== -1) {
                if (bots[existingIdx].description !== botDef.description || 
                    bots[existingIdx].isAutoScaffolded !== botDef.isAutoScaffolded) {
                    bots[existingIdx] = { ...bots[existingIdx], ...botDef };
                    addedBots.push({ ...botDef, _action: 'updated' });
                    added++;
                } else {
                    skipped++;
                }
            } else {
                bots.push(botDef);
                addedBots.push({ ...botDef, _action: 'added' });
                added++;
            }
        } catch (e) {
            console.warn(`[SKILL-SCANNER] Failed to parse plugin ${folder}: ${e.message}`);
            skipped++;
        }
    }
    return { added, skipped };
}

/**
 * Scan all SKILL.md files and plugins, and return an array of bot definitions.
 * @returns {{ added: number, skipped: number, bots: object[] }}
 */
function scanSkillsFolder() {
    let bots = [];
    try {
        if (fs.existsSync(BOTS_PATH)) bots = JSON.parse(fs.readFileSync(BOTS_PATH, 'utf8'));
    } catch(e) { bots = []; }

    let added = 0, skipped = 0;
    const addedBots = [];

    // 1. Scan Skills folder
    if (fs.existsSync(SKILLS_ROOT)) {
        const dirs = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name);

        for (const dir of dirs) {
            const skillPath = path.join(SKILLS_ROOT, dir, 'SKILL.md');
            if (!fs.existsSync(skillPath)) { skipped++; continue; }

            try {
                const content = fs.readFileSync(skillPath, 'utf8');
                const fm      = parseFrontmatter(content);

                // Use the directory name as a stable unique name
                const name        = dir;
                const agentType   = fm.type || 'coder';
                const role        = TYPE_TO_ROLE[agentType] || 'coder';
                const language    = detectLanguage(name, fm.capabilities || []);
                const description = fm.description || `Agent skill: ${name}`;
                const systemPrompt = extractSystemPrompt(content);
                const version     = '1.0.0';

                const botDef = {
                    name,
                    role,
                    language,
                    description,
                    version,
                    source: '.agents/skills (local)',
                    systemPrompt: systemPrompt || undefined,
                    capabilities: fm.capabilities || [],
                    color: fm.color || null,
                    priority: fm.priority || 'normal',
                    active: true,
                    registeredAt: new Date().toISOString()
                };

                // Remove null/undefined fields
                Object.keys(botDef).forEach(k => botDef[k] == null && delete botDef[k]);

                // Check if already registered
                const existingIdx = bots.findIndex(b => b.name === name);
                if (existingIdx !== -1) {
                    // Only update if incoming has richer data
                    if (botDef.description !== bots[existingIdx].description || botDef.role !== bots[existingIdx].role) {
                        bots[existingIdx] = { ...bots[existingIdx], ...botDef };
                        addedBots.push({ ...botDef, _action: 'updated' });
                        added++;
                    } else {
                        skipped++;
                    }
                } else {
                    bots.push(botDef);
                    addedBots.push({ ...botDef, _action: 'added' });
                    added++;
                }
            } catch(e) {
                console.warn(`[SKILL-SCANNER] Failed to parse ${dir}/SKILL.md: ${e.message}`);
                skipped++;
            }
        }
    } else {
        console.warn(`[SKILL-SCANNER] Skills folder not found: ${SKILLS_ROOT}`);
    }

    // 2. Scan Plugins folder
    const pluginResult = scanPluginsFolder(bots, addedBots);
    added += pluginResult.added;
    skipped += pluginResult.skipped;

    // Save
    fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
    return { added, skipped, bots: addedBots };
}

module.exports = { scanSkillsFolder, parseFrontmatter, detectLanguage };

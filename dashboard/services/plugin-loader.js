const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { settingsDB } = require('../db');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

let loadedPlugins = [];
const stats = new Map(); // id -> { invocations: 0, errors: 0, totalLatencyMs: 0, lastUsed: null }

function loadPlugins(app) {
    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }

    const pluginFolders = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    loadedPlugins = [];

    const disabledPlugins = settingsDB.get('disabled_plugins', []);

    for (const folder of pluginFolders) {
        const pluginPath = path.join(PLUGINS_DIR, folder, 'index.js');
        if (fs.existsSync(pluginPath)) {
            try {
                // Clear require cache to allow reloading
                delete require.cache[require.resolve(pluginPath)];
                const plugin = require(pluginPath);
                
                // Initialize plugin with express app if it exposes an init method
                if (typeof plugin.init === 'function') {
                    plugin.init(app);
                }

                const isDisabled = disabledPlugins.includes(folder);

                loadedPlugins.push({
                    id: folder,
                    name: plugin.name || folder,
                    version: plugin.version || '1.0.0',
                    description: plugin.description || 'No description provided.',
                    status: isDisabled ? 'disabled' : 'active',
                    type: plugin.type || 'passive',
                    trigger: plugin.trigger || null,
                    isAutoScaffolded: plugin.isAutoScaffolded || false,
                    sourceRepo: plugin.sourceRepo || null,
                    pluginModule: plugin // Keep a reference for direct execution
                });
                
                if (!stats.has(folder)) {
                    stats.set(folder, { invocations: 0, errors: 0, totalLatencyMs: 0, lastUsed: null });
                }

                logger.info(`[PLUGIN] Successfully loaded: ${folder} (${isDisabled ? 'disabled' : 'active'})`);
            } catch (e) {
                logger.error(`[PLUGIN] Failed to load ${folder}:`, e.message);
                loadedPlugins.push({
                    id: folder,
                    name: folder,
                    status: 'error',
                    error: e.message
                });
            }
        }
    }
}

function getLoadedPlugins() {
    return loadedPlugins.map(p => {
        const pStats = stats.get(p.id) || { invocations: 0, errors: 0, totalLatencyMs: 0, lastUsed: null };
        return {
            id: p.id,
            name: p.name,
            version: p.version,
            description: p.description,
            status: p.status,
            type: p.type,
            isAutoScaffolded: p.isAutoScaffolded || false,
            sourceRepo: p.sourceRepo || null,
            stats: {
                invocations: pStats.invocations,
                errors: pStats.errors,
                avgLatencyMs: pStats.invocations > 0 ? Math.round(pStats.totalLatencyMs / pStats.invocations) : 0,
                lastUsed: pStats.lastUsed
            }
        };
    });
}

function togglePlugin(id, enabled) {
    const disabledPlugins = settingsDB.get('disabled_plugins', []);
    
    if (enabled) {
        const index = disabledPlugins.indexOf(id);
        if (index > -1) {
            disabledPlugins.splice(index, 1);
        }
    } else {
        if (!disabledPlugins.includes(id)) {
            disabledPlugins.push(id);
        }
    }
    
    settingsDB.set('disabled_plugins', disabledPlugins);
    
    const plugin = loadedPlugins.find(p => p.id === id);
    if (plugin && plugin.status !== 'error') {
        plugin.status = enabled ? 'active' : 'disabled';
    }
    return true;
}

function findPluginByTrigger(text) {
    if (!text || typeof text !== 'string') return null;
    
    for (const plugin of loadedPlugins) {
        if (plugin.status === 'active' && plugin.type === 'tool' && plugin.trigger) {
            const matches = text.match(plugin.trigger);
            if (matches) {
                return {
                    plugin,
                    match: matches[0]
                };
            }
        }
    }
    return null;
}

function getToolDescriptions() {
    const descriptions = [];
    for (const plugin of loadedPlugins) {
        if (plugin.status === 'active' && plugin.type === 'tool' && typeof plugin.pluginModule.describe === 'function') {
            try {
                descriptions.push(plugin.pluginModule.describe());
            } catch (e) {
                logger.error(`[PLUGIN] Failed to get description for ${plugin.id}:`, e.message);
            }
        }
    }
    return descriptions;
}

async function executePlugin(id, params) {
    const plugin = loadedPlugins.find(p => p.id === id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    if (plugin.status !== 'active') throw new Error(`Plugin is not active: ${id}`);
    if (plugin.type !== 'tool' || typeof plugin.pluginModule.execute !== 'function') {
        throw new Error(`Plugin ${id} does not support direct tool execution`);
    }

    const pStats = stats.get(id) || { invocations: 0, errors: 0, totalLatencyMs: 0, lastUsed: null };
    pStats.invocations++;
    pStats.lastUsed = new Date().toISOString();
    
    const start = Date.now();
    try {
        const result = await plugin.pluginModule.execute(params);
        pStats.totalLatencyMs += (Date.now() - start);
        stats.set(id, pStats);
        return result;
    } catch (e) {
        pStats.errors++;
        pStats.totalLatencyMs += (Date.now() - start);
        stats.set(id, pStats);
        logger.error(`[PLUGIN] Execution error in ${id}:`, e.message);
        throw e;
    }
}

module.exports = {
    loadPlugins,
    getLoadedPlugins,
    togglePlugin,
    findPluginByTrigger,
    getToolDescriptions,
    executePlugin
};

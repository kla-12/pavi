/**
 * plugin-manager.js
 * 
 * Allows the offline worker (and online reviewer) to dynamically load new 
 * tool capabilities and skills without hardcoding them into orchestrator.js.
 */

const fs = require('fs');
const path = require('path');

class PluginManager {
    constructor(pluginDir) {
        this.pluginDir = pluginDir || path.join(__dirname, 'plugins');
        this.plugins = [];
        this.handlers = {}; // Custom JS execution handlers for tools
        this.initialize();
    }

    initialize() {
        if (!fs.existsSync(this.pluginDir)) {
            fs.mkdirSync(this.pluginDir, { recursive: true });
            
            // Generate a sample standard tool definition to demonstrate capability injection
            const samplePluginPath = path.join(this.pluginDir, 'network-tools.json');
            fs.writeFileSync(samplePluginPath, JSON.stringify({
                name: "network-tools",
                description: "Basic network diagnostics",
                tools: [{
                    type: "function",
                    function: {
                        name: "ping",
                        description: "Ping a host to check network connectivity.",
                        parameters: { 
                            type: "object", 
                            properties: { host: { type: "string" } }, 
                            required: ["host"] 
                        }
                    }
                }]
            }, null, 2));
        }
    }

    loadPlugins() {
        this.plugins = [];
        this.handlers = {};
        
        // 1. Load traditional static/executable plugins from root plugins directory
        if (fs.existsSync(this.pluginDir)) {
            const files = fs.readdirSync(this.pluginDir);
            for (const file of files) {
                const fullPath = path.join(this.pluginDir, file);
                
                // Static JSON schema plugins
                if (file.endsWith('.json')) {
                    try {
                        const pluginData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                        this.plugins.push(pluginData);
                        console.log(`[PLUGIN_MANAGER] Loaded static plugin: ${pluginData.name}`);
                    } catch (e) {
                        console.warn(`[PLUGIN_MANAGER] Failed to load JSON plugin ${file}: ${e.message}`);
                    }
                } 
                // Executable JS plugins
                else if (file.endsWith('.js')) {
                    try {
                        const pluginModule = require(fullPath);
                        if (pluginModule.schema) {
                            this.plugins.push(pluginModule.schema);
                            
                            // Register execution handlers if provided
                            if (pluginModule.handlers) {
                                Object.assign(this.handlers, pluginModule.handlers);
                            }
                            
                            console.log(`[PLUGIN_MANAGER] Loaded executable plugin: ${pluginModule.schema.name}`);
                        }
                    } catch (e) {
                        console.warn(`[PLUGIN_MANAGER] Failed to load JS plugin ${file}: ${e.message}`);
                    }
                }
            }
        }

        // 2. Load folder-based plugins via services/plugin-loader
        try {
            const pluginLoader = require('./services/plugin-loader');
            const mockApp = {
                get: () => {},
                post: () => {},
                use: () => {},
                all: () => {}
            };
            
            // Invoke loader with mock app to safely register routes without crashing CLI executions
            pluginLoader.loadPlugins(mockApp);
            
            const loaded = pluginLoader.getLoadedPlugins();
            for (const p of loaded) {
                if (p.status === 'active' && p.type === 'tool') {
                    // Try to load the module description and map to Orchestrator schema
                    const pluginPath = path.join(this.pluginDir, p.id, 'index.js');
                    if (fs.existsSync(pluginPath)) {
                        try {
                            const pluginModule = require(pluginPath);
                            if (pluginModule && typeof pluginModule.describe === 'function') {
                                const desc = pluginModule.describe();
                                const virtualPlugin = {
                                    name: p.name || p.id,
                                    description: p.description,
                                    tools: [{
                                        type: "function",
                                        function: {
                                            name: desc.name,
                                            description: desc.description,
                                            parameters: {
                                                type: "object",
                                                properties: desc.parameters,
                                                required: Object.keys(desc.parameters)
                                            }
                                        }
                                    }]
                                };
                                this.plugins.push(virtualPlugin);
                                this.handlers[desc.name] = async (args) => {
                                    const res = await pluginLoader.executePlugin(p.id, args);
                                    return typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res);
                                };
                                console.log(`[PLUGIN_MANAGER] Bridged folder-based tool plugin: ${p.id} -> function: ${desc.name}`);
                            }
                        } catch (err) {
                            console.warn(`[PLUGIN_MANAGER] Failed to bridge folder plugin ${p.id}: ${err.message}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`[PLUGIN_MANAGER] Failed to bridge folder-based plugins: ${e.message}`);
        }

        return this.plugins;
    }

    getAdditionalTools() {
        let tools = [];
        for (const plugin of this.plugins) {
            if (plugin.tools && Array.isArray(plugin.tools)) {
                tools = tools.concat(plugin.tools);
            }
        }
        return tools;
    }

    listTools() {
        return this.getAdditionalTools();
    }

    async executeCustomTool(toolName, argsObj) {
        if (this.handlers[toolName]) {
            return await this.handlers[toolName](argsObj);
        }
        return `Error: Tool '${toolName}' definition exists but execution handler is missing.`;
    }
}

// Export singleton instance
module.exports = new PluginManager();

'use strict';
const vm = require('vm');
const logger = require('../../utils/logger');

module.exports = {
    name: 'Code Runner',
    version: '1.0.0',
    description: 'Safely execute JavaScript snippets in a sandboxed vm context.',
    type: 'tool',
    trigger: /execute\s+code|run\s+code|eval\s+code|sandbox\s+js|run\s+javascript/i,

    describe() {
        return {
            name: 'code_runner',
            description: 'Safely execute JavaScript code snippets in a sandboxed VM context and return output/logs.',
            parameters: {
                code: { type: 'string', description: 'The JavaScript code string to execute' },
                timeoutMs: { type: 'number', description: 'Timeout limit in milliseconds (default 2000)' }
            }
        };
    },

    async execute({ code, timeoutMs = 2000 }) {
        if (!code || typeof code !== 'string') {
            throw new Error('Missing code parameter');
        }
        if (code.length > 4000) {
            throw new Error('Code exceeds 4000 character limit');
        }

        logger.info(`[PLUGIN: Code Runner] Executing code (length: ${code.length})`);
        const logs = [];
        const sandbox = {
            console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('[WARN] ' + a.join(' ')) },
            Math, JSON, Date, parseInt, parseFloat, isNaN, isFinite,
            Array, Object, String, Number, Boolean, Map, Set
        };

        try {
            const script = new vm.Script(code, { filename: 'sandbox.js' });
            const ctx = vm.createContext(sandbox);
            const result = script.runInContext(ctx, { timeout: timeoutMs });
            return {
                success: true,
                result: result !== undefined ? String(result) : undefined,
                logs
            };
        } catch (e) {
            logger.warn(`[PLUGIN: Code Runner] Execution error: ${e.message}`);
            return {
                success: false,
                error: e.message,
                logs
            };
        }
    },

    init: (app) => {
        logger.info('[PLUGIN: Code Runner] Initializing sandboxed JS execution plugin...');

        // POST /api/plugins/code-runner  { code: "...", timeoutMs: 2000 }
        app.post('/api/plugins/code-runner', async (req, res) => {
            const { code, timeoutMs = 2000 } = req.body;
            if (!code || typeof code !== 'string') {
                return res.status(400).json({ success: false, error: 'Missing code in request body' });
            }

            try {
                const results = await module.exports.execute({ code, timeoutMs });
                if (results.success) {
                    res.json(results);
                } else {
                    res.status(200).json(results);
                }
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
    }
};

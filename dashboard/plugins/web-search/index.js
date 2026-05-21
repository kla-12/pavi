'use strict';
const logger = require('../../utils/logger');

module.exports = {
    name: 'Web Search',
    version: '2.0.0',
    description: 'Real-time web search via DuckDuckGo Instant Answer API. No API key required.',
    type: 'tool',
    trigger: /search\s+(?:for|about\s+)?(.+)|look\s*up\s+(.+)|google\s+(.+)|find\s+online\s+(.+)/i,

    describe() {
        return {
            name: 'web_search',
            description: 'Search the web for current or real-time information using DuckDuckGo.',
            parameters: {
                q: { type: 'string', description: 'The precise search query term' }
            }
        };
    },

    async execute({ q }) {
        if (!q) throw new Error('Missing query parameter "q"');
        logger.info(`[PLUGIN: Web Search] Running execute for query: "${q}"`);
        
        try {
            const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`);

            const data = await response.json();

            return {
                success: true,
                query: q,
                abstract: data.AbstractText || null,
                abstractSource: data.AbstractSource || null,
                abstractURL: data.AbstractURL || null,
                answer: data.Answer || null,
                relatedTopics: (data.RelatedTopics || []).slice(0, 5).map(t => ({
                    text: t.Text,
                    url: t.FirstURL
                }))
            };
        } catch (e) {
            logger.error('[PLUGIN: Web Search] execute failed:', e.message);
            throw e;
        }
    },

    init: (app) => {
        logger.info('[PLUGIN: Web Search] Initializing DuckDuckGo search plugin...');

        // GET /api/plugins/web-search?q=<query>
        app.get('/api/plugins/web-search', async (req, res) => {
            const query = req.query.q;
            if (!query) return res.status(400).json({ success: false, error: 'Missing ?q= parameter' });

            try {
                const results = await module.exports.execute({ q: query });
                res.json(results);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }
};

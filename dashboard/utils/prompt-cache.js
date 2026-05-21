const crypto = require('crypto');
const { promptCacheDB } = require('../db');

function hashString(str) {
    if (!str) return '';
    return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Check if a prompt exists in the cache.
 */
function getCachedResponse(prompt, systemPrompt, provider, model) {
    const promptHash = hashString(prompt);
    const systemPromptHash = hashString(systemPrompt);
    
    const cached = promptCacheDB.get(promptHash, systemPromptHash, provider, model);
    if (cached) {
        return cached.response;
    }
    return null;
}

/**
 * Save a response to the cache.
 */
function setCachedResponse(prompt, systemPrompt, provider, model, response) {
    const promptHash = hashString(prompt);
    const systemPromptHash = hashString(systemPrompt);
    const id = `cache_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    promptCacheDB.set(id, promptHash, systemPromptHash, provider, model, response);
}

module.exports = {
    getCachedResponse,
    setCachedResponse,
    hashString
};

'use strict';
require('dotenv').config();
/**
 * local-bot.js — Local Bot 2: API Key Escrow & Rate Limiter
 *
 * Acts as a secure intermediary between Pavi and external AI APIs.
 * Raw API keys are NEVER exposed to the frontend. All external calls
 * are pooled, rate-limited, and rotated through this module.
 *
 * Architecture:
 *   Frontend → server.js → LocalBot2 → External API
 *                            ↑
 *              (keys stay here, never returned to client)
 */

const TOKEN_BUCKET_WINDOW_MS = 60_000; // 1 minute window
const DEFAULT_TPM_LIMIT = 60_000;      // tokens per minute ceiling per key

class TokenBucket {
    constructor(limitTPM = DEFAULT_TPM_LIMIT) {
        this.limitTPM = limitTPM;
        this.usedTPM = 0;
        this.windowStart = Date.now();
    }

    /** Attempt to consume `tokens` from bucket. Returns true if allowed. */
    consume(tokens = 1000) {
        const now = Date.now();
        if (now - this.windowStart >= TOKEN_BUCKET_WINDOW_MS) {
            // Reset window
            this.usedTPM = 0;
            this.windowStart = now;
        }
        if (this.usedTPM + tokens > this.limitTPM) return false;
        this.usedTPM += tokens;
        return true;
    }

    getSummary() {
        return {
            usedTPM: this.usedTPM,
            limitTPM: this.limitTPM,
            remainingTPM: Math.max(0, this.limitTPM - this.usedTPM),
            windowResetMs: Math.max(0, TOKEN_BUCKET_WINDOW_MS - (Date.now() - this.windowStart))
        };
    }
}

class KeyPool {
    constructor(keys = [], label = 'pool') {
        this.label = label;
        this.keys = keys.map(k => ({
            key: k,
            bucket: new TokenBucket(),
            errorCount: 0,
            lastUsed: 0,
            rateLimitedUntil: 0
        }));
        this.pointer = 0; // round-robin index
    }

    /** Get next available key. Rotates on 429 / error. Returns null if all exhausted. */
    getNext() {
        const now = Date.now();
        const start = this.pointer;
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (start + i) % this.keys.length;
            const entry = this.keys[idx];
            // Skip rate-limited keys
            if (now < entry.rateLimitedUntil) continue;
            this.pointer = (idx + 1) % this.keys.length;
            return entry;
        }
        return null; // All keys exhausted
    }

    markRateLimited(key, retryAfterMs = 60_000) {
        const entry = this.keys.find(e => e.key === key);
        if (entry) {
            entry.rateLimitedUntil = Date.now() + retryAfterMs;
            entry.errorCount++;
            console.log(`[LOCAL_BOT2][${this.label}] Key ...${key.slice(-6)} rate-limited for ${retryAfterMs / 1000}s`);
        }
    }

    getSummary() {
        const now = Date.now();
        return this.keys.map((e, i) => ({
            index: i,
            suffix: '...' + e.key.slice(-6),
            active: now >= e.rateLimitedUntil,
            rateLimitedUntilMs: e.rateLimitedUntil,
            errorCount: e.errorCount,
            ...e.bucket.getSummary()
        }));
    }
}

class LocalBot2 {
    constructor() {
        this.workerPool = new KeyPool([], 'worker');
        this.reviewerPool = new KeyPool([], 'reviewer');
        this.workerUrl = '';
        this.workerModel = '';
        this.reviewerUrl = '';
        this.reviewerModel = '';
        this.callLog = [];      // Last 50 call records
        this.initialized = false;
    }

    /**
     * Load configuration from a config object (populated from config.json).
     * Called by server.js on startup and on every /api/config POST.
     */
    configure({ workerUrl, workerModel, workerKeys, reviewerUrl, reviewerModel, reviewerKeys } = {}) {
        this.workerUrl = workerUrl || process.env.OLLAMA_URL || '';
        this.workerModel = workerModel || process.env.DEFAULT_MODEL || 'llama3';
        this.reviewerUrl = reviewerUrl || process.env.OLLAMA_URL || '';
        this.reviewerModel = reviewerModel || process.env.DEFAULT_MODEL || 'llama-3.3-70b-versatile';
        this.workerPool = new KeyPool(Array.isArray(workerKeys) ? workerKeys : [], 'worker');
        this.reviewerPool = new KeyPool(Array.isArray(reviewerKeys) ? reviewerKeys : [], 'reviewer');
        this.initialized = true;
        console.log(`[LOCAL_BOT2] Configured. Worker keys: ${this.workerPool.keys.length}, Reviewer keys: ${this.reviewerPool.keys.length}`);
    }

    /**
     * Main call interface. Role: 'worker' | 'reviewer'
     * Returns the AI response string or throws on all-key-failure.
     */
    async call(prompt, role = 'worker', systemPrompt = null, maxTokens = 1500) {
        if (!this.initialized) throw new Error('[LOCAL_BOT2] Not configured. Call configure() first.');

        const pool = role === 'reviewer' ? this.reviewerPool : this.workerPool;
        let url = role === 'reviewer' ? this.reviewerUrl : this.workerUrl;
        let model = role === 'reviewer' ? this.reviewerModel : this.workerModel;

        // Fallback to secure local Ollama if URL is empty or invalid
        if (!url || typeof url !== 'string' || !url.startsWith('http')) {
            console.log(`[LOCAL_BOT2] Invalid or missing URL for ${role}. Falling back to secure local Ollama.`);
            url = 'http://localhost:11434/v1/chat/completions';
            model = 'phi3:mini';
        }

        const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
        
        // Dynamically override model for local connections if selected by user
        if (isLocal && (role === 'worker' || role === 'reviewer')) {
            try {
                const { settingsDB } = require('./db');
                const selected = settingsDB.get('selected_model');
                if (selected) {
                    model = selected;
                }
            } catch (_) {}
        }
        
        let messages = [];
        let estimatedTokens = maxTokens;
        
        if (Array.isArray(prompt)) {
            messages = prompt;
            const totalText = messages.map(m => m.content).join(' ');
            estimatedTokens += Math.ceil(totalText.length / 4);
        } else {
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            messages.push({ role: 'user', content: prompt });
            const promptLen = (systemPrompt ? systemPrompt.length : 0) + (prompt ? prompt.length : 0);
            estimatedTokens += Math.ceil(promptLen / 4);
        }

        const payload = { model, messages, max_tokens: maxTokens };
        const startTime = Date.now();

        // Local model path — no key needed
        if (isLocal) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer local_mode' },
                    body: JSON.stringify(payload)
                });
                const latencyMs = Date.now() - startTime;
                if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
                const data = await response.json();
                const content = this._extractContent(data);
                this._log({ role, url, latencyMs, tokens: estimatedTokens, success: true });
                return content;
            } catch (e) {
                this._log({ role, url, latencyMs: Date.now() - startTime, success: false, error: e.message });
                
                // Fallback to absolute default local Ollama completions if standard local URL failed or model was missing
                if (url !== 'http://localhost:11434/v1/chat/completions' || model !== 'phi3:mini') {
                    console.warn(`[LOCAL_BOT2] Custom local request failed (${e.message}). Retrying absolute default secure local Ollama with phi3:mini...`);
                    try {
                        const fallbackUrl = 'http://localhost:11434/v1/chat/completions';
                        const response = await fetch(fallbackUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer local_mode' },
                            body: JSON.stringify({ ...payload, model: 'phi3:mini' })
                        });
                        if (response.ok) {
                            const data = await response.json();
                            const content = this._extractContent(data);
                            this._log({ role, url: fallbackUrl, latencyMs: 0, tokens: estimatedTokens, success: true });
                            return content;
                        }
                    } catch(fErr) {
                        console.error(`[LOCAL_BOT2] Secure local Ollama fallback also failed: ${fErr.message}`);
                    }
                }
                throw e;
            }
        }

        // External API — use key pool with rotation
        let lastError = null;
        try {
            for (let attempt = 0; attempt < pool.keys.length + 1; attempt++) {
                const entry = pool.getNext();
                if (!entry) throw new Error(`[LOCAL_BOT2][${role}] All keys exhausted or rate-limited.`);

                if (!entry.bucket.consume(estimatedTokens)) {
                    console.log(`[LOCAL_BOT2][${role}] Key ...${entry.key.slice(-6)} bucket full. Rotating.`);
                    continue;
                }

                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${entry.key}`
                        },
                        body: JSON.stringify(payload)
                    });

                    const latencyMs = Date.now() - startTime;

                    if (response.status === 429) {
                        const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10) * 1000;
                        pool.markRateLimited(entry.key, retryAfter);
                        lastError = new Error(`Rate limited (key ...${entry.key.slice(-6)})`);
                        continue; // Try next key
                    }

                    if (!response.ok) {
                        const txt = await response.text();
                        lastError = new Error(`API HTTP ${response.status}: ${txt.slice(0, 200)}`);
                        entry.errorCount++;
                        continue;
                    }

                    const data = await response.json();
                    const content = this._extractContent(data);
                    entry.lastUsed = Date.now();
                    this._log({ role, url, latencyMs, tokens: estimatedTokens, success: true, keySuffix: entry.key.slice(-6) });
                    return content;

                } catch (fetchErr) {
                    lastError = fetchErr;
                    entry.errorCount++;
                    console.error(`[LOCAL_BOT2][${role}] Fetch error: ${fetchErr.message}`);
                }
            }

            if (lastError) throw lastError;
            throw new Error(`[LOCAL_BOT2] All attempts failed for role: ${role}`);
        } catch (err) {
            // Trigger secure local Ollama fallback when external APIs/keys fail
            console.warn(`[LOCAL_BOT2] External API call failed: ${err.message}. Retrying via secure local Ollama...`);
            try {
                const fallbackUrl = 'http://localhost:11434/v1/chat/completions';
                const response = await fetch(fallbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer local_mode' },
                    body: JSON.stringify({ ...payload, model: 'phi3:mini' })
                });
                if (response.ok) {
                    const data = await response.json();
                    const content = this._extractContent(data);
                    this._log({ role, url: fallbackUrl, latencyMs: 0, tokens: estimatedTokens, success: true });
                    return content;
                }
            } catch(fallbackErr) {
                console.error(`[LOCAL_BOT2] Local Ollama fallback also failed: ${fallbackErr.message}`);
            }
            this._log({ role, url, latencyMs: Date.now() - startTime, success: false, error: err.message });
            throw err;
        }
    }

    /** Add a new key to worker or reviewer pool dynamically (e.g. extracted from ingested zip). */
    injectKey(key, pool = 'worker') {
        const target = pool === 'reviewer' ? this.reviewerPool : this.workerPool;
        if (!target.keys.some(e => e.key === key)) {
            target.keys.push({ key, bucket: new TokenBucket(), errorCount: 0, lastUsed: 0, rateLimitedUntil: 0 });
            console.log(`[LOCAL_BOT2][${pool}] Injected new key ...${key.slice(-6)}`);
        }
    }

    async callStream(prompt, role = 'worker', systemPrompt = null, maxTokens = 1500, onToken = null) {
        if (!this.initialized) throw new Error('[LOCAL_BOT2] Not configured. Call configure() first.');

        let url = role === 'reviewer' ? this.reviewerUrl : this.workerUrl;
        let model = role === 'reviewer' ? this.reviewerModel : this.workerModel;

        // Fallback to secure local Ollama if URL is empty or invalid
        if (!url || typeof url !== 'string' || !url.startsWith('http')) {
            url = 'http://localhost:11434/v1/chat/completions';
            model = 'phi3:mini';
        }

        const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
        
        // Dynamically override model for local connections if selected by user
        if (isLocal && (role === 'worker' || role === 'reviewer')) {
            try {
                const { settingsDB } = require('./db');
                const selected = settingsDB.get('selected_model');
                if (selected) {
                    model = selected;
                }
            } catch (_) {}
        }
        
        let messages = [];
        let estimatedTokens = maxTokens;
        
        if (Array.isArray(prompt)) {
            messages = prompt;
            const totalText = messages.map(m => m.content).join(' ');
            estimatedTokens += Math.ceil(totalText.length / 4);
        } else {
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            messages.push({ role: 'user', content: prompt });
            const promptLen = (systemPrompt ? systemPrompt.length : 0) + (prompt ? prompt.length : 0);
            estimatedTokens += Math.ceil(promptLen / 4);
        }

        const payload = { model, messages, max_tokens: maxTokens, stream: true };
        const startTime = Date.now();

        if (isLocal) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer local_mode' },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
                
                const reader = response.body;
                if (!reader) throw new Error('No body in local stream response');
                
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                
                const streamReader = reader.getReader ? reader.getReader() : null;
                
                if (streamReader) {
                    let done = false;
                    while (!done) {
                        const { value, done: doneReading } = await streamReader.read();
                        done = doneReading;
                        if (value) {
                            buffer += decoder.decode(value, { stream: !done });
                            const lines = buffer.split('\n');
                            buffer = lines.pop();
                            
                            for (const line of lines) {
                                const cleanLine = line.trim();
                                if (!cleanLine) continue;
                                if (cleanLine === 'data: [DONE]') continue;
                                if (cleanLine.startsWith('data: ')) {
                                    try {
                                        const parsed = JSON.parse(cleanLine.slice(6));
                                        const delta = parsed?.choices?.[0]?.delta?.content || '';
                                        if (delta) {
                                            fullContent += delta;
                                            if (onToken) onToken(delta);
                                        }
                                    } catch (_) {}
                                }
                            }
                        }
                    }
                } else {
                    for await (const chunk of reader) {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop();
                        
                        for (const line of lines) {
                            const cleanLine = line.trim();
                            if (!cleanLine) continue;
                            if (cleanLine === 'data: [DONE]') continue;
                            if (cleanLine.startsWith('data: ')) {
                                try {
                                    const parsed = JSON.parse(cleanLine.slice(6));
                                    const delta = parsed?.choices?.[0]?.delta?.content || '';
                                    if (delta) {
                                        fullContent += delta;
                                        if (onToken) onToken(delta);
                                    }
                                } catch (_) {}
                            }
                        }
                    }
                }
                
                if (buffer && buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
                    try {
                        const parsed = JSON.parse(buffer.slice(6));
                        const delta = parsed?.choices?.[0]?.delta?.content || '';
                        if (delta) {
                            fullContent += delta;
                            if (onToken) onToken(delta);
                        }
                    } catch (_) {}
                }
                
                const latencyMs = Date.now() - startTime;
                this._log({ role, url, latencyMs, tokens: estimatedTokens, success: true });
                return fullContent;
            } catch (e) {
                console.warn(`[LOCAL_BOT2] Custom local stream failed (${e.message}). Falling back to non-stream default...`);
                const nonStreamContent = await this.call(prompt, role, systemPrompt, maxTokens);
                if (onToken) onToken(nonStreamContent);
                return nonStreamContent;
            }
        } else {
            const content = await this.call(prompt, role, systemPrompt, maxTokens);
            if (onToken) onToken(content);
            return content;
        }
    }

    /** Returns rate stats for both pools. Keys are NEVER included in this output. */
    getRateSummary() {
        return {
            worker: {
                url: this.workerUrl,
                model: this.workerModel,
                keys: this.workerPool.getSummary()
            },
            reviewer: {
                url: this.reviewerUrl,
                model: this.reviewerModel,
                keys: this.reviewerPool.getSummary()
            },
            recentCalls: this.callLog.slice(-10)
        };
    }

    _extractContent(data) {
        if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content;
        if (data?.response) return data.response;
        if (data?.content?.[0]?.text) return data.content[0].text;
        throw new Error('[LOCAL_BOT2] Unrecognised API response format');
    }

    _log(entry) {
        this.callLog.push({ ts: new Date().toISOString(), ...entry });
        if (this.callLog.length > 50) this.callLog.shift();
    }
}

// Singleton export — shared across all server.js requires
const localBot2 = new LocalBot2();
module.exports = localBot2;

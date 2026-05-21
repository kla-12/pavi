'use strict';
/**
 * circuit-breaker.js — Stateful Circuit Breaker for API Calls
 *
 * Implements the Circuit Breaker pattern to fail gracefully
 * when upstream APIs (Groq, OpenAI, Gemini) become unreliable.
 *
 * States:
 *   CLOSED    → Normal operation, requests flow through
 *   OPEN      → Failing fast, all requests rejected immediately
 *   HALF_OPEN → Testing recovery with limited requests
 */

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
    /**
     * @param {object} options
     * @param {string} options.name
     * @param {number} [options.failureThreshold=5]
     * @param {number} [options.resetTimeoutMs=30000]
     * @param {number} [options.halfOpenMax=2]
     */
    constructor({ name, failureThreshold = 5, resetTimeoutMs = 30000, halfOpenMax = 2 }) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.resetTimeoutMs = resetTimeoutMs;
        this.halfOpenMax = halfOpenMax;

        this.state = STATES.CLOSED;
        this.failures = 0;
        this.halfOpenAttempts = 0;
        this.lastFailure = null;
        this.lastSuccess = null;
        this.openedAt = null;
    }

    /**
     * Wrap an async function with circuit breaker logic.
     * @param {Function} fn - async function to call
     * @returns {Promise<*>}
     */
    async call(fn) {
        // Check if we should transition from OPEN → HALF_OPEN
        if (this.state === STATES.OPEN) {
            const elapsed = Date.now() - (this.openedAt || 0);
            if (elapsed >= this.resetTimeoutMs) {
                this.state = STATES.HALF_OPEN;
                this.halfOpenAttempts = 0;
                console.log(`[CIRCUIT_BREAKER] ${this.name}: OPEN → HALF_OPEN (testing recovery)`);
            } else {
                throw new Error(`Circuit OPEN for ${this.name}. Retry after ${Math.ceil((this.resetTimeoutMs - elapsed) / 1000)}s.`);
            }
        }

        // HALF_OPEN: limit attempts
        if (this.state === STATES.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenMax) {
            throw new Error(`Circuit HALF_OPEN for ${this.name}. Max test attempts reached.`);
        }

        try {
            if (this.state === STATES.HALF_OPEN) this.halfOpenAttempts++;

            const result = await fn();

            // Success → reset
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure();
            throw error;
        }
    }

    _onSuccess() {
        this.failures = 0;
        this.lastSuccess = Date.now();
        if (this.state !== STATES.CLOSED) {
            console.log(`[CIRCUIT_BREAKER] ${this.name}: ${this.state} → CLOSED (recovered)`);
            this.state = STATES.CLOSED;
        }
    }

    _onFailure() {
        this.failures++;
        this.lastFailure = Date.now();

        if (this.state === STATES.HALF_OPEN) {
            // Any failure in HALF_OPEN → back to OPEN
            this.state = STATES.OPEN;
            this.openedAt = Date.now();
            console.warn(`[CIRCUIT_BREAKER] ${this.name}: HALF_OPEN → OPEN (recovery failed)`);
        } else if (this.failures >= this.failureThreshold) {
            this.state = STATES.OPEN;
            this.openedAt = Date.now();
            console.warn(`[CIRCUIT_BREAKER] ${this.name}: CLOSED → OPEN (${this.failures} failures)`);
        }
    }

    /**
     * Get current breaker state.
     */
    getState() {
        return {
            name: this.name,
            state: this.state,
            failures: this.failures,
            lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null,
            lastSuccess: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : null,
        };
    }

    /**
     * Force-reset to CLOSED.
     */
    reset() {
        this.state = STATES.CLOSED;
        this.failures = 0;
        this.halfOpenAttempts = 0;
        console.log(`[CIRCUIT_BREAKER] ${this.name}: Force reset → CLOSED`);
    }
}

// ── Singleton Registry ────────────────────────────────────────────────────────
const breakers = {};

/**
 * Get or create a circuit breaker by name.
 * @param {string} name
 * @param {object} [options]
 * @returns {CircuitBreaker}
 */
function getBreaker(name, options = {}) {
    if (!breakers[name]) {
        breakers[name] = new CircuitBreaker({ name, ...options });
    }
    return breakers[name];
}

/**
 * Get status of all circuit breakers.
 * @returns {Array<object>}
 */
function getAllBreakerStates() {
    return Object.values(breakers).map(b => b.getState());
}

module.exports = { CircuitBreaker, getBreaker, getAllBreakerStates, STATES };

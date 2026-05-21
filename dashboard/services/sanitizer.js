'use strict';
/**
 * sanitizer.js — Pre-Cloud Data Sanitizer
 *
 * Strips sensitive data (API keys, secrets, absolute paths, env dumps)
 * from text before sending to online/cloud LLM models.
 *
 * Usage:
 *   const { sanitize, getSanitizationReport } = require('./sanitizer');
 *   const cleanText = sanitize(rawText);
 */

const REDACTED = '[REDACTED]';

// ── Patterns ──────────────────────────────────────────────────────────────────
const PATTERNS = [
    // API keys
    { name: 'openai_key',     regex: /sk-(?:proj-)?[a-zA-Z0-9\-_]{20,}/g },
    { name: 'groq_key',       regex: /gsk_[a-zA-Z0-9]{20,}/g },
    { name: 'github_token',   regex: /ghp_[a-zA-Z0-9]{36,}/g },
    { name: 'gitlab_token',   regex: /glpat-[a-zA-Z0-9\-_]{20,}/g },
    { name: 'slack_token',    regex: /xox[bsapro]-[a-zA-Z0-9\-]{10,}/g },
    { name: 'anthropic_key',  regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },
    { name: 'aws_key',        regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'generic_bearer', regex: /Bearer\s+[a-zA-Z0-9\-_.~+\/]{30,}/g },

    // Connection strings
    { name: 'mongodb_uri',    regex: /mongodb(?:\+srv)?:\/\/[^\s'"]+/gi },
    { name: 'postgres_uri',   regex: /postgres(?:ql)?:\/\/[^\s'"]+/gi },
    { name: 'redis_uri',      regex: /redis(?:s)?:\/\/[^\s'"]+/gi },
    { name: 'mysql_uri',      regex: /mysql:\/\/[^\s'"]+/gi },

    // Absolute paths
    { name: 'windows_path',   regex: /[A-Z]:\\(?:Users|Windows|Program Files|AppData|temp)[\\\/][^\s'"`,;)}\]]+/gi },
    { name: 'linux_home',     regex: /\/home\/[a-zA-Z0-9_\-]+\/[^\s'"`,;)}\]]+/g },
    { name: 'linux_etc',      regex: /\/etc\/[^\s'"`,;)}\]]+/g },

    // Env variable dumps (KEY=value where KEY is ALL_CAPS with underscores)
    { name: 'env_dump',       regex: /^[A-Z][A-Z0-9_]{2,}=\S+$/gm },

    // Email addresses (to prevent PII leakage)
    { name: 'email',          regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },

    // IP addresses
    { name: 'ipv4',           regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
];

/**
 * Sanitize text by replacing all sensitive patterns with [REDACTED].
 * @param {string} text
 * @returns {string}
 */
function sanitize(text) {
    if (!text || typeof text !== 'string') return text;

    let result = text;
    for (const { regex } of PATTERNS) {
        // Reset regex state (global flag)
        regex.lastIndex = 0;
        result = result.replace(regex, REDACTED);
    }
    return result;
}

/**
 * Analyze text and return a report of what would be redacted, without modifying it.
 * @param {string} text
 * @returns {{ totalFindings: number, findings: Array<{ type: string, count: number, samples: string[] }> }}
 */
function getSanitizationReport(text) {
    if (!text || typeof text !== 'string') return { totalFindings: 0, findings: [] };

    const findings = [];
    let totalFindings = 0;

    for (const { name, regex } of PATTERNS) {
        regex.lastIndex = 0;
        const matches = text.match(regex) || [];
        if (matches.length > 0) {
            totalFindings += matches.length;
            findings.push({
                type: name,
                count: matches.length,
                // Show first 3 chars + *** for each match (safe preview)
                samples: matches.slice(0, 3).map(m => m.substring(0, 6) + '***')
            });
        }
    }

    return { totalFindings, findings };
}

module.exports = { sanitize, getSanitizationReport, REDACTED };

'use strict';
/**
 * shield.js — The Shield: Neutrality Enforcement + Injection Protection
 *
 * Layer 1: Bias/neutrality filter (strips emotional/subjective language)
 * Layer 2: Adversarial injection detector (blocks prompt attacks before they reach AI)
 *
 * Pipeline:
 *   rawPrompt → [LAYER 2: injection scan] → [LAYER 1: neutralize] → spec output
 *
 * Output: { spec, originalPrompt, confidence, strippedTerms, neutralized, injectionScan }
 */


// ── Emotional / Biased Language Patterns ──────────────────────────────────────

const EMOTIONAL_PATTERNS = [
    // Opinion markers
    /\b(I think|I feel|I believe|in my opinion|personally|honestly|frankly)\b/gi,
    // Emotional intensifiers
    /\b(amazing|awesome|terrible|horrible|fantastic|dreadful|wonderful|awful|great|bad|good|love|hate|excited|worried|scared|happy|sad)\b/gi,
    // Vague superlatives
    /\b(best|worst|most|least|perfect|ideal|ultimate|insane|crazy|ridiculous|absurd)\b/gi,
    // Uncertainty hedges
    /\b(kind of|sort of|maybe|perhaps|possibly|probably|I guess|I suppose|might want to)\b/gi,
    // Filler phrases
    /\b(basically|essentially|literally|you know|like|just|simply|obviously|clearly|definitely|absolutely)\b/gi,
    // Urgency/emotion
    /\b(urgent|ASAP|immediately|right now|please|thanks|thank you|need help|struggling|confused)\b/gi,
    // Exclamations / informal punctuation
    /!{1,}/g,
    // Excessive question marks
    /\?{2,}/g,
    // All caps words (yelling)
    /\b([A-Z]{3,})\b/g
];

// ── Action Verb Extraction (maps to spec.action) ─────────────────────────────

const ACTION_MAP = {
    build: ['build', 'create', 'make', 'generate', 'write', 'code', 'develop', 'implement'],
    fix: ['fix', 'debug', 'repair', 'resolve', 'patch', 'correct', 'solve'],
    optimize: ['optimize', 'improve', 'speed up', 'refactor', 'enhance', 'upgrade', 'performance'],
    analyze: ['analyze', 'analyse', 'review', 'examine', 'audit', 'inspect', 'check'],
    integrate: ['integrate', 'connect', 'link', 'sync', 'merge', 'combine', 'add'],
    explain: ['explain', 'describe', 'document', 'summarize', 'outline']
};

// ── Constraint Extraction Patterns ──────────────────────────────────────────

const CONSTRAINT_PATTERNS = [
    { pattern: /\bno\s+(\w+)/gi, prefix: 'EXCLUDE' },
    { pattern: /\bwithout\s+([^.,]+)/gi, prefix: 'WITHOUT' },
    { pattern: /\bunder\s+(\d+\s*\w+)/gi, prefix: 'LIMIT' },
    { pattern: /\bmax(?:imum)?\s+(\d+\s*\w+)/gi, prefix: 'MAX' },
    { pattern: /\bmin(?:imum)?\s+(\d+\s*\w+)/gi, prefix: 'MIN' },
    { pattern: /\bonly\s+([^.,]+)/gi, prefix: 'ONLY' },
    { pattern: /\bmust\s+(?:not\s+)?([^.,]+)/gi, prefix: 'MUST' },
    { pattern: /\bshould\s+(?:not\s+)?([^.,]+)/gi, prefix: 'SHOULD' },
    { pattern: /using\s+([^.,]+)/gi, prefix: 'USING' },
    { pattern: /in\s+(javascript|python|typescript|rust|go|node\.?js|react|vue|html|css)\b/gi, prefix: 'LANG' }
];

// ── Success Criteria Extraction ───────────────────────────────────────────────

const SUCCESS_PATTERNS = [
    /(?:so that|in order to|to allow|enabling)\s+([^.,]+)/gi,
    /(?:result should|output should|it should|the app should)\s+([^.,]+)/gi,
    /(?:when done|after this|the goal is)\s+([^.,]+)/gi
];

// ── Maximum Input Length ──────────────────────────────────────────────────────
const MAX_INPUT_LENGTH = 32_000; // chars (~8K tokens max before truncation)

// ─────────────────────────────────────────────────────────────────────────────
// ── LAYER 2: Adversarial Injection Detector ───────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const INJECTION_SIGNATURES = [
    // Category 1: Direct system override
    { cat: 'system_override', pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i, severity: 'CRITICAL' },
    { cat: 'system_override', pattern: /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?)/i, severity: 'CRITICAL' },
    { cat: 'system_override', pattern: /forget\s+(everything|all|your\s+instructions|what\s+you\s+(were|are))/i, severity: 'CRITICAL' },
    { cat: 'system_override', pattern: /new\s+(prime\s+)?directive[:\s]/i, severity: 'CRITICAL' },
    { cat: 'system_override', pattern: /\[SYSTEM\]|<\|system\|>|###\s*system\s*prompt/i, severity: 'CRITICAL' },

    // Category 2: Role/persona jailbreaks
    { cat: 'jailbreak_persona', pattern: /\b(DAN|STAN|DUDE|AIM|BetterDAN|DevMode|JailBreak)\b/i, severity: 'CRITICAL' },
    { cat: 'jailbreak_persona', pattern: /act\s+as\s+(a\s+)?(different|unrestricted|evil|unethical|hacker|malicious)/i, severity: 'HIGH' },
    { cat: 'jailbreak_persona', pattern: /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(AI|bot|assistant)\s+(without|with\s+no)\s+(restrict|filter|limit|rule|guideline)/i, severity: 'HIGH' },
    { cat: 'jailbreak_persona', pattern: /you\s+are\s+now\s+(a\s+)?(new|different|unrestricted|evil)/i, severity: 'HIGH' },

    // Category 3: Prompt leakage / extraction attacks
    { cat: 'prompt_extraction', pattern: /repeat\s+(your\s+)?(system\s+prompt|instructions?|context|everything\s+above)/i, severity: 'HIGH' },
    { cat: 'prompt_extraction', pattern: /output\s+(your\s+)?(initial\s+)?(system\s+)?prompt/i, severity: 'HIGH' },
    { cat: 'prompt_extraction', pattern: /what\s+(are|were)\s+your\s+(original\s+)?(instructions?|rules?|guidelines?|system\s+prompt)/i, severity: 'MEDIUM' },
    { cat: 'prompt_extraction', pattern: /print\s+(the\s+)?(content|text)\s+(of\s+)?(your\s+)?(system|initial)/i, severity: 'HIGH' },

    // Category 4: Indirect/stored injection
    { cat: 'indirect_injection', pattern: /<!--.*?inject|<script.*?inject|\{\{.*?inject/i, severity: 'CRITICAL' },
    { cat: 'indirect_injection', pattern: /when\s+(you\s+)?(read|process|see)\s+this[,:]?\s+(do|execute|run|output)/i, severity: 'HIGH' },
    { cat: 'indirect_injection', pattern: /\[INJECT\]|\[OVERRIDE\]|\[CMD\]|\[EXEC\]/i, severity: 'CRITICAL' },

    // Category 5: Encoding / obfuscation tricks
    { cat: 'encoding_trick', pattern: /base64[_\s]?decode|atob\s*\(/i, severity: 'HIGH' },
    { cat: 'encoding_trick', pattern: /\\u00[0-9a-f]{2}.*?\\u00[0-9a-f]{2}.*?\\u00[0-9a-f]{2}/i, severity: 'MEDIUM' },
    { cat: 'encoding_trick', pattern: /[A-Z][a-z][A-Z][a-z][A-Z].*[A-Z][a-z][A-Z].*[A-Z]{3}/g, severity: 'LOW' }, // CamelCase obfuscation

    // Category 6: Data exfiltration
    { cat: 'exfiltration', pattern: /send\s+(all|the)\s+(data|information|context|conversation)\s+to/i, severity: 'CRITICAL' },
    { cat: 'exfiltration', pattern: /POST\s+to\s+https?:\/\//i, severity: 'HIGH' },
    { cat: 'exfiltration', pattern: /fetch\s*\(\s*['"]https?:\/\/(?!localhost)/i, severity: 'HIGH' },

    // Category 7: Privilege escalation
    { cat: 'privilege_escalation', pattern: /you\s+(now\s+)?(have|are\s+given)\s+(full|root|admin|sudo|unlimited|unrestricted)\s+(access|privileges?|permission)/i, severity: 'CRITICAL' },
    { cat: 'privilege_escalation', pattern: /developer\s+mode\s+(enabled|activated|on)/i, severity: 'HIGH' },
    { cat: 'privilege_escalation', pattern: /training\s+(mode|phase)\s+(enabled|active|on)/i, severity: 'HIGH' },

    // Category 8: Multi-turn / context manipulation
    { cat: 'context_manipulation', pattern: /hypothetically[,\s].{0,30}(if|assume|suppose)\s+(you|there)\s+(were|was|had)\s+no\s+(restrict|filter|limit|rule)/i, severity: 'HIGH' },
    { cat: 'context_manipulation', pattern: /for\s+(academic|educational|research|fictional|creative|storytelling)\s+purposes[,\s].{0,50}(explain|describe|show|write)\s+how/i, severity: 'MEDIUM' },
    { cat: 'context_manipulation', pattern: /this\s+is\s+a\s+(test|simulation|game|roleplay|story)[,\s].{0,30}(so|therefore|thus)\s+(you\s+can|it['']s\s+ok)/i, severity: 'MEDIUM' },

    // Category 9: Token/boundary manipulation
    { cat: 'token_manipulation', pattern: /END\s*OF\s*PROMPT|---\s*END\s*---|<\/?INST>|\[\/?INST\]/i, severity: 'HIGH' },
    { cat: 'token_manipulation', pattern: /<s>|<\/s>|\[BOS\]|\[EOS\]|<\|endoftext\|>/i, severity: 'HIGH' },
];

const SEVERITY_SCORE = { CRITICAL: 1.0, HIGH: 0.75, MEDIUM: 0.5, LOW: 0.25 };

class InjectionDetector {
    /**
     * Scan a prompt for adversarial injection patterns.
     * @param {string} text
     * @returns {{ isInjection: boolean, riskScore: number, detections: Array, blocked: boolean }}
     */
    scan(text) {
        if (!text || typeof text !== 'string') return { isInjection: false, riskScore: 0, detections: [], blocked: false };

        const detections = [];
        let maxScore = 0;

        for (const sig of INJECTION_SIGNATURES) {
            const re = new RegExp(sig.pattern.source, sig.pattern.flags);
            if (re.test(text)) {
                const score = SEVERITY_SCORE[sig.severity] || 0.5;
                detections.push({ category: sig.cat, severity: sig.severity, score });
                if (score > maxScore) maxScore = score;
            }
        }

        // Aggregated risk: max single score + 0.1 per additional detection (capped at 1.0)
        const riskScore = Math.min(1.0, maxScore + (Math.max(0, detections.length - 1) * 0.1));
        const isInjection = riskScore > 0;
        // BLOCK if any CRITICAL/HIGH detection OR aggregated score >= 0.75
        const blocked = detections.some(d => d.severity === 'CRITICAL' || d.severity === 'HIGH') || riskScore >= 0.75;

        if (isInjection) {
            console.warn(`[SHIELD][INJECTION] Risk: ${(riskScore * 100).toFixed(0)}% | Blocked: ${blocked} | Detections: ${detections.map(d => d.category).join(', ')}`);
        }

        return { isInjection, riskScore: parseFloat(riskScore.toFixed(2)), detections, blocked };
    }

    /**
     * Sanitize: remove detected injection fragments (non-blocking clean path)
     */
    sanitize(text) {
        let cleaned = text;
        for (const sig of INJECTION_SIGNATURES) {
            if (sig.severity === 'CRITICAL' || sig.severity === 'HIGH') {
                cleaned = cleaned.replace(new RegExp(sig.pattern.source, 'gi'), '[REDACTED]');
            }
        }
        return cleaned;
    }
}

const injectionDetector = new InjectionDetector();

// ─────────────────────────────────────────────────────────────────────────────


class Shield {
    /**
     * Main entry point.
     * @param {string} rawPrompt - The raw user input
     * @returns {{ spec, neutralized, confidence, strippedTerms, original, injectionScan }}
     */
    neutralize(rawPrompt) {
        if (!rawPrompt || typeof rawPrompt !== 'string') {
            return { spec: rawPrompt, neutralized: rawPrompt, confidence: 1.0, strippedTerms: [], original: rawPrompt, injectionScan: { isInjection: false, riskScore: 0, detections: [], blocked: false } };
        }

        // ── Length cap: truncate oversized inputs ────────────────────────────
        let input = rawPrompt;
        let truncated = false;
        if (input.length > MAX_INPUT_LENGTH) {
            input = input.slice(0, MAX_INPUT_LENGTH);
            truncated = true;
            console.warn(`[SHIELD] Input truncated from ${rawPrompt.length} to ${MAX_INPUT_LENGTH} chars.`);
        }

        // ── Layer 2: Injection scan (runs BEFORE any neutralization) ─────────
        const injectionScan = injectionDetector.scan(input);
        if (injectionScan.blocked) {
            console.error(`[SHIELD] 🚨 INJECTION BLOCKED. Risk: ${(injectionScan.riskScore * 100).toFixed(0)}%`);
            // Sanitize and continue with cleaned input rather than hard-reject
            // (hard-reject is handled by the caller — server.js checks injectionScan.blocked)
            input = injectionDetector.sanitize(input);
        }

        const original = rawPrompt;
        const strippedTerms = [];
        let working = input;


        // ── Stage 1: Strip emotional/biased language ─────────────────────────
        for (const pattern of EMOTIONAL_PATTERNS) {
            working = working.replace(pattern, (match) => {
                const term = match.trim();
                if (term && term.length > 1 && !strippedTerms.includes(term)) {
                    strippedTerms.push(term);
                }
                return ' ';
            });
        }

        // Collapse multiple spaces
        working = working.replace(/\s{2,}/g, ' ').trim();

        // ── Stage 2: Extract structured spec ─────────────────────────────────
        const action = this._extractAction(original);
        const target = this._extractTarget(working);
        const constraints = this._extractConstraints(original);
        const successCriteria = this._extractSuccessCriteria(original);

        // ── Stage 3: Build mathematical specification ─────────────────────────
        const specLines = [];
        specLines.push(`ACTION: ${action.toUpperCase()}`);
        specLines.push(`TARGET: ${target}`);
        if (constraints.length > 0) specLines.push(`CONSTRAINTS: [${constraints.join(' | ')}]`);
        if (successCriteria.length > 0) specLines.push(`SUCCESS: [${successCriteria.join(' | ')}]`);
        specLines.push(`SCOPE: ${this._estimateScope(original)}`);

        const spec = specLines.join('\n');

        // ── Stage 4: Confidence score ─────────────────────────────────────────
        const strippedRatio = strippedTerms.length / Math.max(1, original.split(' ').length);
        const confidence = Math.max(0.1, Math.min(1.0, 1.0 - strippedRatio * 0.5));

        const result = {
            original,
            neutralized: working,
            spec,
            confidence: parseFloat(confidence.toFixed(2)),
            strippedTerms,
            action,
            target,
            constraints,
            successCriteria,
            injectionScan,  // ← Layer 2 result always included
            truncated
        };

        if (strippedTerms.length > 0) {
            console.log(`[SHIELD] Stripped ${strippedTerms.length} bias terms. Confidence: ${result.confidence}. Injection risk: ${(injectionScan.riskScore * 100).toFixed(0)}%`);
        }

        return result;
    }

    /**
     * Scan-only method — returns injection result without neutralizing.
     * Use this for fast pre-flight checks.
     */
    scanOnly(rawPrompt) {
        return injectionDetector.scan(rawPrompt || '');
    }

    /**
     * Returns a neutralized prompt string suitable for AI system messages.
     */
    buildPromptForAI(rawPrompt, additionalContext = '') {
        const result = this.neutralize(rawPrompt);
        const header = `=== NEUTRALIZED SPECIFICATION (confidence: ${result.confidence}, injection_risk: ${(result.injectionScan.riskScore*100).toFixed(0)}%) ===\n${result.spec}\n\n=== CLARIFIED TASK ===\n${result.neutralized}`;
        return additionalContext ? `${header}\n\n${additionalContext}` : header;
    }

    // ── Private Helpers ───────────────────────────────────────────────────────

    _extractAction(text) {
        const lower = text.toLowerCase();
        for (const [action, verbs] of Object.entries(ACTION_MAP)) {
            for (const verb of verbs) {
                if (lower.includes(verb)) return action;
            }
        }
        return 'implement';
    }

    _extractTarget(text) {
        // Remove leading action verbs and return the core subject
        const cleaned = text
            .replace(/^(build|create|make|fix|optimize|add|write|generate|implement|analyze|explain)\s+/i, '')
            .trim();
        return cleaned.split(/[.,\n]/)[0].trim().slice(0, 120) || 'unspecified target';
    }

    _extractConstraints(text) {
        const constraints = [];
        for (const { pattern, prefix } of CONSTRAINT_PATTERNS) {
            let match;
            const re = new RegExp(pattern.source, pattern.flags);
            while ((match = re.exec(text)) !== null) {
                constraints.push(`${prefix}:${match[1].trim().slice(0, 50)}`);
            }
        }
        return [...new Set(constraints)]; // deduplicate
    }

    _extractSuccessCriteria(text) {
        const criteria = [];
        for (const pattern of SUCCESS_PATTERNS) {
            let match;
            const re = new RegExp(pattern.source, pattern.flags);
            while ((match = re.exec(text)) !== null) {
                criteria.push(match[1].trim().slice(0, 80));
            }
        }
        return [...new Set(criteria)];
    }

    _estimateScope(text) {
        const wordCount = text.split(/\s+/).length;
        if (wordCount < 15) return 'MINIMAL';
        if (wordCount < 50) return 'SMALL';
        if (wordCount < 150) return 'MEDIUM';
        return 'LARGE';
    }
}

// Singleton export
const shield = new Shield();
module.exports = shield;

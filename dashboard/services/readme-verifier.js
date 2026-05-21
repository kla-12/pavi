'use strict';
/**
 * readme-verifier.js — Static README vs Code Comparison
 *
 * Zero LLM cost for the static comparison.
 * LLM is called only when discrepancies are detected (called from ingester.js, not here).
 *
 * Never throws. All functions return safe defaults on error.
 */

// ── Tech terms to scan for in README text ────────────────────────────────────
const TECH_TERMS = [
    'react', 'vue', 'angular', 'svelte', 'next.js', 'nextjs', 'nuxt',
    'express', 'fastify', 'koa', 'hapi',
    'django', 'flask', 'fastapi', 'rails', 'laravel', 'spring',
    'graphql', 'rest', 'grpc', 'websocket', 'socket.io',
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'sqlite', 'dynamodb',
    'kafka', 'rabbitmq', 'celery', 'bull', 'bullmq',
    'docker', 'kubernetes', 'k8s', 'terraform',
    'aws', 'gcp', 'azure', 's3', 'lambda',
    'stripe', 'paypal', 'braintree',
    'openai', 'gpt', 'claude', 'langchain', 'llm', 'ai', 'machine learning', 'ml',
    'pytorch', 'tensorflow', 'scikit-learn', 'numpy', 'pandas',
    'jwt', 'oauth', 'passport', 'auth0',
    'typescript', 'python', 'golang', 'rust', 'java',
];

// ── Domain terms for bonus scoring ────────────────────────────────────────────
const DOMAIN_TERMS = [
    'payment', 'auth', 'authentication', 'authorization', 'review', 'chat',
    'analytics', 'dashboard', 'api', 'deploy', 'monitor', 'notify',
    'search', 'recommendation', 'booking', 'scheduling', 'inventory',
    'ecommerce', 'marketplace', 'social', 'collaboration', 'workflow',
];

/**
 * Extract structured information from raw README text.
 *
 * @param {string} readmeContent - Raw README text
 * @returns {{ claimedPurpose: string, badges: string[], techMentions: string[], hasCI: boolean }}
 */
function extractReadmePurpose(readmeContent) {
    const result = { claimedPurpose: '', badges: [], techMentions: [], hasCI: false };
    if (!readmeContent || typeof readmeContent !== 'string') return result;

    try {
        const lines = readmeContent.split('\n');

        // Extract claimedPurpose: first meaningful non-heading, non-badge, non-empty line
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('#')) continue;                    // heading
            if (trimmed.startsWith('![')) continue;                   // image/badge
            if (trimmed.startsWith('[![')) continue;                  // linked badge
            if (trimmed.startsWith('<')) continue;                    // HTML tag
            if (trimmed.startsWith('|')) continue;                    // table row
            if (trimmed.startsWith('```')) continue;                  // code fence
            if (/^\s*[-*]\s/.test(trimmed) && trimmed.length < 20) continue; // short bullet
            if (trimmed.length < 8) continue;                         // too short to be meaningful

            result.claimedPurpose = trimmed.substring(0, 250);
            break;
        }

        // Fallback: first 200 chars of content
        if (!result.claimedPurpose) {
            result.claimedPurpose = readmeContent.replace(/\s+/g, ' ').trim().substring(0, 200);
        }
    } catch (_) {}

    try {
        // Extract badges: [![alt](url)](link) pattern
        const badgeRe = /\[!\[([^\]]*)\]/g;
        let m;
        while ((m = badgeRe.exec(readmeContent)) !== null) {
            if (m[1] && m[1].trim()) result.badges.push(m[1].trim());
        }
    } catch (_) {}

    try {
        // Extract tech mentions (case-insensitive)
        const lower = readmeContent.toLowerCase();
        for (const term of TECH_TERMS) {
            // Use word-boundary style matching: surrounded by non-alphanumeric or start/end
            const re = new RegExp(`(?<![a-z0-9])${term.replace('.', '\\.')}(?![a-z0-9])`, 'i');
            if (re.test(lower)) result.techMentions.push(term);
        }
    } catch (_) {}

    try {
        // CI detection
        const lower = readmeContent.toLowerCase();
        result.hasCI = ['github actions', 'travis', 'circleci', 'jenkins', 'gitlab ci', 'drone', 'workflow.yml'].some(t => lower.includes(t));
    } catch (_) {}

    return result;
}

/**
 * Compare README claimed purpose vs actual code synthesis.
 * Pure static analysis — no LLM calls.
 *
 * @param {object} readmePurpose  - Output of extractReadmePurpose()
 * @param {object} synthesis      - { whatIsIt, techStack } from Phase 3
 * @param {object} codeMap        - { integrations, routeTree, domainEntities } from Phase 1
 * @returns {{ matchScore: number, discrepancies: string[], confidence: 'high'|'medium'|'low' }}
 */
function compareClaimVsReality(readmePurpose, synthesis, codeMap) {
    const result = { matchScore: 0.5, discrepancies: [], confidence: 'low' };

    try {
        const actualPackages   = (codeMap?.integrations || []).map(i => i.package.toLowerCase());
        const readmeTechLower  = (readmePurpose?.techMentions || []).map(t => t.toLowerCase());
        const readmeClaim      = (readmePurpose?.claimedPurpose || '').toLowerCase();
        const synthesisText    = (synthesis?.whatIsIt || '').toLowerCase();
        const synthTechStack   = (synthesis?.techStack || '').toLowerCase();
        let score = 0;

        // ── Score 1: Tech overlap (40% weight) ───────────────────────────────
        if (readmeTechLower.length > 0) {
            const overlap = readmeTechLower.filter(t =>
                actualPackages.some(p => p.includes(t) || t.includes(p)) ||
                synthTechStack.includes(t)
            );
            score += 0.40 * (overlap.length / readmeTechLower.length);
        } else {
            score += 0.20; // No tech mentions in README → neutral (not penalised)
        }

        // ── Score 2: Purpose keyword overlap (40% weight) ────────────────────
        const readmeWords = readmeClaim.split(/\W+/).filter(w => w.length > 4);
        if (readmeWords.length > 0) {
            const wordMatches = readmeWords.filter(w => synthesisText.includes(w));
            score += 0.40 * (wordMatches.length / readmeWords.length);
        } else {
            score += 0.20; // No words to compare → neutral
        }

        // ── Score 3: Shared domain terms (bonus, up to 20%) ──────────────────
        const combinedText = readmeClaim + ' ' + synthesisText;
        let domainBonus = 0;
        for (const term of DOMAIN_TERMS) {
            if (combinedText.includes(term)) domainBonus += 0.02;
        }
        score += Math.min(0.20, domainBonus);

        result.matchScore = parseFloat(Math.min(1.0, score).toFixed(3));

        // ── Discrepancy detection ─────────────────────────────────────────────

        // DB mismatch
        const readmeMentionsMongo  = readmeTechLower.some(t => ['mongodb', 'mongoose'].includes(t));
        const readmeMentionsSql    = readmeTechLower.some(t => ['postgresql', 'postgres', 'mysql', 'sqlite'].includes(t));
        const actualHasMongo       = actualPackages.some(p => ['mongoose', 'mongodb'].includes(p));
        const actualHasSql         = actualPackages.some(p => ['pg', 'mysql2', 'better-sqlite3', 'sequelize', 'prisma', 'knex', 'typeorm'].includes(p));
        if (readmeMentionsMongo && !actualHasMongo && actualHasSql) {
            result.discrepancies.push('README mentions MongoDB but code uses a SQL database');
        }
        if (readmeMentionsSql && !actualHasSql && actualHasMongo) {
            result.discrepancies.push('README mentions SQL database but code uses MongoDB');
        }

        // Frontend mismatch
        const readmeMentionsFrontend = readmeTechLower.some(t => ['react', 'vue', 'angular', 'svelte', 'nextjs', 'next.js'].includes(t));
        const actualHasFrontend      = actualPackages.some(p => ['react', 'vue', 'angular', '@angular/core', 'svelte', 'next'].includes(p));
        if (readmeMentionsFrontend && !actualHasFrontend && (codeMap?.routeTree || []).length > 5) {
            result.discrepancies.push('README mentions a frontend framework but no frontend dependencies detected in code');
        }

        // ML/AI mismatch
        const readmeMentionsML = /machine.learning|deep.learning|neural.network|\bml\b|\bai\b|pytorch|tensorflow/i.test(readmeClaim);
        const actualHasML      = actualPackages.some(p => ['torch', 'tensorflow', 'scikit-learn', 'openai', 'langchain', 'transformers', 'numpy', 'pandas'].includes(p));
        if (readmeMentionsML && !actualHasML) {
            result.discrepancies.push('README claims ML/AI capabilities but no ML dependencies detected in code');
        }

        // API mentioned but no routes
        const readmeMentionsApi = /\bapi\b/i.test(readmeClaim);
        const hasRoutes = (codeMap?.routeTree || []).length > 0;
        if (readmeMentionsApi && !hasRoutes) {
            result.discrepancies.push('README mentions an API but no HTTP routes were detected in code');
        }

        // README too thin
        if (!readmePurpose?.claimedPurpose || readmePurpose.claimedPurpose.length < 15) {
            result.discrepancies.push('README is too short or placeholder — unable to extract meaningful claimed purpose');
        }

        // ── Confidence ───────────────────────────────────────────────────────
        result.confidence = result.matchScore >= 0.60 ? 'high'
                          : result.matchScore >= 0.30 ? 'medium'
                          : 'low';

    } catch (_) {}

    return result;
}

module.exports = { extractReadmePurpose, compareClaimVsReality };

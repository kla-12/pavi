'use strict';

let pass = 0, fail = 0;
function assert(condition, msg) {
    if (condition) { console.log(`  ✅ ${msg}`); pass++; }
    else           { console.error(`  ❌ FAIL: ${msg}`); fail++; }
}

console.log('\n=== Synthesis Parser Tests ===\n');

// ── Helpers (copy-paste from ingester.js) ─────────────────────────────────────
const extractField = (text, label) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`);
    const m = text.match(re);
    return m ? m[1].trim().replace(/\n/g, ' ') : '';
};

const parseReviewerField = (text, label) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`);
    const m = text.match(re);
    return m ? m[1].trim() : '';
};

// ── Test 1: Synthesis parsing ─────────────────────────────────────────────────
const sampleSynthesis = `WHAT_IS_IT: A peer code review platform for development teams.
WHO_USES_IT: Development teams who want structured async code review on pull requests.
CORE_FLOW: User uploads repo → system assigns reviewers based on tags → reviewers comment on files → author gets notified → PR approved or rejected.
BEST_PATTERN: Repository pattern — all DB queries are abstracted behind a service layer, making the business logic independent of the storage engine and easily testable.
TECH_STACK: Frontend: React | Backend: Express | Database: SQLite | Queue: None | Auth: JWT`;

const s = {
    whatIsIt:    extractField(sampleSynthesis, 'WHAT_IS_IT'),
    whoUsesIt:   extractField(sampleSynthesis, 'WHO_USES_IT'),
    coreFlow:    extractField(sampleSynthesis, 'CORE_FLOW'),
    bestPattern: extractField(sampleSynthesis, 'BEST_PATTERN'),
    techStack:   extractField(sampleSynthesis, 'TECH_STACK'),
};

assert(s.whatIsIt.includes('peer code review'),     'WHAT_IS_IT extracted correctly');
assert(s.whoUsesIt.includes('Development teams'),   'WHO_USES_IT extracted correctly');
assert(s.coreFlow.includes('uploads repo'),         'CORE_FLOW extracted correctly');
assert(s.bestPattern.includes('Repository'),        'BEST_PATTERN extracted correctly');
assert(s.techStack.includes('Express'),             'TECH_STACK extracted correctly');
assert(!s.whatIsIt.includes('WHO_USES_IT'),         'WHAT_IS_IT not contaminated by next field');

// ── Test 2: Reviewer parsing ──────────────────────────────────────────────────
const sampleReview = `VERIFICATION: Analysis is accurate. The authentication flow description correctly identifies bcrypt and JWT usage.
ENRICHMENT: The analysis missed the rate limiting middleware applied to all /auth routes.
SUMMARY: RuView is a collaborative code review platform built with React, Express, and SQLite. Users upload repositories as zip files, which are assigned to reviewers based on their declared expertise tags. The core review flow consists of file-level comment threads with inline diffs. Authentication uses JWT tokens with a 24-hour expiry. The system uses a repository pattern throughout the service layer, making all database operations testable without a live database connection.
SKILLS:
- $jwt-auth-flow: Stateless JWT authentication with bcrypt password hashing and 24-hour token expiry pattern.
- $review-assignment: Expertise-tag-based reviewer assignment with round-robin fallback.
- $repository-pattern: Service layer that wraps all DB queries, decoupling business logic from storage engine.
VERDICT: GOOD — Feature analysis was thorough but missed the rate limiting middleware on auth routes.`;

const verification = parseReviewerField(sampleReview, 'VERIFICATION');
const enrichment   = parseReviewerField(sampleReview, 'ENRICHMENT');
const summary      = parseReviewerField(sampleReview, 'SUMMARY');
const skillsText   = parseReviewerField(sampleReview, 'SKILLS');
const verdictLine  = parseReviewerField(sampleReview, 'VERDICT');

const skills = skillsText
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => { const m = l.match(/\$([a-z0-9-]+):\s*(.+)/); return m ? { tag: `$${m[1]}`, description: m[2].trim() } : null; })
    .filter(Boolean);

const verdict = ['EXCELLENT', 'GOOD', 'PARTIAL', 'POOR'].find(v => verdictLine.startsWith(v)) || 'PARTIAL';

assert(verification.includes('accurate'),           'VERIFICATION extracted');
assert(enrichment.includes('rate limiting'),        'ENRICHMENT extracted');
assert(summary.length >= 100 && summary.length <= 300, `SUMMARY length (${summary.length} chars)`);
assert(summary.includes('RuView'),                  'SUMMARY content correct');
assert(skills.length === 3,                         'SKILLS: 3 extracted');
assert(skills[0].tag === '$jwt-auth-flow',          'First skill tag correct');
assert(skills[0].description.includes('bcrypt'),    'First skill description correct');
assert(verdict === 'GOOD',                          'VERDICT parsed as GOOD');
assert(!summary.includes('SKILLS:'),                'SUMMARY not contaminated by SKILLS section');

// ── Test 3: Graceful fallback on malformed input ──────────────────────────────
const malformed = 'Sorry, I cannot analyze this code.';
const mWhatIsIt = extractField(malformed, 'WHAT_IS_IT');
assert(mWhatIsIt === '',                            'Malformed input returns empty string (no crash)');
const mVerdict = ['EXCELLENT', 'GOOD', 'PARTIAL', 'POOR'].find(v => malformed.startsWith(v)) || 'PARTIAL';
assert(mVerdict === 'PARTIAL',                      'Malformed verdict defaults to PARTIAL');

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

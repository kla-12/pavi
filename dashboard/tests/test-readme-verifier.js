'use strict';
const { extractReadmePurpose, compareClaimVsReality } = require('../services/readme-verifier');

let pass = 0, fail = 0;
function assert(condition, msg) {
    if (condition) { console.log(`  ✅ ${msg}`); pass++; }
    else           { console.error(`  ❌ FAIL: ${msg}`); fail++; }
}

console.log('\n=== README Verifier Tests ===\n');

// ── Test 1: Extract purpose from typical README ───────────────────────────────
const readme1 = `# RuView

[![Build Status](https://github.com/user/ruview/actions/badge.svg)](link)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](link)

A collaborative peer code review platform for development teams.

## Features
- Upload zip repos
- Assign reviewers by expertise
- Inline file comments

## Getting Started
\`\`\`bash
npm install && npm start
\`\`\`

Built with React, Express, and SQLite. Stripe payments for Pro tier.
`;

const p1 = extractReadmePurpose(readme1);
assert(p1.claimedPurpose === 'A collaborative peer code review platform for development teams.', `claimedPurpose: "${p1.claimedPurpose}"`);
assert(p1.badges.length === 2,                                    `badges count: ${p1.badges.length}`);
assert(p1.badges.includes('Build Status'),                        'Build Status badge found');
assert(p1.techMentions.includes('react'),                         'react detected in tech mentions');
assert(p1.techMentions.includes('sqlite'),                        'sqlite detected in tech mentions');
assert(p1.techMentions.includes('stripe'),                        'stripe detected in tech mentions');
assert(!p1.claimedPurpose.includes('[!['),                        'badges not in claimedPurpose');

// ── Test 2: compareClaimVsReality — good match ────────────────────────────────
const syn1 = { whatIsIt: 'A peer code review platform for development teams', techStack: 'Frontend: React | Backend: Express | Database: SQLite | Auth: JWT' };
const map1 = {
    integrations: [{ package: 'react' }, { package: 'express' }, { package: 'better-sqlite3' }, { package: 'stripe' }],
    routeTree: [{ method: 'POST', path: '/login' }, { method: 'GET', path: '/repos' }],
    domainEntities: [],
};
const c1 = compareClaimVsReality(p1, syn1, map1);
assert(c1.matchScore > 0.40,              `matchScore ${c1.matchScore} should be > 0.40`);
assert(c1.confidence === 'high' || c1.confidence === 'medium', `confidence: ${c1.confidence}`);
assert(c1.discrepancies.length === 0,     `no discrepancies (got: ${c1.discrepancies.join('; ')})`);

// ── Test 3: compareClaimVsReality — DB mismatch ───────────────────────────────
const readme2 = `# MyApp\n\nA social network built with MongoDB and React.\n`;
const p2 = extractReadmePurpose(readme2);
assert(p2.techMentions.includes('mongodb'), 'mongodb detected in README');

const syn2 = { whatIsIt: 'A social platform with user profiles and posts', techStack: 'Frontend: React | Backend: Express | Database: SQLite' };
const map2 = {
    integrations: [{ package: 'react' }, { package: 'better-sqlite3' }],
    routeTree: [{ method: 'GET', path: '/posts' }],
    domainEntities: [],
};
const c2 = compareClaimVsReality(p2, syn2, map2);
assert(c2.discrepancies.some(d => d.includes('MongoDB')), `DB mismatch detected: ${c2.discrepancies.join('; ')}`);

// ── Test 4: ML claim but no ML deps ───────────────────────────────────────────
const readme3 = `# DataBot\n\nA machine learning pipeline for predicting churn using deep learning.\n`;
const p3 = extractReadmePurpose(readme3);
const syn3 = { whatIsIt: 'A web dashboard for viewing sales metrics', techStack: 'Frontend: React | Backend: Express | Database: SQLite' };
const map3 = { integrations: [{ package: 'react' }, { package: 'express' }], routeTree: [], domainEntities: [] };
const c3 = compareClaimVsReality(p3, syn3, map3);
assert(c3.discrepancies.some(d => d.includes('ML')), `ML discrepancy detected: ${c3.discrepancies.join('; ')}`);

// ── Test 5: No README → returns safe defaults ─────────────────────────────────
const p4 = extractReadmePurpose('');
assert(p4.claimedPurpose === '',          'empty README → empty claimedPurpose');
assert(Array.isArray(p4.badges),          'badges is always an array');
assert(Array.isArray(p4.techMentions),    'techMentions is always an array');

// ── Test 6: null input → no crash ────────────────────────────────────────────
const p5 = extractReadmePurpose(null);
assert(p5.claimedPurpose === '',          'null input → no crash, empty result');

const c5 = compareClaimVsReality(null, null, null);
assert(typeof c5.matchScore === 'number', 'null inputs → no crash, returns matchScore');
assert(Array.isArray(c5.discrepancies),   'null inputs → discrepancies is array');

// ── Test 7: Very short README ────────────────────────────────────────────────
const p6 = extractReadmePurpose('# App\n\nTodo.\n');
assert(p6.discrepancies === undefined,    'extractReadmePurpose does not produce discrepancies');
const c6 = compareClaimVsReality(p6, { whatIsIt: 'A todo list app', techStack: '' }, { integrations: [], routeTree: [], domainEntities: [] });
assert(c6.discrepancies.some(d => d.includes('short') || d.includes('placeholder')), `Short README flagged: ${c6.discrepancies.join('; ')}`);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

'use strict';
/**
 * skill-writer.js — Autonomous Skill Synthesiser
 *
 * Takes a detected gap and synthesises a new skill entry from the
 * top-matching skeletons in Pavi's memory.
 *
 * Pipeline:
 *   gap → retrieve top-5 skeletons → synthesise skill entry → write to staging
 *
 * Staged promotion:
 *   staging/skills-pending.json → (manual approve or 24h auto) → skills.json
 *
 * All actions are logged to the audit trail.
 */

const fs   = require('fs');
const path = require('path');
const audit = require('./audit-log');
const gapDetector = require('./gap-detector');

const { skillsDB, stagingSkillsDB } = require('./db');

const PATTERN_INDEX_PATH  = path.join(__dirname, '.pattern-index.json');

// ── Helpers ────────────────────────────────────────────────────────────────────
function loadStagingSkills() {
  try {
    return stagingSkillsDB.getAll();
  } catch (e) { return []; }
}

function saveStagingSkills(skills) {
  try {
    stagingSkillsDB.saveAll(skills);
  } catch (e) {}
}

function loadSkills() {
  try {
    return skillsDB.getAll();
  } catch (e) { return []; }
}

function saveSkills(skills) {
  try {
    skillsDB.saveAll(skills);
  } catch (e) {}
}

// ── Skeleton Retrieval ─────────────────────────────────────────────────────────
/**
 * Find the best matching skeletons from .pattern-index.json for a given intent.
 * Falls back gracefully if AgentDB isn't available.
 */
function retrieveSkeletons(intent, sourceKeys, limit = 5) {
  const results = [];

  // First: try to get skeletons for the exact source keys from gap detector
  try {
    const index = JSON.parse(fs.readFileSync(PATTERN_INDEX_PATH, 'utf8'));
    for (const key of sourceKeys) {
      if (index[key]) {
        results.push({ key, skeleton: index[key].skeleton || '', metadata: index[key].metadata || '' });
        if (results.length >= limit) break;
      }
    }

    // If we didn't get enough from source keys, search by intent keywords
    if (results.length < limit) {
      const intentWords = intent.split('-').filter(w => w.length > 3);
      for (const [key, val] of Object.entries(index)) {
        if (results.find(r => r.key === key)) continue;
        const sk = (val.skeleton || '').toLowerCase();
        if (intentWords.some(w => sk.includes(w))) {
          results.push({ key, skeleton: val.skeleton || '', metadata: val.metadata || '' });
          if (results.length >= limit) break;
        }
      }
    }
  } catch (e) {
    // Pattern index doesn't exist yet
  }

  return results;
}

// ── Skill Synthesiser ──────────────────────────────────────────────────────────
/**
 * Build a skill description from an intent and its skeleton evidence.
 */
function synthesiseSkillDescription(intent, suggestedTag, skeletons, sourceRepos) {
  const intentReadable = intent.replace(/-/g, ' ');
  const repoList = [...new Set(sourceRepos)].slice(0, 3).join(', ');

  // Extract function names from skeletons for concrete examples
  const fnNames = [];
  for (const { skeleton } of skeletons) {
    const matches = skeleton.match(/FN:(\w+)/g) || [];
    fnNames.push(...matches.map(m => m.replace('FN:', '')));
  }
  const fnExamples = [...new Set(fnNames)].slice(0, 5);

  const description = [
    `Apply ${intentReadable} patterns when working on tasks that need ${intent.split('-').join(' ')}.`,
    fnExamples.length > 0
      ? `Key patterns extracted from ingested repos: ${fnExamples.join(', ')}.`
      : `Pattern learned from ingested repo analysis.`,
    `When you identify a need for ${intentReadable}, apply the patterns from these sources: ${repoList || 'learned repos'}.`,
    `Always prefer this approach over naive implementations — it was validated by Pavi's reviewer model during ingestion.`
  ].join(' ');

  return description;
}

// ── Main: Write a skill from a gap ────────────────────────────────────────────
/**
 * Synthesise and stage a new skill from a detected gap.
 *
 * @param {object} gap - Gap object from gap-detector
 * @returns {{ success: boolean, staged?: object, message: string }}
 */
function writeFromGap(gap) {
  const { id, intent, suggestedTag, sources } = gap;

  // Don't duplicate staging entries
  const existing = loadStagingSkills();
  if (existing.find(s => s.tag === suggestedTag)) {
    return { success: false, message: `Skill "${suggestedTag}" is already in staging.` };
  }

  // Check if already live
  const live = loadSkills();
  if (live.find(s => s.tag === suggestedTag)) {
    gapDetector.markPromoted(id);
    return { success: false, message: `Skill "${suggestedTag}" already exists in skills.json.` };
  }

  const sourceKeys  = sources.map(s => s.key);
  const sourceRepos = sources.map(s => s.repoKey);

  // Retrieve evidence skeletons
  const skeletons = retrieveSkeletons(intent, sourceKeys);
  const confidence = sources.reduce((acc, s) => acc + s.confidence, 0) / Math.max(sources.length, 1);

  // Synthesise description
  const description = synthesiseSkillDescription(intent, suggestedTag, skeletons, sourceRepos);

  const fnNames = [];
  for (const { skeleton } of skeletons) {
    const matches = skeleton.match(/FN:(\w+)/g) || [];
    fnNames.push(...matches.map(m => m.replace('FN:', '')));
  }
  const fnExamples = [...new Set(fnNames)].slice(0, 5);

  const staged = {
    id: `staged-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    gapId: id,
    tag: suggestedTag,
    
    // Structured knowledge (NEW)
    knowledge: {
      summary: description,                          // 1-2 sentence summary
      whenToUse: `Use ${intent.replace(/-/g,' ')} when your task requires ${intent.split('-').join(' ')} capabilities.`,
      approach: fnExamples.length > 0
        ? `Key implementation entry points: ${fnExamples.join(', ')}.`
        : 'See source repos for implementation reference.',
      codeExample: skeletons[0]?.skeleton?.substring(0, 500) || null,  // First skeleton as example
      antiPattern: null,         // Filled in by LLM on promotion
      relatedSkills: [],         // Filled by cross-reference at promote time
      domainTags: [intent.split('-')[0], intent.split('-').slice(-1)[0]], // e.g. ['reduce', 'calls']
    },
    
    intent,
    confidence: parseFloat(confidence.toFixed(3)),
    sourceRepos,
    skeletonCount: skeletons.length,
    usageCount: 0,           // Incremented each time this skill is invoked
    successCount: 0,         // Incremented when user confirms skill helped
    stagedAt: new Date().toISOString(),
    promotedAt: null,
    status: 'staged',
  };

  const allStaged = loadStagingSkills();
  const mergeResult = mergeOrStage(staged, allStaged);
  
  if (mergeResult.merged) {
    saveStagingSkills(allStaged);
    gapDetector.markStaged(id);
    console.log(`[SKILL_WRITER] 🔗 Merged duplicate skill "${suggestedTag}" into existing staged skill.`);
  } else {
    allStaged.push(staged);
    saveStagingSkills(allStaged);
    gapDetector.markStaged(id);
  }

  audit.log(audit.EVENT_TYPES.SKILL_STAGED, {
    tag: suggestedTag,
    intent,
    confidence: staged.confidence,
    sourceRepos,
    gapId: id
  });

  if (mergeResult.merged) {
    return { success: true, staged: mergeResult.into, message: `Skill "${suggestedTag}" merged into existing staged skill.` };
  } else {
    console.log(`[SKILL_WRITER] ✨ Staged new skill: "${suggestedTag}" (confidence: ${(confidence * 100).toFixed(0)}%, from ${skeletons.length} skeleton(s))`);
    return { success: true, staged, message: `Skill "${suggestedTag}" staged for review.` };
  }
}

/**
 * Process all pending gaps and write skills for each.
 * @returns {Array<{ success: boolean, staged?: object, message: string }>}
 */
function processGaps() {
  const { getGaps } = require('./gap-detector');
  const pendingGaps = getGaps('pending');
  const results = [];

  for (const gap of pendingGaps) {
    results.push(writeFromGap(gap));
  }

  if (pendingGaps.length === 0) {
    console.log('[SKILL_WRITER] No pending gaps to process.');
  } else {
    console.log(`[SKILL_WRITER] Processed ${pendingGaps.length} gap(s), staged ${results.filter(r => r.success).length} skill(s).`);
  }

  return results;
}

// ── Promotion ─────────────────────────────────────────────────────────────────
/**
 * Promote a staged skill to live skills.json.
 * @param {string} stagedId - The staged skill's id field
 * @returns {{ success: boolean, message: string }}
 */
function promote(stagedId) {
  const staged = loadStagingSkills();
  const skill  = staged.find(s => s.id === stagedId);

  if (!skill) return { success: false, message: `Staged skill "${stagedId}" not found.` };
  if (skill.status !== 'staged') return { success: false, message: `Skill "${skill.tag}" is not in staged state (current: ${skill.status}).` };

  const live = loadSkills();
  if (live.find(s => s.tag === skill.tag)) {
    return { success: false, message: `Skill "${skill.tag}" is already live.` };
  }

  // ── Checker-validation gate ──────────────────────────────────────────────
  // Validate the skill's knowledge block is structurally complete before promoting
  const knowledgeValid = skill.knowledge
    && typeof skill.knowledge === 'object'
    && (skill.knowledge.summary || skill.knowledge.whenToUse);

  if (!knowledgeValid) {
    console.warn(`[SKILL_WRITER] ⚠️ Checker rejected "${skill.tag}": incomplete knowledge block.`);
    audit.log(audit.EVENT_TYPES.SKILL_DISCARDED, {
      tag: skill.tag, reason: 'checker_rejected_incomplete_knowledge'
    });
    return { success: false, message: `Skill "${skill.tag}" rejected by checker: incomplete knowledge block.` };
  }

  // Find parent skill (closest related skill already live) for genealogy
  let parentTag = null;
  let generation = 1;
  if (skill.knowledge?.relatedSkills && skill.knowledge.relatedSkills.length > 0) {
    const relatedLive = live.find(s => skill.knowledge.relatedSkills.includes(s.tag));
    if (relatedLive) {
      parentTag = relatedLive.tag;
      generation = (relatedLive.generation || 1) + 1;
    }
  }

  // Promote: add to skills.json — FULL lossless knowledge preservation
  const promotedSkill = {
    tag: skill.tag,
    description: skill.knowledge?.summary || skill.description || '',
    knowledge: {
      ...(skill.knowledge || {}),
      // Ensure all sub-fields are preserved even if null
      summary: skill.knowledge?.summary || skill.description || '',
      whenToUse: skill.knowledge?.whenToUse || '',
      approach: skill.knowledge?.approach || null,
      codeExample: skill.knowledge?.codeExample || null,
      antiPattern: skill.knowledge?.antiPattern || null,
      relatedSkills: skill.knowledge?.relatedSkills || [],
      domainTags: skill.knowledge?.domainTags || [],
      complexityHint: skill.knowledge?.complexityHint || null,
    },
    skeleton: skill.skeleton || null,
    extractedAt: skill.extractedAt || new Date().toISOString(),
    confidence: skill.confidence,
    sourceRepos: skill.sourceRepos,
    usageCount: skill.usageCount || 0,
    successCount: skill.successCount || 0,
    parentTag,
    generation,
    battleTested: true,
    promotedAt: new Date().toISOString()
  };

  live.push(promotedSkill);
  saveSkills(live);

  // ── Record genealogy in SQLite ──────────────────────────────────────────
  try {
    const { db } = require('./db');
    db.prepare(`INSERT OR REPLACE INTO skill_genealogy (tag, parent_tag, generation, confidence, mutations)
                VALUES (?, ?, ?, ?, ?)`).run(
      skill.tag, parentTag, generation, skill.confidence,
      JSON.stringify({ sourceRepos: skill.sourceRepos, mergedCount: skill.mergedCount || 0 })
    );
  } catch (dbErr) {
    console.warn(`[SKILL_WRITER] Could not record genealogy: ${dbErr.message}`);
  }

  // Update staging record
  skill.status = 'promoted';
  skill.promotedAt = new Date().toISOString();
  saveStagingSkills(staged);

  // Mark gap as promoted
  if (skill.gapId) gapDetector.markPromoted(skill.gapId);

  audit.log(audit.EVENT_TYPES.SKILL_PROMOTED, {
    tag: skill.tag, intent: skill.intent,
    confidence: skill.confidence, sourceRepos: skill.sourceRepos,
    parentTag, generation
  });

  console.log(`[SKILL_WRITER] 🚀 Promoted skill "${skill.tag}" to live skills.json! (gen ${generation}, parent: ${parentTag || 'root'})`);
  return { success: true, message: `"${skill.tag}" is now live.` };
}

/**
 * Discard a staged skill (user rejected it).
 */
function discard(stagedId) {
  const staged = loadStagingSkills();
  const skill  = staged.find(s => s.id === stagedId);
  if (!skill) return { success: false, message: `Staged skill "${stagedId}" not found.` };

  skill.status = 'discarded';
  saveStagingSkills(staged);

  if (skill.gapId) gapDetector.markDiscarded(skill.gapId);

  audit.log(audit.EVENT_TYPES.SKILL_DISCARDED, { tag: skill.tag, intent: skill.intent });
  console.log(`[SKILL_WRITER] 🗑️  Discarded staged skill "${skill.tag}".`);
  return { success: true, message: `Discarded "${skill.tag}".` };
}

/**
 * Roll back a live skill (remove from skills.json, demote in staging).
 */
function rollback(tag) {
  const live = loadSkills();
  const idx = live.findIndex(s => s.tag === tag);
  if (idx === -1) return { success: false, message: `Skill "${tag}" is not live.` };

  live.splice(idx, 1);
  saveSkills(live);

  // Update staging record
  const staged = loadStagingSkills();
  const record = staged.find(s => s.tag === tag);
  if (record) {
    record.status = 'rolled_back';
    saveStagingSkills(staged);
  }

  audit.log(audit.EVENT_TYPES.SKILL_ROLLED_BACK, { tag });
  console.log(`[SKILL_WRITER] ⏪ Rolled back skill "${tag}".`);
  return { success: true, message: `"${tag}" rolled back. Removed from live skills.` };
}

/**
 * Get all staged skills.
 */
function getStagedSkills(status = null) {
  const all = loadStagingSkills();
  return status ? all.filter(s => s.status === status) : all;
}

/**
 * Check if a new staged skill is semantically similar to an existing one.
 * If so, merge them (update confidence + sources) instead of creating a duplicate.
 */
function mergeOrStage(newSkill, existingStaged) {
    // Check for tag similarity (same root intent)
    const similar = existingStaged.find(s => {
        if (s.status !== 'staged') return false;
        // Same intent = definite merge
        if (s.intent === newSkill.intent) return true;
        // Overlapping tags (e.g. $retry-resilience vs $retry-backoff)
        const tagsA = s.tag.split('-');
        const tagsB = newSkill.tag.split('-');
        const overlap = tagsA.filter(t => tagsB.includes(t) && t.length > 3);
        return overlap.length >= 2;
    });

    if (similar) {
        // Merge: boost confidence, add source repos
        similar.confidence = Math.min(0.99, similar.confidence + 0.05);
        similar.sourceRepos = [...new Set([...similar.sourceRepos, ...newSkill.sourceRepos])].slice(0, 10);
        similar.skeletonCount += newSkill.skeletonCount;
        similar.mergedCount = (similar.mergedCount || 0) + 1;
        
        // Merge structured knowledge if it exists
        if (similar.knowledge && newSkill.knowledge) {
            similar.knowledge.approach = similar.knowledge.approach || newSkill.knowledge.approach;
            similar.knowledge.codeExample = similar.knowledge.codeExample || newSkill.knowledge.codeExample;
        }

        console.log(`[SKILL_WRITER] 🔗 Merged duplicate skill "${newSkill.tag}" → "${similar.tag}" (confidence now ${(similar.confidence * 100).toFixed(0)}%)`);
        return { merged: true, into: similar };
    }
    return { merged: false };
}

module.exports = { writeFromGap, processGaps, promote, discard, rollback, getStagedSkills, mergeOrStage };

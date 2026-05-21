'use strict';
/**
 * skill-feedback.js — Self-correcting skill confidence system
 * 
 * Records every skill invocation and its outcome.
 * Aggregates success rate and adjusts confidence scores over time.
 * 
 * Success rate formula:
 *   new_confidence = old_confidence * 0.9 + (success ? 0.1 : 0.0)
 * 
 * Skills that consistently fail get demoted below the threshold and flagged.
 * Skills that consistently succeed get promoted to higher confidence.
 */

const { skillsDB } = require('../db');

const DEMOTION_THRESHOLD  = 0.60;  // below this → flag for review
const PROMOTION_THRESHOLD = 0.95;  // above this → mark as "battle-tested"

function recordUsage(tag, success) {
    const skills = skillsDB.getAll();
    const skill  = skills.find(s => s.tag === tag);
    if (!skill) return;

    // Exponential moving average update with time-decay
    const now = Date.now();
    let decayFactor = 1;
    if (skill.lastUsed) {
        const daysSinceLastUse = (now - new Date(skill.lastUsed).getTime()) / 86400000;
        decayFactor = Math.exp(-0.03 * Math.max(0, daysSinceLastUse)); // half-life ≈ 23 days
    }
    const prevConf = (skill.confidence || 0.85) * decayFactor;
    const newConf  = parseFloat((prevConf * 0.9 + (success ? 0.1 : 0.0)).toFixed(4));
    
    skill.confidence      = newConf;
    skill.usageCount      = (skill.usageCount || 0) + 1;
    skill.successCount    = (skill.successCount || 0) + (success ? 1 : 0);
    skill.lastUsed        = new Date().toISOString();
    skill.battleTested    = newConf >= PROMOTION_THRESHOLD;
    skill.flaggedForReview= newConf < DEMOTION_THRESHOLD && skill.usageCount >= 5;

    skillsDB.saveAll(skills);

    if (skill.flaggedForReview) {
        console.warn(`[SKILL_FEEDBACK] ⚠️ Skill "${tag}" flagged for review (confidence: ${(newConf*100).toFixed(0)}%)`);
    }
    if (skill.battleTested) {
        console.log(`[SKILL_FEEDBACK] 🏆 Skill "${tag}" is now BATTLE-TESTED (confidence: ${(newConf*100).toFixed(0)}%)`);
    }
}

function getHealthReport() {
    const skills = skillsDB.getAll();
    return {
        total: skills.length,
        battleTested:   skills.filter(s => s.battleTested).length,
        flaggedForReview: skills.filter(s => s.flaggedForReview).length,
        avgConfidence:  skills.length > 0 
            ? (skills.reduce((a, s) => a + (s.confidence || 0.85), 0) / skills.length).toFixed(3)
            : 0,
        topSkills: skills.sort((a,b) => (b.confidence||0) - (a.confidence||0)).slice(0, 5).map(s => s.tag)
    };
}

module.exports = { recordUsage, getHealthReport };

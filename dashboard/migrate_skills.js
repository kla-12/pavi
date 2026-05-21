const fs = require('fs');
const path = require('path');
const memory = require('./memory');

async function migrate() {
    console.log(`[MIGRATION] Starting migration of skills.json to AgentDB...`);
    const skillsPath = path.join(__dirname, 'skills.json');
    
    if (!fs.existsSync(skillsPath)) {
        console.error(`[MIGRATION] skills.json not found.`);
        return;
    }

    const skills = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
    
    for (const skill of skills) {
        console.log(`[MIGRATION] Storing skill: ${skill.tag}`);
        await memory.storeSkill(skill.tag, skill.description);
    }
    
    console.log(`[MIGRATION] Migration complete. All skills are now vectorized!`);
}

function verifySync() {
    const skillsPath = path.join(__dirname, 'skills.json');
    const botsPath = path.join(__dirname, 'bots.json');

    let flatSkillsCount = 0;
    let flatBotsCount = 0;
    try {
        if (fs.existsSync(skillsPath)) {
            flatSkillsCount = JSON.parse(fs.readFileSync(skillsPath, 'utf8')).length;
        }
    } catch (e) {
        console.error('[SYNC-CHECK] Error reading flat skills:', e.message);
    }
    try {
        if (fs.existsSync(botsPath)) {
            flatBotsCount = JSON.parse(fs.readFileSync(botsPath, 'utf8')).length;
        }
    } catch (e) {
        console.error('[SYNC-CHECK] Error reading flat bots:', e.message);
    }

    const { skillsDB, botsDB } = require('./db');
    let dbSkillsCount = 0;
    let dbBotsCount = 0;
    try {
        dbSkillsCount = skillsDB.getAll().length;
    } catch (e) {
        console.error('[SYNC-CHECK] Error reading SQLite skills:', e.message);
    }
    try {
        dbBotsCount = botsDB.getAll().length;
    } catch (e) {
        console.error('[SYNC-CHECK] Error reading SQLite bots:', e.message);
    }

    const inSync = (flatSkillsCount === dbSkillsCount) && (flatBotsCount === dbBotsCount);
    return {
        inSync,
        flat: { skills: flatSkillsCount, bots: flatBotsCount },
        sqlite: { skills: dbSkillsCount, bots: dbBotsCount }
    };
}

if (require.main === module) {
    (async () => {
        await migrate();
        console.log('[MIGRATION] Post-migration sync status:', verifySync());
    })();
}

module.exports = { migrate, verifySync };

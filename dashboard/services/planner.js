const patternMemory = require('../pattern-memory');
const logger = require('../utils/logger');

async function generatePlan(issuePayload) {
    const issueTitle = issuePayload.issue.title;
    const issueBody = issuePayload.issue.body;
    
    let context = '';
    try {
        if (patternMemory && patternMemory.recall) {
            const recalls = await patternMemory.recall(`${issueTitle} ${issueBody}`, 3);
            if (recalls && recalls.length > 0) {
                context = recalls.map(r => r.content).join('\n---\n');
            }
        }
    } catch (e) {
        logger.warn('[Planner] Pattern memory recall failed:', e.message);
    }

    const systemPrompt = `You are an expert software architect AI. 
Analyze the GitHub issue provided and generate a technical execution plan for the swarm orchestrator.
You must output ONLY valid JSON. Do not include markdown formatting or conversational text.

The JSON schema must be:
{
  "objective": "A concise, one-sentence objective",
  "filesContext": ["file1.js", "file2.js"],
  "tasks": ["step 1", "step 2"],
  "agentsRequired": ["coder", "tester", "reviewer"],
  "testCommand": "npm test"
}`;

    const userPrompt = `Context from past learnings:\n${context}\n\nIssue Title: ${issueTitle}\nIssue Body:\n${issueBody}`;

    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434/v1/chat/completions';
    const defaultModel = process.env.DEFAULT_MODEL || 'phi3:mini';

    try {
        const response = await fetch(ollamaUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: defaultModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.2
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama returned status ${response.status}`);
        }

        const data = await response.json();
        let content = data.choices[0].message.content;

        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const plan = JSON.parse(content);
        
        const requiredKeys = ['objective', 'filesContext', 'tasks', 'agentsRequired', 'testCommand'];
        for (const key of requiredKeys) {
            if (!plan[key] && !Array.isArray(plan[key])) {
                if (key === 'objective' || key === 'testCommand') {
                    plan[key] = '';
                } else {
                    plan[key] = [];
                }
            }
        }
        if (!plan.objective) plan.objective = `Resolve issue ${issuePayload.issue.number}`;
        if (!plan.testCommand) plan.testCommand = "npm test";

        return plan;
    } catch (e) {
        logger.error('[Planner] Failed to generate plan:', e.message);
        return {
            objective: `Resolve issue ${issuePayload.issue.number}`,
            filesContext: [],
            tasks: [`Analyze and fix issue ${issuePayload.issue.number}`],
            agentsRequired: ["researcher", "coder", "tester"],
            testCommand: "npm test",
            _fallback: true
        };
    }
}

module.exports = { generatePlan };

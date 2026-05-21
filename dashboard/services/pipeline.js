const planner = require('./planner');
const prPublisher = require('./pr-publisher');
const { spawnSwarm } = require('../swarm-orchestrator');
const socketSingleton = require('./socket-singleton');
const logger = require('../utils/logger');
const path = require('path');
const { exec } = require('child_process');

async function processJob(job) {
    const io = socketSingleton.getIO();
    const issuePayload = JSON.parse(job.payload);
    const issueNumber = job.issue_number;

    try {
        if (io) {
            io.emit('phase_d:status', { jobId: job.id, issueNumber, status: 'planning', message: 'Generating execution plan...' });
        }
        
        // 1. Planning
        const plan = await planner.generatePlan(issuePayload);
        logger.info(`[Pipeline] Generated plan for issue #${issueNumber}`);
        if (io) io.emit('phase_d:plan_ready', { jobId: job.id, issueNumber, plan });

        // 2. Swarm Execution
        const runId = `swarm_${Date.now()}`;
        if (io) io.emit('phase_d:status', { jobId: job.id, issueNumber, status: 'swarm_running', message: 'Executing swarm...' });
        const swarmResult = await spawnSwarm(plan, { runId, maxAgents: plan.agentsRequired?.length || 5, strategy: 'development' });
        logger.info(`[Pipeline] Swarm execution complete for issue #${issueNumber}`);

        // 3. Run Tests
        if (io) io.emit('phase_d:status', { jobId: job.id, issueNumber, status: 'testing', message: 'Running tests...' });
        let testPassed = true;
        let testOutput = '';

        if (plan.testCommand) {
            try {
                testOutput = await runTests(plan.testCommand);
            } catch (err) {
                testPassed = false;
                testOutput = err.message || 'Test suite failed.';
            }
        }

        if (!testPassed) {
            logger.warn(`[Pipeline] Tests failed for issue #${issueNumber}`);
            if (io) io.emit('phase_d:failed', { jobId: job.id, issueNumber, reason: 'test_failed', details: testOutput });
            throw new Error(`Tests failed: ${testOutput}`);
        }
        logger.info(`[Pipeline] Tests passed for issue #${issueNumber}`);

        // 4. PR Publishing
        if (io) io.emit('phase_d:status', { jobId: job.id, issueNumber, status: 'publishing', message: 'Creating Pull Request...' });
        
        const prData = await prPublisher.publishPR(issuePayload, plan, swarmResult);

        // Update the database to link swarm run to PR
        try {
            const { db } = require('../db');
            db.prepare('UPDATE swarm_runs SET pr_url = ?, pr_number = ?, issue_number = ? WHERE id = ?')
              .run(prData.url, prData.number, issueNumber, runId);
        } catch (dbErr) {
            logger.warn(`[Pipeline] Failed to link PR info to swarm run ${runId}:`, dbErr.message);
        }
        
        if (io) io.emit('phase_d:completed', { jobId: job.id, issueNumber, prUrl: prData.url, prNumber: prData.number });
        logger.info(`[Pipeline] Successfully completed CI/CD for issue #${issueNumber}. PR: ${prData.url}`);
        
        try {
            const pushNotifications = require('./push-notifications');
            pushNotifications.broadcastNotification({
                title: 'CI/CD Complete',
                body: `PR #${prData.number} successfully created for issue #${issueNumber}!`,
                url: prData.url,
                tag: 'cicd-complete'
            });
        } catch (pushErr) {
            logger.warn(`[Pipeline] Push notification failed:`, pushErr.message);
        }

        return prData;
    } catch (e) {
        logger.error(`[Pipeline] Job ${job.id} failed:`, e.message);
        if (io) io.emit('phase_d:failed', { jobId: job.id, issueNumber, reason: 'error', details: e.message });
        throw e;
    }
}

function runTests(testCommand) {
    return new Promise((resolve, reject) => {
        const paviProjectRoot = path.join(__dirname, '../..');
        exec(testCommand, { cwd: paviProjectRoot }, (error, stdout, stderr) => {
            const output = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (error) {
                reject(new Error(output));
            } else {
                resolve(output);
            }
        });
    });
}

module.exports = {
    processJob,
    runTests
};

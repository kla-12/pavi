process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';
process.env.GITHUB_TOKEN = 'test-github-token-12345';

// Mock swarm-orchestrator to avoid actually running swarms, but record run in database
jest.mock('../../swarm-orchestrator', () => {
    return {
        spawnSwarm: jest.fn().mockImplementation(async (objective, opts = {}) => {
            const runId = opts.runId || 'swarm-mock-id';
            const { swarmRunsDB } = require('../../db');
            
            let objectiveStr = '';
            if (typeof objective === 'string') {
                objectiveStr = objective;
            } else if (objective && objective.objective) {
                objectiveStr = objective.objective;
            } else {
                objectiveStr = JSON.stringify(objective);
            }
            
            swarmRunsDB.create(runId, objectiveStr, ['coder']);
            return {
                runId,
                output: 'Success! Fixed the bug by updating index.html.',
                bots: [{ role: 'coder', model: 'mock-model' }]
            };
        })
    };
});

// Mock planner to bypass fetching from local Ollama endpoint during tests
jest.mock('../../services/planner', () => {
    return {
        generatePlan: jest.fn().mockResolvedValue({
            objective: 'Fix auth session check',
            filesContext: ['index.html'],
            tasks: ['Fix the bug'],
            agentsRequired: ['coder'],
            testCommand: 'echo "mock tests passed"'
        })
    };
});

// Mock pr-publisher to bypass Octokit GitHub API calls during tests
jest.mock('../../services/pr-publisher', () => {
    return {
        publishPR: jest.fn().mockResolvedValue({
            url: 'https://github.com/test-owner/test-repo/pull/42',
            number: 42,
            branch: 'pavi/issue-103-mock'
        })
    };
});

const request = require('supertest');
const app = require('../../server');
const { db, swarmRunsDB, phaseDJobsDB } = require('../../db');
const jobQueue = require('../../services/job-queue');
const pipelineService = require('../../services/pipeline');

describe('Phase D: CI/CD Pipeline & GitHub Integration Tests', () => {
    beforeEach(() => {
        // Clear tables
        db.prepare('DELETE FROM swarm_runs').run();
        db.prepare('DELETE FROM phase_d_jobs').run();
        // Reset queue state
        jobQueue.isProcessing = false;
    });

    it('should ignore webhook payloads that do not have pavi:auto or pavi-agentic-fix label', async () => {
        const payload = {
            action: 'labeled',
            issue: {
                number: 101,
                title: 'Crash in database helper',
                body: 'The app crashes when calling DB helper',
                labels: [{ name: 'bug' }]
            },
            repository: {
                full_name: 'test-owner/test-repo',
                clone_url: 'https://github.com/test-owner/test-repo.git'
            }
        };

        const res = await request(app)
            .post('/webhooks')
            .set('x-github-event', 'issues')
            .send(payload);

        expect(res.statusCode).toEqual(200);
        expect(res.body.skipped).toBe(true);
        expect(res.body.reason).toMatch(/no pavi:auto/i);
        
        // Should not have queued any jobs in db
        const nextJob = phaseDJobsDB.getNextPending();
        expect(nextJob).toBeUndefined();
    });

    it('should queue a job when issue is labeled with pavi:auto', async () => {
        const payload = {
            action: 'labeled',
            issue: {
                number: 102,
                title: 'Add status column to table',
                body: 'We need a new column for status',
                labels: [{ name: 'pavi:auto' }]
            },
            repository: {
                full_name: 'test-owner/test-repo',
                clone_url: 'https://github.com/test-owner/test-repo.git'
            }
        };

        const res = await request(app)
            .post('/webhooks')
            .set('x-github-event', 'issues')
            .send(payload);

        expect(res.statusCode).toEqual(200);
        expect(res.body.queued).toBe(true);
        expect(res.body.jobId).toBeDefined();

        const nextJob = phaseDJobsDB.getById(res.body.jobId);
        expect(nextJob).toBeDefined();
        expect(nextJob.issue_number).toEqual(102);
        // Status may start processing immediately if isProcessing was false, so expect 'processing'
        expect(nextJob.status).toEqual('processing');
    });

    it('should run pipeline execution and publish a pull request when job is processed', async () => {
        const issuePayload = {
            issue: {
                number: 103,
                title: 'Fix auth session check',
                body: 'Session check bypasses signature verification'
            },
            repository: {
                fullName: 'test-owner/test-repo',
                cloneUrl: 'https://github.com/test-owner/test-repo.git'
            }
        };

        const result = jobQueue.enqueue(103, issuePayload);
        expect(result.queued).toBe(true);

        const nextJob = phaseDJobsDB.getById(result.jobId);
        expect(nextJob).toBeDefined();

        // Process the job directly
        await pipelineService.processJob(nextJob);

        // Check if run was logged to the swarm runs database
        const runs = swarmRunsDB.getAll();
        expect(runs.length).toBeGreaterThanOrEqual(1);
        expect(runs[0].prompt).toContain('Fix auth session check');
        expect(runs[0].pr_number).toEqual(42);
        expect(runs[0].pr_url).toEqual('https://github.com/test-owner/test-repo/pull/42');
    });
});

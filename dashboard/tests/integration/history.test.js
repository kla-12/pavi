process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

jest.mock('../../swarm-orchestrator', () => {
    const actual = jest.requireActual('../../swarm-orchestrator');
    return {
        ...actual,
        spawnSwarm: jest.fn().mockResolvedValue({ output: 'Mock Swarm Output', bots: [] })
    };
});

const request = require('supertest');
const app = require('../../server');
const { swarmRunsDB } = require('../../db');
const swarmOrchestrator = require('../../swarm-orchestrator');
describe('Swarm History API Integration Tests', () => {
    beforeEach(() => {
        swarmOrchestrator.spawnSwarm.mockClear();
        // Clean out any run data before each test by directly executing on the SQLite db if needed,
        // or using methods if available. Since it's in-memory, we can also manually clear the table.
        const { db } = require('../../db');
        db.prepare('DELETE FROM swarm_runs').run();
    });

    it('should list recorded runs (GET /api/history)', async () => {
        // Seed database
        swarmRunsDB.create('run-123', 'Build a beautiful landing page', ['coder', 'architect']);

        const res = await request(app).get('/api/history');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.runs.length).toEqual(1);
        expect(res.body.runs[0].id).toEqual('run-123');
        expect(res.body.runs[0].prompt).toEqual('Build a beautiful landing page');
    });

    it('should return 404 for a non-existent run (GET /api/history/:id)', async () => {
        const res = await request(app).get('/api/history/non-existent-id');
        expect(res.statusCode).toEqual(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('should return a specific run (GET /api/history/:id)', async () => {
        // Seed database
        swarmRunsDB.create('run-456', 'Deploy application to cloud', ['tester']);

        const res = await request(app).get('/api/history/run-456');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.run.id).toEqual('run-456');
    });

    it('should return 404 on replay for a non-existent run (POST /api/history/:id/replay)', async () => {
        const res = await request(app).post('/api/history/non-existent-id/replay');
        expect(res.statusCode).toEqual(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('should start replay for an existing run (POST /api/history/:id/replay)', async () => {
        // Seed database
        swarmRunsDB.create('run-789', 'Generate API documentation', ['reviewer']);

        const res = await request(app).post('/api/history/run-789/replay');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/replay started/i);
        expect(swarmOrchestrator.spawnSwarm).toHaveBeenCalledWith('Generate API documentation');
    });

    it('should soft-delete a swarm run (DELETE /api/history/:id)', async () => {
        // Seed database
        swarmRunsDB.create('run-abc', 'Optimize database indexes', ['coder']);

        const res = await request(app).delete('/api/history/run-abc');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);

        // Verify status is changed to 'deleted'
        const run = swarmRunsDB.getById('run-abc');
        expect(run.status).toEqual('deleted');
    });
});

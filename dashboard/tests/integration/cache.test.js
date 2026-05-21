process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

const request = require('supertest');
const app = require('../../server'); // Ensure server exports the app
const { promptCacheDB } = require('../../db');

describe('Cache API Integration Tests', () => {
    beforeAll(() => {
        promptCacheDB.clearAll();
    });

    afterAll(() => {
        promptCacheDB.clearAll();
    });

    it('should return cache stats (GET /api/cache/stats)', async () => {
        const res = await request(app).get('/api/cache/stats');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.stats).toHaveProperty('count');
    });

    it('should clear cache (DELETE /api/cache)', async () => {
        const res = await request(app).delete('/api/cache');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/cleared successfully/i);
    });
});

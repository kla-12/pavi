const request = require('supertest');
const path = require('path');
const fs = require('fs');
process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

const app = require('../../server');
const { pendingChangesDB, db } = require('../../db');

describe('Files Route Integration Tests', () => {
    beforeEach(() => {
        // Clear all pending changes from the in-memory db before each test
        const stmt = db.prepare('DELETE FROM pending_changes');
        stmt.run();
        jest.clearAllMocks();
    });

    test('GET /api/files/pending returns empty array initially', async () => {
        const res = await request(app).get('/api/files/pending');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.changes).toEqual([]);
    });

    test('POST /api/files/pending with missing filePath returns 400', async () => {
        const res = await request(app)
            .post('/api/files/pending')
            .send({ proposedContent: 'Hello world' });
        
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Missing filePath');
    });

    test('POST /api/files/pending with path traversal returns 403', async () => {
        const res = await request(app)
            .post('/api/files/pending')
            .send({ filePath: '../../../etc/passwd', proposedContent: 'hacked' });
        
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Access denied: path is outside project root');
    });

    test('POST /api/files/pending adds a change and POST respond rejects it', async () => {
        // Add pending change
        const testPath = path.join(__dirname, 'test.txt');
        const addRes = await request(app)
            .post('/api/files/pending')
            .send({ filePath: testPath, originalContent: '', proposedContent: 'test data' });
        
        expect(addRes.status).toBe(200);
        expect(addRes.body.success).toBe(true);
        expect(addRes.body.id).toBeDefined();

        const changeId = addRes.body.id;

        // Verify it shows up in GET
        const listRes = await request(app).get('/api/files/pending');
        expect(listRes.body.changes.length).toBe(1);
        expect(listRes.body.changes[0].id).toBe(changeId);

        // Reject it
        const respondRes = await request(app)
            .post(`/api/files/pending/${changeId}/respond`)
            .send({ action: 'reject' });
        
        expect(respondRes.status).toBe(200);
        expect(respondRes.body.success).toBe(true);

        // Verify it is no longer pending
        const change = pendingChangesDB.getPendingChange(changeId);
        expect(change.status).toBe('rejected');
    });

    test('GET /api/files/read with path traversal returns 403', async () => {
        const res = await request(app).get('/api/files/read?file=../../../etc/passwd');
        expect(res.status).toBe(403);
    });

    test('GET /api/files/read with valid path returns content', async () => {
        // We will read this test file itself since we know it exists
        const res = await request(app).get(`/api/files/read?file=${encodeURIComponent(__filename)}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.content).toContain('Files Route Integration Tests');
    });

    test('POST /api/files/write with invalid path returns 403', async () => {
        const res = await request(app)
            .post('/api/files/write')
            .send({ filePath: '../../../etc/passwd', content: 'hacked' });
        expect(res.status).toBe(403);
    });
});

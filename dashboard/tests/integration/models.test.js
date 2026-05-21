const request = require('supertest');
process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

// Mock fetch globally for Ollama tags API call
global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
        models: [
            { name: 'phi3:mini' },
            { name: 'llama3:latest' }
        ]
    })
});

const app = require('../../server');
const { settingsDB } = require('../../db');

describe('Models Route Integration Tests', () => {
    beforeEach(() => {
        // Reset selected model in db
        settingsDB.set('selected_model', 'phi3:mini');
        jest.clearAllMocks();
    });

    test('GET /api/models returns available models and selected_model', async () => {
        const res = await request(app)
            .get('/api/models');
        
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.models).toContain('phi3:mini');
        expect(res.body.models).toContain('llama3:latest');
        expect(res.body.selected_model).toBe('phi3:mini');
    });

    test('POST /api/models/select updates selected model in DB', async () => {
        const res = await request(app)
            .post('/api/models/select')
            .send({ model: 'llama3:latest' });
        
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.selected_model).toBe('llama3:latest');
        
        // Assert it is actually written to the DB
        expect(settingsDB.get('selected_model')).toBe('llama3:latest');
    });

    test('POST /api/models/select returns 400 if model parameter is missing', async () => {
        const res = await request(app)
            .post('/api/models/select')
            .send({});
        
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });
});

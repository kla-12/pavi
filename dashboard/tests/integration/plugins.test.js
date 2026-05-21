process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

const request = require('supertest');
const app = require('../../server');
const pluginLoader = require('../../services/plugin-loader');

describe('Plugins API Integration Tests', () => {
    
    beforeAll(async () => {
        // Ensure plugins are initialized
        await pluginLoader.loadPlugins(app);
    });

    it('should list loaded plugins (GET /api/plugins)', async () => {
        const res = await request(app).get('/api/plugins');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.plugins)).toBe(true);
        
        // Assert loaded plugins exist
        const ids = res.body.plugins.map(p => p.id);
        expect(ids).toContain('web-search');
        expect(ids).toContain('code-runner');
    });

    it('should retrieve specific plugin stats (GET /api/plugins/:id/stats)', async () => {
        const res = await request(app).get('/api/plugins/web-search/stats');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.stats).toBeDefined();
        expect(typeof res.body.stats.invocations).toBe('number');
    });

    it('should execute a quick test via sandbox (POST /api/plugins/:id/test)', async () => {
        const res = await request(app)
            .post('/api/plugins/code-runner/test')
            .send({ params: { code: '1 + 1' } });
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.result).toBeDefined();
        expect(res.body.result.result).toEqual('2');
    });

    it('should toggle plugin state (POST /api/plugins/:id/toggle)', async () => {
        // 1. Disable code-runner
        let toggleRes = await request(app)
            .post('/api/plugins/code-runner/toggle')
            .send({ enabled: false });
        expect(toggleRes.statusCode).toEqual(200);
        expect(toggleRes.body.success).toBe(true);
        expect(toggleRes.body.enabled).toBe(false);

        // Verify it is disabled in the list
        let listRes = await request(app).get('/api/plugins');
        let codeRunner = listRes.body.plugins.find(p => p.id === 'code-runner');
        expect(codeRunner.status).toEqual('disabled');

        // 2. Enable it back
        toggleRes = await request(app)
            .post('/api/plugins/code-runner/toggle')
            .send({ enabled: true });
        expect(toggleRes.statusCode).toEqual(200);
        expect(toggleRes.body.success).toBe(true);
        expect(toggleRes.body.enabled).toBe(true);

        // Verify it is active again
        listRes = await request(app).get('/api/plugins');
        codeRunner = listRes.body.plugins.find(p => p.id === 'code-runner');
        expect(codeRunner.status).toEqual('active');
    });

    it('should hit the web-search plugin endpoint (GET /api/plugins/web-search)', async () => {
        const res = await request(app).get('/api/plugins/web-search?q=test');
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.abstract).toBeDefined();
    });

    it('should run direct js sandbox snippet (POST /api/plugins/code-runner)', async () => {
        const res = await request(app)
            .post('/api/plugins/code-runner')
            .send({ code: 'console.log("hello test"); 5 * 5;' });
        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.result).toEqual('25');
        expect(res.body.logs).toContain('hello test');
    });
});

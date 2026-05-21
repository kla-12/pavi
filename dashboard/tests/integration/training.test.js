process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH_ON_LOCALHOST = 'true';

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const app = require('../../server');

describe('Training API Integration Tests', () => {
    const rejectionsDir = path.join(__dirname, '..', '..', '..', 'notebook_llm_exports', 'rejections');
    const mockFile = path.join(rejectionsDir, 'test_reject_123.json');
    const outPath = path.join(__dirname, '..', '..', '..', 'notebook_llm_exports', 'dpo_dataset.jsonl');

    beforeAll(() => {
        // Setup mock rejections folder
        if (!fs.existsSync(rejectionsDir)) {
            fs.mkdirSync(rejectionsDir, { recursive: true });
        }
        
        // Write a complete rejection that meets criteria
        const mockData = {
            originalPrompt: "Write a function to add two numbers.",
            workerOutput: "def add(a, b): return a - b",
            corrected: "def add(a, b): return a + b",
            critique: "Worker used minus sign instead of plus sign.",
            fileName: "test_reject_123.json"
        };
        fs.writeFileSync(mockFile, JSON.stringify(mockData, null, 2));
    });

    afterAll(() => {
        // Clean up
        if (fs.existsSync(mockFile)) {
            fs.unlinkSync(mockFile);
        }
        if (fs.existsSync(outPath)) {
            fs.unlinkSync(outPath);
        }
    });

    it('should export DPO dataset (GET /api/training/export)', async () => {
        const res = await request(app).get('/api/training/export');
        expect(res.statusCode).toEqual(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.count).toBeGreaterThanOrEqual(1);
        expect(res.body).toHaveProperty('outputPath');
        
        // Check file exists and has content
        expect(fs.existsSync(outPath)).toBe(true);
        const content = fs.readFileSync(outPath, 'utf8');
        expect(content).toContain("Write a function to add two numbers.");
        expect(content).toContain("def add(a, b): return a - b");
        expect(content).toContain("def add(a, b): return a + b");
    });
});

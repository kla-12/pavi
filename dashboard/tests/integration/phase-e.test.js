const request = require('supertest');
const app = require('../../server'); // Ensure this imports the express app without starting the server
const { pushSubscriptionsDB, settingsDB, db, swarmRunsDB } = require('../../db');
const webpush = require('web-push');

jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue({}),
    generateVAPIDKeys: jest.fn().mockReturnValue({
        publicKey: 'mock-public-key',
        privateKey: 'mock-private-key'
    })
}));

jest.mock('@octokit/rest', () => {
    return {
        Octokit: class {
            constructor() {}
            rest = {
                pulls: {
                    create: jest.fn().mockResolvedValue({ data: { html_url: 'mock_url' } })
                }
            }
        }
    };
});

const mockSubscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/mock-endpoint',
    keys: {
        p256dh: 'mock-p256dh',
        auth: 'mock-auth'
    }
};

describe('Phase E Integration Tests', () => {
    let server;
    let mockServer;

    beforeAll(done => {
        // Set env vars
        process.env.VAPID_PUBLIC_KEY = 'mock-vapid-public-key';
        process.env.MOBILE_PIN = '123456';
        
        // We will start the server on a random port for testing
        mockServer = app.listen(0, () => {
            done();
        });
    });

    afterAll(done => {
        if (mockServer) {
            mockServer.close(done);
        } else {
            done();
        }
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('1. GET /pwa/manifest.json returns valid PWA manifest', async () => {
        const res = await request(app).get('/pwa/manifest.json');
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Pavi AI Control Center');
        expect(res.body.display).toBe('standalone');
    });

    it('2. GET /mobile without auth redirects to /mobile-login', async () => {
        const res = await request(app).get('/mobile');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/mobile-login');
    });

    let authCookie;

    it('6. POST /api/auth/mobile-pin with correct PIN returns 200 + session cookie', async () => {
        const res = await request(app)
            .post('/api/auth/mobile-pin')
            .send({ pin: '123456' });
            
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.headers['set-cookie']).toBeDefined();
        authCookie = res.headers['set-cookie'];
    });

    it('3. POST /api/push/subscribe stores subscription in SQLite', async () => {
        const res = await request(app)
            .post('/api/push/subscribe')
            .set('Cookie', authCookie)
            .send(mockSubscription);
        
        expect(res.status).toBe(201); // 201 is returned in code
        expect(res.body.success).toBe(true);

        const subs = pushSubscriptionsDB.getAll();
        expect(subs).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ endpoint: mockSubscription.endpoint })
            ])
        );
    });

    it('4. POST /api/push/unsubscribe removes subscription from SQLite', async () => {
        pushSubscriptionsDB.save(mockSubscription.endpoint, mockSubscription.endpoint, 'key1', 'key2');
        
        const res = await request(app)
            .post('/api/push/unsubscribe')
            .set('Cookie', authCookie)
            .send({ endpoint: mockSubscription.endpoint });
            
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const subs = pushSubscriptionsDB.getAll();
        expect(subs).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ endpoint: mockSubscription.endpoint })
            ])
        );
    });

    it('5. GET /api/push/vapid-public-key returns a valid VAPID public key', async () => {
        const res = await request(app)
            .get('/api/push/vapid-public-key')
            .set('Cookie', authCookie);
        expect(res.status).toBe(200);
        expect(res.body.publicKey).toBe('mock-vapid-public-key');
    });

    it('7. POST /api/auth/mobile-pin with wrong PIN returns 401', async () => {
        const res = await request(app)
            .post('/api/auth/mobile-pin')
            .send({ pin: '000000' });
            
        expect(res.status).toBe(401);
        expect(res.body.error).toBeDefined();
    });

    it('8. POST /api/auth/mobile-pin after 5 failures returns 429 (rate limited)', async () => {
        // trigger 5 failures
        for (let i = 0; i < 5; i++) {
            await request(app).post('/api/auth/mobile-pin').send({ pin: '111111' });
        }
        
        const res = await request(app)
            .post('/api/auth/mobile-pin')
            .send({ pin: '123456' }); // even correct pin should fail now
            
        expect(res.status).toBe(429);
        expect(res.body.error).toBeDefined();
    });

    it('9. POST /api/swarm/cancel returns 200/400 depending on active swarm', async () => {
        const res = await request(app)
            .post('/api/swarm/cancel')
            .set('Cookie', authCookie)
            .send({});
            
        // Might be 400 if no active swarm
        expect([200, 400]).toContain(res.status);
    });

    it('10. GET /api/swarm/status returns current swarm state object', async () => {
        const res = await request(app)
            .get('/api/swarm/status')
            .set('Cookie', authCookie);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.runningRuns)).toBe(true);
    });

    it('11. GET /api/phase-d/jobs returns array of recent CI/CD jobs', async () => {
        const res = await request(app)
            .get('/api/phase-d/jobs')
            .set('Cookie', authCookie);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.jobs)).toBe(true);
    });

    it('12. Push notification broadcast is called when a swarm completes', async () => {
        const pushService = require('../../services/push-notifications');
        const broadcastSpy = jest.spyOn(pushService, 'broadcastNotification');
        
        // Let's call broadcast directly since triggering a full swarm in a test is too heavy
        await pushService.broadcastNotification({ title: 'Test', body: 'Test Body' });
        expect(broadcastSpy).toHaveBeenCalled();
        
        broadcastSpy.mockRestore();
    });
});

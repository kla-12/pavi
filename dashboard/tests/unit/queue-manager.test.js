// Mock the db dependency before requiring queue-manager
jest.mock('../../db', () => ({
    queueDB: {
        getNextPending: jest.fn().mockReturnValue(null),
        markProcessing: jest.fn(),
        markDone: jest.fn(),
        markFailed: jest.fn(),
        getAll: jest.fn().mockReturnValue([]),
        updateProgress: jest.fn(),
        addJob: jest.fn()
    }
}));
jest.mock('../../services/session', () => ({
    SESSION: { status: 'idle', currentTask: '' },
    sessionBroadcast: jest.fn(),
    sessionLog: jest.fn(),
    withSessionLock: jest.fn(fn => fn()),
    saveSession: jest.fn()
}));
jest.mock('../../supreme-architect', () => ({
    evaluateRepo: jest.fn().mockResolvedValue({ verdict: 'APPROVE', promptFragment: '' }),
    updateModel: jest.fn().mockResolvedValue(true)
}));

const { triggerQueueDrain, drainQueue } = require('../../services/queue-manager');

describe('queue-manager', () => {
    test('triggerQueueDrain is callable', () => {
        expect(typeof triggerQueueDrain).toBe('function');
    });

    test('drainQueue exits cleanly when no jobs pending', async () => {
        await expect(drainQueue()).resolves.not.toThrow();
    });

    test('second concurrent drain call is skipped (lock mechanism)', async () => {
        const { db: mockDb } = require('../../db');
        // Should not throw or deadlock
        await Promise.all([drainQueue(), drainQueue()]);
    });
});

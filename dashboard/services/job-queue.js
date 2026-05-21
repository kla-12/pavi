const { phaseDJobsDB } = require('../db');
// Pipeline will be required dynamically to avoid circular dependencies if pipeline needs job-queue
const pipeline = require('./pipeline');
const logger = require('../utils/logger');
const crypto = require('crypto');

class JobQueue {
    constructor() {
        this.isProcessing = false;
    }

    enqueue(issueNumber, payload) {
        const jobId = crypto.randomUUID();
        const added = phaseDJobsDB.addJob(jobId, issueNumber, payload);
        if (!added) {
            logger.info(`[JobQueue] Skipped duplicate pending job for issue #${issueNumber}`);
            return { duplicate: true };
        }
        
        logger.info(`[JobQueue] Enqueued job ${jobId} for issue #${issueNumber}`);
        this.processNext();
        return { queued: true, jobId };
    }

    async processNext() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            while (true) {
                const job = phaseDJobsDB.getNextPending();
                if (!job) break;

                logger.info(`[JobQueue] Processing job ${job.id}`);
                phaseDJobsDB.updateStatus(job.id, 'processing');
                
                try {
                    await pipeline.processJob(job);
                    phaseDJobsDB.updateStatus(job.id, 'done');
                } catch (e) {
                    logger.error(`[JobQueue] Job ${job.id} failed:`, e.message);
                    phaseDJobsDB.updateStatus(job.id, 'failed', { error: e.message });
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }
}

module.exports = new JobQueue();

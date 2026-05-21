'use strict';
/**
 * growth-engine.js — Training Trigger Monitor
 *
 * Watches the training_feedback_dataset for threshold and triggers
 * dataset export when enough samples have been collected for fine-tuning.
 */

let lastExportTimestamp = null;

/**
 * Check if enough training samples exist to trigger an export.
 * @param {number} [threshold=100]
 * @returns {{ ready: boolean, count: number, threshold: number }}
 */
function checkThreshold(threshold = 100) {
    try {
        const { trainingFeedbackDatasetDB } = require('./db');
        const count = trainingFeedbackDatasetDB.getCount();
        return { ready: count >= threshold, count, threshold };
    } catch (e) {
        console.warn('[GROWTH_ENGINE] Could not check threshold:', e.message);
        return { ready: false, count: 0, threshold };
    }
}

/**
 * Trigger export of ChatML + DPO datasets.
 * @returns {{ chatml: { path: string, count: number }, dpo: { path: string, count: number } }}
 */
function triggerExport() {
    try {
        const exporter = require('./training/exporter');
        const chatml = exporter.exportChatML();
        const dpo = exporter.exportDPO();
        lastExportTimestamp = new Date().toISOString();
        console.log(`[GROWTH_ENGINE] ✅ Training export complete: ${chatml.count} ChatML, ${dpo.count} DPO pairs.`);
        return { chatml, dpo };
    } catch (e) {
        console.error('[GROWTH_ENGINE] Export failed:', e.message);
        return { chatml: { path: null, count: 0 }, dpo: { path: null, count: 0 } };
    }
}

/**
 * Get current training status.
 * @returns {{ samplesCollected: number, lastExport: string|null, readyForTraining: boolean }}
 */
function getTrainingStatus() {
    const check = checkThreshold();
    return {
        samplesCollected: check.count,
        threshold: check.threshold,
        readyForTraining: check.ready,
        lastExport: lastExportTimestamp,
    };
}

/**
 * Run a full growth cycle: check threshold → export if ready → log.
 * Designed to be called periodically (e.g. nightly cron or after each swarm run).
 * @returns {{ triggered: boolean, status: object, exports?: object }}
 */
function runGrowthCycle() {
    const status = getTrainingStatus();

    if (!status.readyForTraining) {
        console.log(`[GROWTH_ENGINE] Growth cycle: ${status.samplesCollected}/${status.threshold} samples. Not ready yet.`);
        return { triggered: false, status };
    }

    console.log(`[GROWTH_ENGINE] 🚀 Threshold met (${status.samplesCollected}/${status.threshold}). Triggering export...`);
    const exports = triggerExport();

    // Emit telemetry
    try {
        const telemetry = require('./services/telemetry');
        telemetry.emit('growth_cycle_triggered', {
            samples: status.samplesCollected,
            chatmlCount: exports.chatml.count,
            dpoCount: exports.dpo.count
        });
    } catch (_) {}

    return { triggered: true, status, exports };
}

module.exports = { checkThreshold, triggerExport, getTrainingStatus, runGrowthCycle };

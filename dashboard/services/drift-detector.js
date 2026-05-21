'use strict';
/**
 * drift-detector.js — Worker Performance Drift Monitor
 *
 * Monitors Worker pass rates over time using the training_feedback_dataset.
 * Triggers warnings if average scores regress below a safety threshold,
 * indicating the local model needs retraining or parameter adjustment.
 */

/**
 * Detect performance drift by analyzing recent evaluation scores.
 * @param {number} [windowSize=50] - Number of most recent entries to analyze
 * @returns {{ drifting: boolean, avgScore: number, window: number, recommendation?: string }}
 */
function detectDrift(windowSize = 50) {
    try {
        const { trainingFeedbackDatasetDB } = require('../db');
        const all = trainingFeedbackDatasetDB.getAll();

        if (all.length === 0) {
            return { drifting: false, avgScore: 0, window: 0, recommendation: 'No data yet.' };
        }

        // Take the most recent `windowSize` entries
        const recent = all.slice(0, windowSize);
        const scores = recent.filter(r => r.score !== null && r.score !== undefined).map(r => r.score);

        if (scores.length === 0) {
            return { drifting: false, avgScore: 0, window: 0, recommendation: 'No scored entries.' };
        }

        const avgScore = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));

        if (avgScore < 60) {
            return {
                drifting: true,
                avgScore,
                window: scores.length,
                recommendation: 'Worker performance degraded below 60%. Consider retraining with recent successful patterns or adjusting model parameters.'
            };
        }

        if (avgScore < 70) {
            return {
                drifting: false,
                avgScore,
                window: scores.length,
                recommendation: 'Worker performance is acceptable but trending low. Monitor closely.'
            };
        }

        return { drifting: false, avgScore, window: scores.length };
    } catch (e) {
        console.warn('[DRIFT_DETECTOR] Detection failed:', e.message);
        return { drifting: false, avgScore: 0, window: 0, recommendation: `Error: ${e.message}` };
    }
}

/**
 * Calculate overall pass rate.
 * @param {number} [threshold=70] - Score threshold for "passing"
 * @returns {{ total: number, passing: number, passRate: number }}
 */
function getPassRate(threshold = 70) {
    try {
        const { trainingFeedbackDatasetDB } = require('../db');
        const all = trainingFeedbackDatasetDB.getAll();
        const scored = all.filter(r => r.score !== null && r.score !== undefined);
        const passing = scored.filter(r => r.score >= threshold);

        return {
            total: scored.length,
            passing: passing.length,
            passRate: scored.length > 0 ? parseFloat((passing.length / scored.length * 100).toFixed(1)) : 0
        };
    } catch (e) {
        return { total: 0, passing: 0, passRate: 0 };
    }
}

/**
 * Get score trend over time by splitting dataset into buckets.
 * @param {number} [bucketSize=20]
 * @returns {Array<{ bucket: number, avgScore: number, count: number }>}
 */
function getTrend(bucketSize = 20) {
    try {
        const { trainingFeedbackDatasetDB } = require('../db');
        const all = trainingFeedbackDatasetDB.getAll();
        const scored = all.filter(r => r.score !== null && r.score !== undefined);

        // Reverse so oldest is first (dataset comes sorted DESC by timestamp)
        scored.reverse();

        const buckets = [];
        for (let i = 0; i < scored.length; i += bucketSize) {
            const slice = scored.slice(i, i + bucketSize);
            const scores = slice.map(r => r.score);
            const avg = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));
            buckets.push({
                bucket: buckets.length + 1,
                avgScore: avg,
                count: scores.length
            });
        }

        return buckets;
    } catch (e) {
        return [];
    }
}

module.exports = { detectDrift, getPassRate, getTrend };

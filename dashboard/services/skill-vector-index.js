'use strict';
/**
 * skill-vector-index.js — In-Memory Vector Database Fallback
 *
 * Uses TF-IDF bag-of-words vectors and cosine similarity for fast
 * skill retrieval without any native dependencies.
 */

class SkillVectorIndex {
    constructor() {
        this.skills = [];       // { tag, description, knowledge, vector }
        this.vocabulary = {};   // word → index
        this.vocabSize = 0;
        this.idf = {};          // word → IDF score
    }

    /**
     * Tokenize text into lowercased words, stripping punctuation.
     * @param {string} text
     * @returns {string[]}
     */
    _tokenize(text) {
        if (!text || typeof text !== 'string') return [];
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2);
    }

    /**
     * Build a term-frequency vector for the given text.
     * @param {string} text
     * @returns {object} - sparse vector as { wordIndex: frequency }
     */
    _buildVector(text) {
        const tokens = this._tokenize(text);
        const tf = {};

        for (const token of tokens) {
            // Add to vocabulary if new
            if (this.vocabulary[token] === undefined) {
                this.vocabulary[token] = this.vocabSize++;
            }
            const idx = this.vocabulary[token];
            tf[idx] = (tf[idx] || 0) + 1;
        }

        // Normalize by max frequency
        const maxFreq = Math.max(...Object.values(tf), 1);
        for (const idx of Object.keys(tf)) {
            tf[idx] = tf[idx] / maxFreq;
        }

        return tf;
    }

    /**
     * Compute cosine similarity between two sparse vectors.
     * @param {object} a
     * @param {object} b
     * @returns {number}
     */
    _cosine(a, b) {
        let dot = 0, magA = 0, magB = 0;

        for (const key of Object.keys(a)) {
            magA += a[key] * a[key];
            if (b[key] !== undefined) {
                dot += a[key] * b[key];
            }
        }
        for (const key of Object.keys(b)) {
            magB += b[key] * b[key];
        }

        magA = Math.sqrt(magA);
        magB = Math.sqrt(magB);

        if (magA === 0 || magB === 0) return 0;
        return dot / (magA * magB);
    }

    /**
     * Combine all text fields from a skill into a single searchable string.
     */
    _skillToText(tag, description, knowledge) {
        const parts = [tag || '', description || ''];
        if (knowledge && typeof knowledge === 'object') {
            parts.push(knowledge.summary || '');
            parts.push(knowledge.whenToUse || '');
            parts.push(knowledge.approach || '');
            parts.push(knowledge.codeExample || '');
            parts.push(knowledge.antiPattern || '');
            if (knowledge.domainTags) parts.push(knowledge.domainTags.join(' '));
            if (knowledge.relatedSkills) parts.push(knowledge.relatedSkills.join(' '));
        }
        return parts.join(' ');
    }

    /**
     * Add a skill to the index.
     * @param {string} tag
     * @param {string} description
     * @param {object} [knowledge]
     */
    addSkill(tag, description, knowledge) {
        const text = this._skillToText(tag, description, knowledge);
        const vector = this._buildVector(text);
        this.skills.push({ tag, description, knowledge, vector });
    }

    /**
     * Search for skills by query string.
     * @param {string} query
     * @param {number} [topK=5]
     * @returns {Array<{ tag: string, score: number, description: string }>}
     */
    search(query, topK = 5) {
        if (!query || this.skills.length === 0) return [];

        const queryVector = this._buildVector(query);
        const results = [];

        for (const skill of this.skills) {
            const score = this._cosine(queryVector, skill.vector);
            if (score > 0) {
                results.push({
                    tag: skill.tag,
                    score: parseFloat(score.toFixed(4)),
                    description: skill.description
                });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    /**
     * Rebuild the entire index from the skills database.
     */
    rebuildFromSkillsDB() {
        // Clear existing index
        this.skills = [];
        this.vocabulary = {};
        this.vocabSize = 0;

        try {
            const { skillsDB } = require('../db');
            const allSkills = skillsDB.getAll();

            for (const skill of allSkills) {
                this.addSkill(skill.tag, skill.description, skill.knowledge);
            }

            console.log(`[VECTOR_INDEX] Rebuilt index: ${allSkills.length} skills, ${this.vocabSize} vocabulary terms`);
        } catch (e) {
            console.warn(`[VECTOR_INDEX] Failed to rebuild from DB: ${e.message}`);
        }
    }

    /**
     * Get index statistics.
     * @returns {{ totalSkills: number, vocabularySize: number }}
     */
    getStats() {
        return {
            totalSkills: this.skills.length,
            vocabularySize: this.vocabSize
        };
    }
}

// Singleton instance
const index = new SkillVectorIndex();

module.exports = { SkillVectorIndex, index };

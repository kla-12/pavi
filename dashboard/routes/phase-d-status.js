const express = require('express');
const router = express.Router();
const { db } = require('../db');

router.get('/jobs', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM phase_d_jobs ORDER BY created_at DESC LIMIT 50').all();
        const jobs = rows.map(row => {
            let payload = {};
            let resultData = {};
            try { payload = JSON.parse(row.payload); } catch (e) {}
            try { resultData = JSON.parse(row.result_data); } catch (e) {}
            
            return {
                id: row.id,
                issue_number: row.issue_number,
                payload,
                status: row.status,
                resultData,
                created_at: row.created_at,
                updated_at: row.updated_at
            };
        });
        
        return res.json({
            success: true,
            jobs
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

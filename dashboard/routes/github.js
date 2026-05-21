const express = require('express');
const router = express.Router();
const githubWatcher = require('../services/github-watcher');

router.post('/', githubWatcher.handleWebhook);

module.exports = router;

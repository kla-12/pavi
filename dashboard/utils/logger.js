'use strict';
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const transport = pino.transport({
    targets: [
        {
            target: 'pino/file',
            options: { destination: path.join(logsDir, 'pavi.log'), mkdir: true },
            level: 'info'
        },
        {
            target: 'pino-pretty',
            options: { colorize: true },
            level: 'debug'
        }
    ]
});

const logger = pino(
    {
        level: process.env.LOG_LEVEL || 'info',
        base: { pid: process.pid, app: 'pavi' },
        timestamp: pino.stdTimeFunctions.isoTime
    },
    transport
);

module.exports = logger;

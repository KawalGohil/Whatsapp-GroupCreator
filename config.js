const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';
const dataDir = isProduction ? '/var/data' : __dirname;

const config = {
    paths: {
        data: dataDir,
        database: path.join(dataDir, 'whatsapp_automation.db'),
        session: path.join(dataDir, 'baileys_auth_info'), // Changed for Baileys
        sessionStore: path.join(dataDir, 'sessions.db'),
    },
    rateLimits: {
        retries: {
            maxRetries: 3,
            initialBackoff: 5000, // 5 seconds
        },
    },
};

console.log('Application configuration:', config.paths);
module.exports = config;
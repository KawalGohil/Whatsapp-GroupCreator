const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./src/utils/logger');

const dbPath = config.paths.database;

// Ensure the data directory exists
const dirname = path.dirname(dbPath);
if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
    logger.info(`Created database directory: ${dirname}`);
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error('Error opening database:', err.message);
        process.exit(1);
    }
    logger.info(`Connected to the SQLite database at: ${dbPath}`);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`, (err) => {
        if (err) {
            logger.error('Error creating users table:', err.message);
        } else {
            logger.info('Users table is ready.');
        }
    });
});

module.exports = db;
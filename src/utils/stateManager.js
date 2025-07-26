const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('../../config');

const STATE_FILE = path.join(config.paths.data, 'state.json');

function readState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const rawState = fs.readFileSync(STATE_FILE, 'utf-8');
            return JSON.parse(rawState);
        }
    } catch (err) {
        logger.error('Error reading state file:', err);
    }
    // Return a default state if file doesn't exist or is corrupt
    return { createdGroups: {} };
}

function writeState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        logger.error('Error writing state file:', err);
    }
}

module.exports = { readState, writeState };
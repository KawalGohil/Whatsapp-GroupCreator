const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getClient } = require('../services/whatsappService');
const taskQueue = require('../services/taskQueue');
const logger = require('../utils/logger');
const config = require('../../config');

const sanitizePhoneNumber = (num) => {
    if (!num) return null;
    // Remove all non-digit characters. This safely handles scientific notation and special characters.
    const cleaned = String(num).replace(/\D/g, '');

    // Assuming that valid numbers must have a country code to be universally correct.
    // This example enforces a minimum length of 11 (e.g., US numbers) but can be adjusted.
    if (cleaned.length >= 11) { 
        return `${cleaned}@s.whatsapp.net`;
    }
    // Handle 10-digit numbers by prepending a default country code, but log a warning.
    else if (cleaned.length === 10) {
        logger.warn(`Assuming country code '91' for 10-digit number: ${cleaned}`);
        return `91${cleaned}@s.whatsapp.net`;
    }
    
    logger.warn(`Skipping invalid or incomplete phone number: ${num}`);
    return null; // Return null for any number that is too short.
};


// --- Manual Group Creation (No changes needed) ---
exports.createManualGroup = async (req, res) => {
    const { groupName, numbers, desiredAdminNumber } = req.body;
    const username = req.session.user.username;
    const sock = getClient(username);

    if (!sock) return res.status(400).json({ message: 'WhatsApp client not ready.' });
    if (!groupName || !numbers) return res.status(400).json({ message: 'Group name and numbers are required.' });

    try {
        const participants = numbers.split(/[,\n]/).map(sanitizePhoneNumber).filter(Boolean);
        const adminJid = sanitizePhoneNumber(desiredAdminNumber);
        await createGroup(sock, username, groupName, participants, adminJid);
        res.status(200).json({ message: `Group "${groupName}" creation initiated.` });
    } catch (error) {
        logger.error(`Manual group creation failed for ${username}:`, error);
        res.status(500).json({ message: error.message });
    }
};

// --- Upload Logic (Updated) ---
exports.uploadContacts = (req, res) => {
    const username = req.session.user.username;
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }
    res.status(202).json({ message: 'File queued. Groups will be created in the background.' });
    processCsvFile(req.file.path, username);
};

async function processCsvFile(filePath, username) { // No longer takes `sock`
    const rows = [];
    fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.toLowerCase() }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath);
            logger.info(`Adding ${rows.length} group creation tasks to queue for user ${username}.`);
            let queuedCount = 0;
            let failedCount = 0;

            for (const [index, row] of rows.entries()) {
                // ... (your existing logic to parse the row data) ...
                try {
                    // ...
                    
                    // --- REPLACE createGroup call with this ---
                    taskQueue.addTask({
                        username,
                        groupName,
                        participants: uniqueParticipants,
                        adminJid,
                        index: index + 1, // Use 1-based index for the UI
                        total: rows.length
                    });
                    queuedCount++;
                } catch (error) {
                    failedCount++;
                    logger.error(`Failed to queue row ${index + 1}: ${error.message}`);
                }
            }
            if (global.io && global.userSockets[username]) {
                global.io.to(global.userSockets[username]).emit('upload_complete', { successCount: queuedCount, failedCount, total: rows.length });
            }
        });
}

// --- Log File Management ---
exports.listLogs = (req, res) => {
    const logDir = path.join(config.paths.data, 'invite-logs');
    const username = req.session.user.username;

    fs.readdir(logDir, (err, files) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(200).json([]); // No logs yet
            return res.status(500).json({ message: 'Could not list log files.' });
        }

        const userLogs = files
            .filter(file => file.startsWith(`group_invite_log_${username}_`) && file.endsWith('.csv'))
            .map(file => {
                const dateStr = file.replace(`group_invite_log_${username}_`, '').replace('.csv', '');
                return { filename: file, display: `Invite links for groups created on ${dateStr}` };
            })
            .sort((a, b) => b.display.localeCompare(a.display));

        res.status(200).json(userLogs);
    });
};

exports.downloadLog = (req, res) => {
    const logDir = path.join(config.paths.data, 'invite-logs');
    const { filename } = req.params;
    const username = req.session.user.username;

    if (!filename.startsWith(`group_invite_log_${username}`)) {
        return res.status(403).json({ message: 'Forbidden' });
    }

    const logPath = path.join(logDir, filename);
    if (fs.existsSync(logPath)) {
        res.download(logPath, filename);
    } else {
        res.status(404).json({ message: 'Log file not found.' });
    }
};
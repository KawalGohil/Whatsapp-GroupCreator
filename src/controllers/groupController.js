const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getClient } = require('../services/whatsappService');
const { createGroup } = require('../services/groupCreationService'); // We will create this new service
const logger = require('../utils/logger');
const config = require('../../config');

// Create a group from manual input
exports.createManualGroup = async (req, res) => {
    const { groupName, numbers } = req.body;
    const username = req.session.user.username;
    const sock = getClient(username);

    if (!sock) {
        return res.status(400).json({ message: 'WhatsApp client not ready.' });
    }
    if (!groupName || !numbers) {
        return res.status(400).json({ message: 'Group name and numbers are required.' });
    }

    try {
        const participants = numbers.split(/[,\n]/).map(num => `${num.replace(/\D/g, '')}@s.whatsapp.net`);
        await createGroup(sock, username, groupName, participants);
        res.status(200).json({ message: `Group "${groupName}" creation initiated.` });
    } catch (error) {
        logger.error(`Manual group creation failed for ${username}:`, error);
        res.status(500).json({ message: error.message });
    }
};

// Handle CSV file upload and process in the background
exports.uploadContacts = (req, res) => {
    const username = req.session.user.username;
    const sock = getClient(username);

    if (!sock) {
        return res.status(400).json({ message: 'WhatsApp client not ready.' });
    }
    if (!req.file) {
        return res.status(400).json({ message: 'CSV file is required.' });
    }
    
    // Respond immediately to the client
    res.status(202).json({ message: 'File uploaded. Processing will continue in the background.' });

    // Process the CSV in the background
    processCsvFile(req.file.path, sock, username);
};

async function processCsvFile(filePath, sock, username) {
    const rows = [];
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath); // Clean up the uploaded file
            logger.info(`Processing ${rows.length} groups from CSV for user ${username}.`);

            for (const [index, row] of rows.entries()) {
                try {
                    // Adapt this logic to match your CSV headers
                    const groupName = row['Group Name'];
                    const participants = row['Participants'].split(',').map(num => `${num.trim()}@s.whatsapp.net`);
                    
                    if (groupName && participants.length > 0) {
                        await createGroup(sock, username, groupName, participants);
                    }
                    // Notify frontend of progress
                    global.io.to(global.userSockets[username]).emit('upload_progress', { current: index + 1, total: rows.length, currentGroup: groupName });

                } catch (error) {
                    logger.error(`Failed to process row ${index + 1} for ${username}:`, error);
                }
            }
            global.io.to(global.userSockets[username]).emit('upload_complete', { successCount: rows.length, failedCount: 0 }); // Simplified for now
        });
}

// --- Log File Management ---
// (These can be copied from your previous project, just ensure paths are correct)
exports.listLogs = (req, res) => {
    // ... logic to read and list files from the invite-logs directory ...
};

exports.downloadLog = (req, res) => {
    // ... logic to download a specific log file ...
};
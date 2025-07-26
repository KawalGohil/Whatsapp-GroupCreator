const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getClient } = require('../services/whatsappService');
const { createGroup } = require('../services/groupCreationService');
const logger = require('../utils/logger');
const config = require('../../config');

const sanitizePhoneNumber = (num) => {
    if (!num) return null;
    // Convert from scientific notation and remove all non-digit characters
    const cleaned = String(Number(num)).replace(/\D/g, '');
    
    // If the number is valid (10 digits or more), format it.
    if (cleaned.length >= 10) {
        return `${cleaned}@s.whatsapp.net`;
    }    
    // Otherwise, the number is invalid
    return null;
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
    const sock = getClient(username);
    if (!sock || !req.file) {
        return res.status(400).json({ message: 'Client not ready or no file uploaded.' });
    }
    res.status(202).json({ message: 'File uploaded. Processing will continue in the background.' });
    processCsvFile(req.file.path, sock, username);
};

async function processCsvFile(filePath, sock, username) {
    const rows = [];
    fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.toLowerCase() }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath);
            logger.info(`Processing ${rows.length} groups from CSV for user ${username}.`);

            for (const [index, row] of rows.entries()) {
                let groupName;
                try {
                    const bookingId = row['booking id']?.trim();
                    const propertyName = row['property name']?.trim();
                    const checkIn = row['check-in']?.trim();

                    if (!bookingId || !propertyName || !checkIn) throw new Error('Row missing required name fields.');
                    groupName = `${bookingId} - ${propertyName} - ${checkIn}`;

                    const participants = [];
                    for (const key in row) {
                        if (key.includes('number') || key.includes('contact')) {
                            const phoneValue = row[key]?.trim();
                            if (phoneValue) participants.push(sanitizePhoneNumber(phoneValue));
                        }
                    }
                    
                    const uniqueParticipants = [...new Set(participants.filter(Boolean))];
                    
                    // **FIX**: Correctly find and sanitize the admin number from the 'admin number' column
                    const adminJid = sanitizePhoneNumber(row['admin number']?.trim());

                    if (uniqueParticipants.length === 0) throw new Error('No valid participants found.');
                    
                    await createGroup(sock, username, groupName, uniqueParticipants, adminJid);
                    
                    global.io.to(global.userSockets[username]).emit('upload_progress', { current: index + 1, total: rows.length, currentGroup: groupName });
                } catch (error) {
                    logger.error(`Failed to process row ${index + 1} (${groupName || 'Unknown'}): ${error.message}`);
                }
            }
            global.io.to(global.userSockets[username]).emit('upload_complete', { successCount: rows.length, failedCount: 0 });
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
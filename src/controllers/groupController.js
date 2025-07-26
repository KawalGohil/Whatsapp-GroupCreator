const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getClient } = require('../services/whatsappService');
const { createGroup } = require('../services/groupCreationService');
const logger = require('../utils/logger');
const config = require('../../config');

const sanitizePhoneNumber = (num) => {
    if (!num) return null;
    const cleaned = String(num).replace(/\D/g, '');
    return cleaned ? `${cleaned}@s.whatsapp.net` : null;
};

// --- No changes needed for manual group creation ---
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

// Handle CSV file upload and process in the background
exports.uploadContacts = (req, res) => {
    const username = req.session.user.username;
    const sock = getClient(username);

    if (!sock) return res.status(400).json({ message: 'WhatsApp client not ready.' });
    if (!req.file) return res.status(400).json({ message: 'CSV file is required.' });
    
    res.status(202).json({ message: 'File uploaded. Processing will continue in the background.' });
    processCsvFile(req.file.path, sock, username);
};

async function processCsvFile(filePath, sock, username) {
    const rows = [];
    // **FIX**: Map headers to lowercase to make matching case-insensitive
    fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.toLowerCase() }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath);
            logger.info(`Processing ${rows.length} rows from CSV for user ${username}.`);

            let successCount = 0;
            let failedCount = 0;

            for (const [index, row] of rows.entries()) {
                let groupName;
                try {
                    // **FIX**: Use lowercase headers for lookup
                    const bookingId = row['booking id']?.trim();
                    const propertyName = row['property name']?.trim();
                    const checkIn = row['check-in']?.trim();

                    if (!bookingId || !propertyName || !checkIn) {
                        throw new Error('Row is missing required fields for group name.');
                    }
                    groupName = `${bookingId} - ${propertyName} - ${checkIn}`;

                    const participants = [];
                    for (const key in row) {
                        // This logic remains the same as it's already lowercase
                        if (key.toLowerCase().includes('number') || key.toLowerCase().includes('contact')) {
                            const phoneValue = row[key]?.trim();
                            if (phoneValue) {
                                participants.push(sanitizePhoneNumber(phoneValue));
                            }
                        }
                    }
                    
                    const uniqueParticipants = [...new Set(participants.filter(Boolean))];
                    const adminJid = sanitizePhoneNumber(row['admin number']?.trim());

                    if (uniqueParticipants.length > 0) {
                        await createGroup(sock, username, groupName, uniqueParticipants, adminJid);
                        successCount++;
                    } else {
                        throw new Error('No valid participant numbers found in the row.');
                    }
                    
                    global.io.to(global.userSockets[username]).emit('upload_progress', { current: index + 1, total: rows.length, currentGroup: groupName, message: `Successfully processed: ${groupName}` });

                } catch (error) {
                    failedCount++;
                    const errorMessage = `Failed to process row ${index + 1} (${groupName || 'Unknown Group'}): ${error.message}`;
                    logger.error(errorMessage);
                    global.io.to(global.userSockets[username]).emit('upload_progress', { current: index + 1, total: rows.length, currentGroup: groupName || 'Unknown', message: errorMessage });
                }
            }
            
            global.io.to(global.userSockets[username]).emit('upload_complete', { successCount, failedCount });
        });
}


// --- Log File Management (Unchanged) ---
// ... (listLogs and downloadLog functions remain the same)
exports.listLogs = (req, res) => {
    const logDir = path.join(config.paths.data, 'invite-logs');
    const username = req.session.user.username;

    fs.readdir(logDir, (err, files) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(200).json([]);
            logger.error(`Error reading log directory for ${username}:`, err);
            return res.status(500).json({ message: 'Could not list log files.' });
        }

        const userLogs = files
            .filter(file => file.startsWith(`group_invite_log_${username}_`) && file.endsWith('.csv'))
            .map(file => {
                const dateStr = file.replace(`group_invite_log_${username}_`, '').replace('.csv', '');
                return { filename: file, display: `Log for ${dateStr}` };
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
        logger.warn(`Unauthorized download attempt by ${username} for ${filename}`);
        return res.status(403).json({ message: 'Forbidden' });
    }

    const logPath = path.join(logDir, filename);

    if (fs.existsSync(logPath)) {
        res.download(logPath, filename);
    } else {
        res.status(404).json({ message: 'Log file not found.' });
    }
};
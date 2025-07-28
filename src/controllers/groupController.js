const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { getClient } = require('../services/whatsappService');
const taskQueue = require('../services/taskQueue');
const logger = require('../utils/logger');
const config = require('../../config');
const { createGroup } = require('../services/groupCreationService'); // This is needed for manual creation

const sanitizePhoneNumber = (num) => {
    if (!num) return null;
    const cleaned = String(num).replace(/\D/g, '');
    if (cleaned.length >= 11) {
        return `${cleaned}@s.whatsapp.net`;
    } else if (cleaned.length === 10) {
        logger.warn(`Assuming country code '91' for 10-digit number: ${cleaned}`);
        return `91${cleaned}@s.whatsapp.net`;
    }
    logger.warn(`Skipping invalid or incomplete phone number: ${num}`);
    return null;
};

// Manual Group Creation
exports.createManualGroup = async (req, res) => {
    const { groupName, numbers, desiredAdminNumber } = req.body;
    const username = req.session.user.username;
    const sock = getClient(username);

    if (!sock) return res.status(400).json({ message: 'WhatsApp client not ready. Please wait or re-login.' });
    if (!groupName || !numbers) return res.status(400).json({ message: 'Group name and numbers are required.' });

    try {
        const participants = numbers.split(/[,\n]/).map(sanitizePhoneNumber).filter(Boolean);
        const adminJid = sanitizePhoneNumber(desiredAdminNumber);

        // For manual, we can create it directly without the queue
        await createGroup(sock, username, groupName, participants, adminJid);

        res.status(200).json({ message: `Group "${groupName}" creation initiated.` });
    } catch (error) {
        logger.error(`Manual group creation failed for ${username}:`, error);
        res.status(500).json({ message: error.message });
    }
};

// Upload Logic
exports.uploadContacts = (req, res) => {
    const username = req.session.user.username;
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }
    
    // Immediately respond to the user
    res.status(202).json({ message: 'File queued. Groups will be created in the background.' });
    
    // Process the file in the background
    processCsvFile(req.file.path, username);
};

function processCsvFile(filePath, username) {
    const rows = [];
    fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.toLowerCase() }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath); // Clean up the uploaded file
            logger.info(`Adding ${rows.length} group creation tasks to queue for user ${username}.`);
            
            let queuedCount = 0;
            let failedToQueueCount = 0;

            for (const [index, row] of rows.entries()) {
                try {
                    const groupName = row.group_name || `Group ${Date.now()}`;
                    const adminNumber = row.admin_number;
                    const memberNumbers = (row.member_numbers || '').split(',').map(s => s.trim());
                    
                    const allNumbers = [adminNumber, ...memberNumbers].filter(Boolean);
                    if (allNumbers.length === 0) {
                        logger.warn(`Skipping row ${index + 1} due to no valid numbers.`);
                        failedToQueueCount++;
                        continue;
                    }
                    
                    const participants = allNumbers.map(sanitizePhoneNumber).filter(Boolean);
                    const uniqueParticipants = [...new Set(participants)];
                    const adminJid = sanitizePhoneNumber(adminNumber);

                    taskQueue.addTask({
                        username,
                        groupName,
                        participants: uniqueParticipants,
                        adminJid,
                        index: index + 1,
                        total: rows.length
                    });
                    queuedCount++;
                } catch (error) {
                    failedToQueueCount++;
                    logger.error(`Failed to queue row ${index + 1}: ${error.message}`);
                }
            }
            const userSocketId = global.userSockets?.[username];
            if (userSocketId) {
                global.io.to(userSocketId).emit('upload_complete', { 
                    successCount: queuedCount, 
                    failedCount: failedToQueueCount, 
                    total: rows.length 
                });
            }
        });
}


// Log File Management (no changes needed here)
exports.listLogs = (req, res) => {
    const logDir = path.join(config.paths.data, 'invite-logs');
    const username = req.session.user.username;

    fs.readdir(logDir, (err, files) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(200).json([]);
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
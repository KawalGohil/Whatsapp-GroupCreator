const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('../services/whatsappService');
const taskQueue = require('../services/taskQueue');
const logger = require('../utils/logger');
const { createGroup } = require('../services/groupCreationService');
const { writeInviteLog } = require('../utils/inviteLogger');
const config =require('../../config');

const sanitizePhoneNumber = (num) => {
    if (!num) return null;
    const cleaned = String(num).replace(/\D/g, '');
    if (cleaned.length >= 11) return `${cleaned}@s.whatsapp.net`;
    if (cleaned.length === 10) return `91${cleaned}@s.whatsapp.net`; // Assuming Indian numbers if 10 digits
    logger.warn(`Skipping invalid or incomplete phone number: ${num}`);
    return null;
};

const processAndValidateCsv = (filePath) => {
    return new Promise((resolve, reject) => {
        const rows = [];
        const requiredHeaders = ['contact', 'booking_id', 'property_name', 'check_in', 'admin_number'];
        const stream = fs.createReadStream(filePath)
            .pipe(csv({
                mapHeaders: ({ header }) => header.toLowerCase().replace(/[\s-]+/g, '_')
            }));

        stream.on('headers', (headers) => {
            const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));
            if (missingHeaders.length > 0) {
                stream.destroy();
                return reject(new Error(`Invalid CSV format. Missing columns: ${missingHeaders.join(', ')}`));
            }
        });

        stream.on('data', (data) => rows.push(data));
        stream.on('end', () => resolve(rows));
        stream.on('error', (err) => reject(err));
    });
};

exports.uploadContacts = async (req, res) => {
    const username = req.session.user.username;
    logger.info(`[User: ${username}] Received HTTP request to upload file: ${req.file?.originalname}`);
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }

    const filePath = req.file.path;

    try {
        // --- ✨ THE FIX IS HERE ✨ ---
        // Changed 'const' to 'let' to allow the variable to be reassigned.
        let rows = await processAndValidateCsv(filePath);
        // --- End of Fix ---
        
        fs.unlinkSync(filePath); // Clean up the file after successful processing
        
        // This filter for empty rows will now work correctly.
        rows = rows.filter(row => Object.values(row).some(val => val && val.trim() !== ''));
        
        const batchId = uuidv4();
        
        res.status(202).json({
            message: 'File format is valid. Queuing groups for creation.',
            batchId: batchId,
            total: rows.length
        });
        
        let queuedCount = 0;
        for (const [index, row] of rows.entries()) {
            const groupName = `${row.booking_id} - ${row.property_name} - ${row.check_in}`;
            const participants = [...new Set([row.admin_number, row.sem_number, row.contact].filter(Boolean).map(sanitizePhoneNumber).filter(Boolean))];
            
            if (participants.length < 2) {
                // Pass batchId to the log function
                writeInviteLog(username, groupName, '', 'Failed', `Skipped: Not enough valid members found (${participants.length}).`, batchId);
                continue;
            }
            
            queuedCount++;
            taskQueue.addTask({
                username, groupName, participants, batchId,
                adminJid: sanitizePhoneNumber(row.admin_number),
                index: index + 1,
                total: rows.length,
            });
        }
        
        if (rows.length > 0 && queuedCount === 0) {
            const userSocketId = global.userSockets?.[username];
            if (userSocketId) {
                global.io.to(userSocketId).emit('batch_complete', {
                    successCount: 0, failedCount: rows.length, total: rows.length, batchId: batchId
                });
            }
        }
    } catch (error) {
        logger.error(`[User: ${username}] CSV processing failed: ${error.message}`);
        res.status(400).json({ message: 'The CSV file could not be processed. Please check the file format and content.' });
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath); // Ensure cleanup on failure
        }
    }
};

exports.createManualGroup = async (req, res) => {
    const { groupName, numbers, desiredAdminNumber } = req.body;
    // Check if user exists on the session before destructuring
    if (!req.session.user) {
        return res.status(401).json({ message: 'You are not logged in.' });
    }
    const { username, jid: userJid } = req.session.user; // Get username and JID from session
    const sock = getClient(username);

    logger.info(`[User: ${username}] Received manual group creation request for group: "${groupName}"`);

    if (!sock) {
        return res.status(400).json({ message: 'WhatsApp client not ready. Please wait or re-login.' });
    }
    if (!userJid) {
        logger.error(`[User: ${username}] User JID not found in session. Cannot add creator to group.`);
        return res.status(500).json({ message: 'Could not identify group creator. Please re-login.' });
    }
    if (!groupName || !numbers) {
        return res.status(400).json({ message: 'Group name and at least one member\'s number are required.' });
    }

    try {
        let participants = numbers.split(/[,\n]/).map(sanitizePhoneNumber).filter(Boolean);
        participants.push(userJid);
        
        participants = [...new Set(participants)];

        if (participants.length < 2) {
            const reason = 'A group needs at least one valid member besides the creator.';
            logger.warn(`[User: ${username}] Manual group "${groupName}" skipped. ${reason}`);
            writeInviteLog(username, groupName, '', 'Failed', `Skipped: ${reason}`);
            return res.status(400).json({ message: reason });
        }

        const adminJid = sanitizePhoneNumber(desiredAdminNumber);
        await createGroup(sock, username, groupName, participants, adminJid);
        res.status(200).json({ message: `Group "${groupName}" creation initiated.` });

    } catch (error) {
        logger.error(`Manual group creation failed for ${username}:`, error);
        res.status(500).json({ message: error.message });
    }
};

exports.listLogs = (req, res) => {
    const logDir = path.join(config.paths.data, 'invite-logs');
    if (!req.session.user) {
        return res.status(401).json({ message: 'You are not logged in.' });
    }
    const username = req.session.user.username;

    fs.readdir(logDir, (err, files) => {
        if (err) {
            if (err.code === 'ENOENT') return res.status(200).json([]);
            logger.error(`Could not list log files for user ${username}:`, err);
            return res.status(500).json({ message: 'Error accessing log files.' });
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
    if (!req.session.user) {
        return res.status(401).json({ message: 'You are not logged in.' });
    }
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
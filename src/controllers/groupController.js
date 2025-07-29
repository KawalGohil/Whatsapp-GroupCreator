const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('../services/whatsappService');
const taskQueue = require('../services/taskQueue');
const logger = require('../utils/logger');
const { createGroup } = require('../services/groupCreationService');
const { writeInviteLog } = require('../utils/inviteLogger');
// --- THIS IS THE FIX ---
// Added the missing import for the config file
const config = require('../../config');

const sanitizePhoneNumber = (num) => {
    if (!num) return null;
    const cleaned = String(num).replace(/\D/g, '');
    if (cleaned.length >= 11) return `${cleaned}@s.whatsapp.net`;
    if (cleaned.length === 10) return `91${cleaned}@s.whatsapp.net`;
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
        const rows = await processAndValidateCsv(filePath);
        fs.unlinkSync(filePath); // Clean up the file after successful processing

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
                writeInviteLog(username, groupName, '', 'Failed', `Skipped: Not enough valid members found (${participants.length}).`);
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
        res.status(400).json({ message: error.message });
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath); // Ensure cleanup on failure
        }
    }
};


// --- Manual Group Creation and Log functions are unchanged ---
exports.createManualGroup = async (req, res) => {
    const { groupName, numbers, desiredAdminNumber } = req.body;
    const username = req.session.user.username;
    const sock = getClient(username);
    logger.info(`[User: ${username}] Received manual group creation request for group: "${req.body.groupName}"`);
    if (!sock) return res.status(400).json({ message: 'WhatsApp client not ready. Please wait or re-login.' });
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
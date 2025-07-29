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

const readCsvPromise = (filePath) => {
    return new Promise((resolve, reject) => {
        const rows = [];
        const mapHeaders = ({ header }) => header.toLowerCase().replace(/[\s-]+/g, '_');
        fs.createReadStream(filePath)
            .pipe(csv({ mapHeaders }))
            .on('data', (data) => rows.push(data))
            .on('end', () => {
                fs.unlinkSync(filePath);
                resolve(rows);
            })
            .on('error', (err) => reject(err));
    });
};

exports.uploadContacts = async (req, res) => {
    const username = req.session.user.username;
    logger.info(`[User: ${username}] Received CSV upload request.`);
    if (!req.file) {
        logger.warn(`[User: ${username}] CSV upload failed: No file provided.`);
        return res.status(400).json({ message: 'No file uploaded.' });
    }

    try {
        logger.info(`[User: ${username}] Validating CSV headers for file: ${req.file.originalname}`);
        await validateCsvHeaders(req.file.path);
        logger.info(`[User: ${username}] CSV headers are valid.`);

        const rows = await readCsvPromise(req.file.path);
        const batchId = uuidv4();
        
        logger.info(`[User: ${username}] Responding to client with batchId: ${batchId} for ${rows.length} rows.`);
        res.status(202).json({
            message: 'File format is valid. Queuing groups for creation.',
            batchId: batchId,
            total: rows.length
        });
        
        let queuedCount = 0;
        logger.info(`[User: ${username}] [Batch: ${batchId}] Starting to process ${rows.length} rows.`);
        for (const [index, row] of rows.entries()) {
            // ... (group name and participant logic is unchanged)
            
            if (participants.length < 2) {
                logger.warn(`[User: ${username}] [Batch: ${batchId}] Skipping group "${groupName}": requires at least 2 valid members, but found ${participants.length}.`);
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
        logger.info(`[User: ${username}] [Batch: ${batchId}] Finished processing rows. Queued tasks: ${queuedCount}/${rows.length}.`);
        // --- THIS IS THE FIX ---
        // If the file had rows but nothing was queued, it means all rows were invalid.
        // We must manually inform the UI that this "batch" is complete.
        if (rows.length > 0 && queuedCount === 0) {
            logger.info(`Batch ${batchId} for user ${username} had no valid rows to queue. Notifying UI.`);
            const userSocketId = global.userSockets?.[username];
            if (userSocketId) {
                global.io.to(userSocketId).emit('batch_complete', {
                    successCount: 0,
                    failedCount: rows.length, // All rows failed
                    total: rows.length,
                    batchId: batchId
                });
            }
        }
        
    } catch (error) {
        logger.error('Error processing CSV file:', error);
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
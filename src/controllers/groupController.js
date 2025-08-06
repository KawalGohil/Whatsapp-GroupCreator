const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('../services/whatsappService');
const taskQueue = require('../services/taskQueue');
const logger = require('../utils/logger');
const { createGroup } = require('../services/groupCreationService');
const { writeInviteLog } = require('../utils/inviteLogger');
const config = require('../../config');

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
        const requiredHeaders = ['booking_id', 'property_name', 'check_in_date', 'customer_number', 'admin_number'];
        const stream = fs.createReadStream(filePath)
            .pipe(csv({
                mapHeaders: ({ header }) => header.toLowerCase().replace(/[\s-]+/g, '_'),
                bom: true
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
        let rows = await processAndValidateCsv(filePath);
        fs.unlinkSync(filePath); // Clean up the file after successful processing
        
        rows = rows.filter(row => Object.values(row).some(val => val && val.trim() !== ''));
        
        const batchId = uuidv4();
        
        res.status(202).json({
            message: 'File format is valid. Queuing groups for creation.',
            batchId: batchId,
            total: rows.length
        });
        
        let queuedCount = 0;
        for (const [index, row] of rows.entries()) {
            const groupName = `${row.booking_id} - ${row.property_name} - ${row.check_in_date}`;
            
            const participantsToInvite = [];
            if (row['customer_number']) {
                const sanitizedCustomer = sanitizePhoneNumber(row['customer_number']);
                if (sanitizedCustomer) {
                    participantsToInvite.push(sanitizedCustomer);
                }
            }

            const directAddParticipants = new Set();
            // Add all other numbers for direct addition
            ['admin_number', 'optional_1', 'optional_2', 'optional_3', 'optional_4', 'optional_5'].forEach(key => {
                if (row[key]) {
                    const sanitized = sanitizePhoneNumber(row[key]);
                    if (sanitized) {
                        directAddParticipants.add(sanitized);
                    }
                }
            });

            // Combine the lists for the task, but we'll handle them differently in groupCreationService
            const allParticipants = [...Array.from(directAddParticipants), ...participantsToInvite];

            if (allParticipants.length < 2) {
                writeInviteLog(username, groupName, '', 'Failed', `Skipped: Not enough valid members found (${allParticipants.length}).`, batchId);
                continue;
            }
            
            queuedCount++;
            taskQueue.addTask({
                username, 
                groupName, 
                participants: allParticipants, 
                inviteOnlyJids: participantsToInvite, // Pass the list of invite-only numbers
                batchId,
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
    if (!req.session.user) {
        return res.status(401).json({ message: 'You are not logged in.' });
    }
    // START: Add inviteNumbers to the destructuring
    const { groupName, numbers, desiredAdminNumber, inviteNumbers } = req.body;
    const { username, jid: userJid } = req.session.user;
    const sock = getClient(username);

    logger.info(`[User: ${username}] Received manual group creation request for group: "${groupName}"`);

    if (!sock) {
        return res.status(400).json({ message: 'WhatsApp client not ready. Please wait or re-login.' });
    }
    if (!userJid) {
        logger.error(`[User: ${username}] User JID not found in session. Cannot add creator to group.`);
        return res.status(500).json({ message: 'Could not identify group creator. Please re-login.' });
    }
    // Updated condition to check both number fields
    if (!groupName || (!numbers && !inviteNumbers)) {
        return res.status(400).json({ message: 'Group name and at least one participant number are required.' });
    }

    try {
        // Process direct-add numbers
        let directAddParticipants = numbers ? numbers.split(/[,\n]/).map(sanitizePhoneNumber).filter(Boolean) : [];
        directAddParticipants.push(userJid); // Always add the creator
        
        // Process invite-only numbers
        let inviteOnlyParticipants = inviteNumbers ? inviteNumbers.split(/[,\n]/).map(sanitizePhoneNumber).filter(Boolean) : [];

        // Combine for validation and task queuing
        let allParticipants = [...new Set([...directAddParticipants, ...inviteOnlyParticipants])];

        if (allParticipants.length < 2) {
            const reason = 'A group needs at least one valid member besides the creator.';
            logger.warn(`[User: ${username}] Manual group "${groupName}" skipped. ${reason}`);
            writeInviteLog(username, groupName, '', 'Failed', `Skipped: ${reason}`);
            return res.status(400).json({ message: reason });
        }

        const adminJid = sanitizePhoneNumber(desiredAdminNumber);

        // The createGroup function is already set up to handle this!
        const resultStatus = await createGroup(sock, username, groupName, allParticipants, adminJid, null, inviteOnlyParticipants);

        switch (resultStatus) {
            case 'success':
                return res.status(200).json({ message: `Group "${groupName}" was created successfully.` });
            case 'skipped':
                return res.status(200).json({ message: `Skipped: Group "${groupName}" already exists.` });
            case 'failed':
                return res.status(500).json({ message: `Failed to create group "${groupName}". Check logs for details.` });
            default:
                return res.status(202).json({ message: `Group "${groupName}" creation process initiated.` });
        }

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

    // This check prevents errors if the directory doesn't exist yet.
    if (!fs.existsSync(logDir)) {
        return res.status(200).json([]);
    }

    fs.readdir(logDir, (err, files) => {
        if (err) {
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
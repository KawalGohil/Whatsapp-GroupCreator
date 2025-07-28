const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { v4: uuidv4 } = require('uuid'); // Import UUID to create a unique ID for each batch
const { getClient } = require('../services/whatsappService');
const taskQueue = require('../services/taskQueue');
const logger = require('../utils/logger');
const config = require('../../config');
const { createGroup } = require('../services/groupCreationService');

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


function processCsvFile(filePath, username) {
    const rows = [];
    const mapHeaders = ({ header }) => header.toLowerCase().replace(/[\s-]+/g, '_');

    fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders }))
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            fs.unlinkSync(filePath);
            
            // --- THIS IS THE FIX for UI SYNC ---
            // Create a unique ID for this specific batch of tasks.
            const batchId = uuidv4();
            logger.info(`Queuing ${rows.length} tasks for user ${username} with batch ID: ${batchId}`);
            
            for (const [index, row] of rows.entries()) {
                // ... (logic to create groupName and participants)
                const bookingId = row.booking_id;
                const propertyName = row.property_name;
                const checkIn = row.check_in;
                
                let groupName;
                if (bookingId && propertyName && checkIn) {
                    groupName = `${bookingId} - ${propertyName} - ${checkIn}`;
                } else {
                    groupName = `Group_Row_${index + 1}_${Date.now()}`;
                }
                
                const adminNumber = row.admin_number;
                const semNumber = row.sem_number;
                const contactNumber = row.contact;
                
                const allNumbers = [adminNumber, semNumber, contactNumber].filter(Boolean);
                const participants = [...new Set(allNumbers.map(sanitizePhoneNumber).filter(Boolean))];
                const adminJid = sanitizePhoneNumber(adminNumber);

                if (participants.length > 0) {
                    taskQueue.addTask({
                        username,
                        groupName,
                        participants,
                        adminJid,
                        index: index + 1,
                        total: rows.length,
                        batchId // Associate each task with this batch
                    });
                }
            }
            // The 'upload_complete' event is no longer sent from here.
            // It will be sent by the whatsappService when the batch is truly finished.
        });
}

// Manual Group Creation (No changes)
exports.createManualGroup = async (req, res) => {
    const { groupName, numbers, desiredAdminNumber } = req.body;
    const username = req.session.user.username;
    const sock = getClient(username);

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

// Upload Contacts (No changes)
exports.uploadContacts = (req, res) => {
    const username = req.session.user.username;
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded.' });
    }
    res.status(202).json({ message: 'File queued. Groups will be created in the background.' });
    processCsvFile(req.file.path, username);
};


// Log File Management (no changes)
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
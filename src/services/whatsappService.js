const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');
const pino = require('pino');

const activeClients = {};
const processingUsers = new Set();
const batchTrackers = {};

async function startBaileysClient(username) {
    if (activeClients[username]) {
        logger.info(`Client for ${username} is already initializing or connected.`);
        return;
    }

    logger.info(`Initializing Baileys client for user: ${username}`);
    const sessionPath = path.join(config.paths.session, username);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'silent' })
    });

    activeClients[username] = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        const userSocketId = global.userSockets?.[username];

        if (qr && userSocketId) {
            global.io.to(userSocketId).emit('qr', qr);
        }
        
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error(`Connection for ${username} closed. Reconnecting: ${shouldReconnect}`);
            
            delete activeClients[username];
            if (shouldReconnect) {
                setTimeout(() => startBaileysClient(username), 5000);
            } else {
                // --- THIS IS THE FIX ---
                // If the reason for closing is a logout, automatically delete the session folder.
                logger.error(`${username} was logged out. Clearing session data to force a new QR scan on next login.`);
                if (fs.existsSync(sessionPath)) {
                    fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                        if (err) {
                            logger.error(`Failed to delete session folder for ${username}:`, err);
                        } else {
                            logger.info(`Successfully deleted session folder for ${username}.`);
                        }
                    });
                }
            }
        } else if (connection === 'open') {
            logger.info(`Client for ${username} connected successfully.`);
            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
            setTimeout(() => processQueueForUser(username), 500);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ... (The rest of the file remains unchanged)

function getClient(username) {
    return activeClients[username];
}

async function closeBaileysClient(username) {
    const sock = activeClients[username];
    if (sock) {
        logger.info(`Closing Baileys client for ${username}.`);
        await sock.logout();
        delete activeClients[username];
    }
}

async function processQueueForUser(username) {
    if (processingUsers.has(username)) {
        return;
    }

    const client = getClient(username);
    if (!client || !client.user) {
        return;
    }

    processingUsers.add(username);
    logger.info(`Starting queue processing for user: ${username}`);

    try {
        while (true) {
            const taskIndex = taskQueue.queue.findIndex(t => t.username === username);
            if (taskIndex === -1) break;

            const [task] = taskQueue.queue.splice(taskIndex, 1);
            
            // --- THIS IS THE FIX for UI SYNC ---
            // Initialize a tracker for the batch if it's the first task
            if (!batchTrackers[task.batchId]) {
                batchTrackers[task.batchId] = {
                    total: task.total,
                    processed: 0,
                    successCount: 0,
                    failedCount: 0,
                };
            }

            let success = false;
            try {
                await createGroup(client, task.username, task.groupName, task.participants, task.adminJid);
                success = true;
            } catch (error) {
                logger.error(`Task failed for group "${task.groupName}": ${error.message}`);
            }

            // Update batch progress
            const tracker = batchTrackers[task.batchId];
            tracker.processed++;
            if (success) tracker.successCount++;
            else tracker.failedCount++;
            
            const userSocketId = global.userSockets?.[task.username];
            if (userSocketId) {
                global.io.to(userSocketId).emit('upload_progress', {
                    current: tracker.processed, total: tracker.total, currentGroup: task.groupName
                });
            }

            // If all tasks in the batch are processed, send the final confirmation
            if (tracker.processed === tracker.total) {
                if (userSocketId) {
                    global.io.to(userSocketId).emit('batch_complete', {
                        successCount: tracker.successCount,
                        failedCount: tracker.failedCount,
                        total: tracker.total,
                    });
                }
                delete batchTrackers[task.batchId]; // Clean up tracker
            }
        }
    } finally {
        processingUsers.delete(username);
        logger.info(`Finished queue processing for user: ${username}`);
    }
}

taskQueue.on('new_task', (username) => {
    processQueueForUser(username);
});

module.exports = { 
    startBaileysClient,
    getClient,
    closeBaileysClient
};
// src/services/whatsappService.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');
const pino = require('pino');
const { readState } = require('../utils/stateManager');
const { writeInviteLog } = require('../utils/inviteLogger');

const activeClients = {};
const processingUsers = new Set();
const batchTrackers = {};

async function startBaileysClient(username, session) { // 1. Accept `session` as an argument
    if (activeClients[username]) {
        logger.info(`Client for ${username} is already initializing or connected.`);
        return;
    }

    logger.info(`Initializing Baileys client for user: ${username}`);
    const sessionPath = path.join(config.paths.session, username);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'silent' })
    });

    activeClients[username] = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        const userSocketId = global.userSockets?.[username];

        if (qr && userSocketId) {
            logger.info(`[User: ${username}] QR code generated. Emitting 'qr' event to socket ID ${userSocketId}.`);
            global.io.to(userSocketId).emit('qr', qr);
        }
        
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error(`Connection for ${username} closed. Reconnecting: ${shouldReconnect}`);
            
            delete activeClients[username];
            if (shouldReconnect) {
                // Pass the session object during reconnection attempts as well
                setTimeout(() => startBaileysClient(username, session), 5000);
            } else {
                logger.error(`${username} was logged out. Clearing session data.`);
                if (fs.existsSync(sessionPath)) {
                    fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                        if (err) logger.error(`Failed to delete session folder for ${username}:`, err);
                        else logger.info(`Successfully deleted session folder for ${username}.`);
                    });
                }
            }
        } else if (connection === 'open') {
            logger.info(`Client for ${username} connected successfully.`);
            
            // --- ✨ THE FIX IS HERE ✨ ---
            // 2. Get the JID and update the session object passed from the login controller.
            const jid = sock.user.id;
            if (session && session.user) {
                session.user.jid = jid;
                // 3. Save the session so the JID is persisted.
                session.save(err => {
                    if (err) {
                        logger.error(`[User: ${username}] Failed to save session with JID:`, err);
                    } else {
                        logger.info(`[User: ${username}] JID ${jid} successfully saved to session.`);
                    }
                });
            } else {
                logger.warn(`[User: ${username}] Session object not available. Cannot save JID.`);
            }
            // --- End of Fix ---

            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
            // Assuming processQueueForUser is defined elsewhere
            // setTimeout(() => processQueueForUser(username), 500);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

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
    if (processingUsers.has(username)) return;

    const client = getClient(username);
    if (!client || !client.user) {
        logger.warn(`[User: ${username}] Client not ready. Queue processing paused.`);
        return;
    }

    processingUsers.add(username);
    logger.info(`Starting queue processing for user: ${username}`);

    try {
        while (true) {
            const taskIndex = taskQueue.queue.findIndex(t => t.username === username);
            if (taskIndex === -1) break; // No more tasks for this user

            const [task] = taskQueue.queue.splice(taskIndex, 1);
            const userSocketId = global.userSockets?.[task.username];

            // Initialize tracker for this batch if it's the first task
            if (!batchTrackers[task.batchId]) {
                batchTrackers[task.batchId] = {
                    total: task.total, processed: 0, successCount: 0, failedCount: 0,
                };
            }
            const tracker = batchTrackers[task.batchId];

            const state = readState();
            // Check if the group already exists
            if (state.createdGroups[task.username]?.[task.groupName]) {
                const reason = 'Group already exists';
                logger.info(`Group "${task.groupName}" already created. Skipping.`);

                // --- ✨ THE FIX (Part 1) ✨ ---
                // Log the skipped group to your CSV file
                writeInviteLog(task.username, task.groupName, '', 'Skipped', reason, task.batchId);
                // --- End of Fix ---

                tracker.processed++;
                tracker.failedCount++; // Count skips as "failed" for reporting

                if (userSocketId) {
                    global.io.to(userSocketId).emit('upload_progress', {
                        current: tracker.processed, total: tracker.total,
                        currentGroup: `${task.groupName} (Skipped)`,
                        batchId: task.batchId
                    });
                }
            } else {
                // This block handles creating NEW groups
                let success = false;
                try {
                    // Pass batchId to createGroup so it can be used in deeper logs if needed
                    await createGroup(client, task.username, task.groupName, task.participants, task.adminJid, task.batchId);
                    success = true;
                } catch (error) {
                    logger.error(`Task failed for group "${task.groupName}": ${error.message}`);
                    // The error is already logged inside createGroup, so no need to log it here again.
                }
                
                tracker.processed++;
                if (success) tracker.successCount++;
                else tracker.failedCount++;

                if (userSocketId) {
                    global.io.to(userSocketId).emit('upload_progress', {
                        current: tracker.processed, total: tracker.total,
                        currentGroup: task.groupName,
                        batchId: task.batchId
                    });
                }
            }

            // --- ✨ THE FIX (Part 2) ✨ ---
            // Check if the batch is complete and notify the UI
            if (tracker.processed === tracker.total) {
                if (userSocketId) {
                    global.io.to(userSocketId).emit('batch_complete', {
                        successCount: tracker.successCount,
                        failedCount: tracker.failedCount,
                        total: tracker.total,
                        batchId: task.batchId
                    });
                }
                logger.info(`Batch ${task.batchId} completed for ${task.username}. Success: ${tracker.successCount}, Failed/Skipped: ${tracker.failedCount}`);
                delete batchTrackers[task.batchId]; // Clean up tracker
            }
            // --- End of Fix ---
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
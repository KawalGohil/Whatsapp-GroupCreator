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

// These are module-level variables to track state across the application
const activeClients = {};
const processingUsers = new Set();
const batchTrackers = {};

/**
 * Initializes and starts the Baileys WhatsApp client for a user.
 * This is the main entry point for connecting to WhatsApp.
 */
async function startBaileysClient(username, session) {
    // Prevent starting a client if one is already running or initializing
    if (activeClients[username]) {
        logger.info(`[User: ${username}] Client is already running or initializing.`);
        return;
    }

    logger.info(`Initializing Baileys client for user: ${username}`);
    const sessionPath = path.join(config.paths.session, username);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({ auth: state, browser: Browsers.macOS('Desktop'), logger: pino({ level: 'silent' }) });
    activeClients[username] = sock;

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Main connection logic handler
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
                // Pass the session object again on reconnection attempts
                setTimeout(() => startBaileysClient(username, session), 5000);
            } else {
                logger.error(`${username} was logged out. Clearing session data.`);
                if (fs.existsSync(sessionPath)) {
                    fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                        if (err) logger.error(`Failed to delete session folder for ${username}:`, err);
                    });
                }
            }
        } else if (connection === 'open') {
            logger.info(`Client for ${username} connected successfully.`);
            
            // --- FIX #1: RELIABLY SAVE JID TO SESSION ---
            // This happens as soon as the connection is open, fixing manual creation.
            const jid = sock.user.id;
            if (session && session.user) {
                session.user.jid = jid;
                session.save(err => {
                    if (err) logger.error(`[User: ${username}] Failed to save session with JID:`, err);
                    else logger.info(`[User: ${username}] JID ${jid} successfully saved to session.`);
                });
            }

            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
            
            // --- FIX #2: TRIGGER QUEUE PROCESSING ---
            // This is the key fix for the stuck UI. It ensures any tasks that were queued
            // while the client was connecting are now processed immediately.
            processQueueForUser(username);
        }
    });
}

/**
 * Listens for new tasks and attempts to start the queue processor.
 */
taskQueue.on('new_task', (username) => {
    logger.info(`[User: ${username}] New task detected, attempting to process queue.`);
    processQueueForUser(username);
});

/**
 * Retrieves the active Baileys client for a given user.
 */
function getClient(username) {
    return activeClients[username];
}

/**
 * Gracefully logs out and closes the Baileys client.
 */
async function closeBaileysClient(username) {
    const sock = activeClients[username];
    if (sock) {
        logger.info(`Closing Baileys client for ${username}.`);
        await sock.logout();
        delete activeClients[username];
    }
}

/**
 * Processes the task queue for a specific user.
 * This function now correctly handles all states, including skipped groups.
 */
async function processQueueForUser(username) {
    if (processingUsers.has(username)) return;

    const client = getClient(username);
    // This guard is crucial. It prevents the function from running if the client
    // isn't fully connected, solving the race condition.
    if (!client || !client.user) {
        logger.warn(`[User: ${username}] Client not ready. Queue processing will wait for connection.`);
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

            // Initialize a tracker for this batch if it's the first task
            if (!batchTrackers[task.batchId]) {
                batchTrackers[task.batchId] = { total: task.total, processed: 0, successCount: 0, failedCount: 0 };
            }
            const tracker = batchTrackers[task.batchId];

            const state = readState();
            // Handle groups that already exist
            if (state.createdGroups[task.username]?.[task.groupName]) {
                const reason = 'Group already exists';
                logger.info(`Group "${task.groupName}" already created. Skipping.`);
                
                // This correctly logs the skipped group to your CSV file
                writeInviteLog(task.username, task.groupName, '', 'Skipped', reason, task.batchId);
                
                tracker.processed++;
                tracker.failedCount++;
                if (userSocketId) {
                    global.io.to(userSocketId).emit('batch_progress', {
                        current: tracker.processed, total: tracker.total,
                        currentGroup: `${task.groupName} (Skipped)`,
                        batchId: task.batchId
                    });
                }
            } else {
                // Handle new group creation
                let success = false;
                try {
                    await createGroup(client, task.username, task.groupName, task.participants, task.adminJid, task.batchId);
                    success = true;
                } catch (error) {
                    logger.error(`Task failed for group "${task.groupName}": ${error.message}`);
                }
                
                tracker.processed++;
                if (success) tracker.successCount++;
                else tracker.failedCount++;

                if (userSocketId) {
                    global.io.to(userSocketId).emit('batch_progress', {
                        current: tracker.processed, total: tracker.total,
                        currentGroup: task.groupName, batchId: task.batchId
                    });
                }
            }

            // Check if the batch is complete and notify the UI
            if (tracker.processed === tracker.total) {
                if (userSocketId) {
                    global.io.to(userSocketId).emit('batch_complete', {
                        successCount: tracker.successCount, failedCount: tracker.failedCount,
                        total: tracker.total, batchId: task.batchId
                    });
                }
                delete batchTrackers[task.batchId];
            }
        }
    } finally {
        processingUsers.delete(username);
        logger.info(`Finished queue processing for user: ${username}`);
    }
}


module.exports = { 
    startBaileysClient,
    getClient,
    closeBaileysClient
};
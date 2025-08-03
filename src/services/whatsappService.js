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
const initialContactsSyncDone = new Set(); // To track contact sync status

async function startBaileysClient(username, session) {
    if (activeClients[username] && activeClients[username].user) {
        logger.info(`Client for ${username} is already connected and ready.`);
        const jid = activeClients[username].user.id;
        if (session && session.user && session.user.jid !== jid) {
            session.user.jid = jid;
            session.save(err => {
                if (err) {
                    logger.error(`[User: ${username}] Failed to update session with JID on re-login:`, err);
                } else {
                    logger.info(`[User: ${username}] Session updated with existing JID: ${jid}.`);
                }
            });
        }
        return;
    }

    if (activeClients[username]) {
        logger.info(`[User: ${username}] Client is already initializing. No action needed.`);
        return;
    }

    logger.info(`Initializing Baileys client for user: ${username}`);
    const sessionPath = path.join(config.paths.session, username);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({ auth: state, browser: Browsers.macOS('Desktop'), logger: pino({ level: 'silent' }) });
    activeClients[username] = sock;
    sock.contacts = {};

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.set', ({ contacts }) => {
        for (const contact of contacts) {
            sock.contacts[contact.id] = contact;
        }
        logger.info(`[User: ${username}] Initial contacts sync complete. Total contacts: ${Object.keys(sock.contacts).length}`);
        if (!initialContactsSyncDone.has(username)) {
            initialContactsSyncDone.add(username);
            logger.info(`[User: ${username}] Triggering queue processing after contact sync.`);
            processQueueForUser(username);
        }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            sock.contacts[contact.id] = contact;
        }
    });

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
            initialContactsSyncDone.delete(username); // Reset sync status
            if (shouldReconnect) {
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

            const jid = sock.user.id;
            if (session && session.user) {
                session.user.jid = jid;
                session.save(err => {
                    if (err) logger.error(`[User: ${username}] Failed to save session with JID:`, err);
                    else logger.info(`[User: ${username}] JID ${jid} successfully saved to new session.`);
                });
            }

            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
        }
    });
}

taskQueue.on('new_task', (username) => {
    logger.info(`[User: ${username}] New task detected. Queue will start processing shortly.`);
    setTimeout(() => {
        processQueueForUser(username);
    }, 200);
});

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
        logger.warn(`[User: ${username}] Client not ready. Queue processing will wait for connection.`);
        return;
    }

    processingUsers.add(username);
    logger.info(`Starting queue processing for user: ${username}`);

    try {
        while (true) {
            const taskIndex = taskQueue.queue.findIndex(t => t.username === username);
            if (taskIndex === -1) break;

            const [task] = taskQueue.queue.splice(taskIndex, 1);
            const userSocketId = global.userSockets?.[task.username];

            if (!batchTrackers[task.batchId]) {
                batchTrackers[task.batchId] = { total: task.total, processed: 0, successCount: 0, failedCount: 0 };
            }
            const tracker = batchTrackers[task.batchId];

            const state = readState();
            if (state.createdGroups[task.username]?.[task.groupName]) {
                const reason = 'Group already exists';
                logger.info(`Group "${task.groupName}" already created. Skipping.`);
                
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
                let success = false;
                try {
                    await createGroup(client, task.username, task.groupName, task.participants, task.adminJid, task.batchId, task.inviteOnlyJids);
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
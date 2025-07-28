// src/services/whatsappService.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs'); // Import the file system module
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');
const pino = require('pino');

const activeClients = {};
const processingUsers = new Set();

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
        logger.info(`Queue processing is already active for user: ${username}`);
        return;
    }

    const client = getClient(username);
    
    if (!client || !client.user) {
        logger.warn(`Queue check for ${username} triggered, but client is not fully authenticated yet.`);
        return;
    }

    processingUsers.add(username);
    logger.info(`Starting queue processing for user: ${username}`);

    try {
        let taskIndex;
        while ((taskIndex = taskQueue.queue.findIndex(t => t.username === username)) !== -1) {
            const [task] = taskQueue.queue.splice(taskIndex, 1);
            
            logger.info(`Processing group "${task.groupName}"`);

            try {
                await createGroup(client, task.username, task.groupName, task.participants, task.adminJid);
                if (global.userSockets?.[task.username]) {
                    global.io.to(global.userSockets[task.username]).emit('upload_progress', {
                        current: task.index, total: task.total, currentGroup: task.groupName
                    });
                }
            } catch (error) {
                logger.error(`Task failed for group "${task.groupName}": ${error.message}`);
            }
        }
    } finally {
        processingUsers.delete(username);
        logger.info(`Finished queue processing for user: ${username}`);
    }
}

taskQueue.on('new_task', (username) => {
    logger.info(`New task for ${username} received. Triggering queue check.`);
    processQueueForUser(username);
});

module.exports = { 
    startBaileysClient,
    getClient,
    closeBaileysClient
};
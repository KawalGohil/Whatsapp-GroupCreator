// src/services/whatsappService.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');
const pino = require('pino');

const activeClients = {};
const processingUsers = new Set(); // To prevent concurrent processing for the same user

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
            logger.info(`Sending QR code to user ${username}`);
            global.io.to(userSocketId).emit('qr', qr);
        }
        
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error(`Connection for ${username} closed. Reason: ${lastDisconnect?.error?.message}. Reconnecting: ${shouldReconnect}`);
            
            delete activeClients[username];
            if (shouldReconnect) {
                setTimeout(() => startBaileysClient(username), 5000);
            } else {
                logger.error(`${username} logged out of WhatsApp. Session data needs to be cleared manually if re-login is needed.`);
            }
        } else if (connection === 'open') {
            logger.info(`Client for ${username} connected successfully.`);
            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
            // --- FIX: Trigger queue processing when the client is ready ---
            processQueueForUser(username);
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

// --- REVISED AND ROBUST QUEUE PROCESSING LOGIC ---
async function processQueueForUser(username) {
    if (processingUsers.has(username)) {
        logger.info(`Queue processing is already running for user: ${username}`);
        return;
    }

    const client = getClient(username);
    if (!client || client.ws.readyState !== 1) {
        logger.warn(`Attempted to process queue for ${username}, but client is not ready.`);
        return;
    }

    processingUsers.add(username);
    logger.info(`Starting queue processing for user: ${username}`);

    try {
        let taskIndex;
        // Keep processing as long as there are tasks for this user
        while ((taskIndex = taskQueue.queue.findIndex(t => t.username === username)) !== -1) {
            const [task] = taskQueue.queue.splice(taskIndex, 1);

            logger.info(`Processing group "${task.groupName}" for user "${task.username}"`);
            
            try {
                await createGroup(client, task.username, task.groupName, task.participants, task.adminJid);
                
                const userSocketId = global.userSockets?.[task.username];
                if (userSocketId) {
                    global.io.to(userSocketId).emit('upload_progress', {
                        current: task.index,
                        total: task.total,
                        currentGroup: task.groupName
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

// --- FIX: This now triggers the queue for the specific user who added a task ---
taskQueue.on('new_task', (username) => {
    logger.info(`New task added for user: ${username}. Triggering queue check.`);
    processQueueForUser(username);
});

module.exports = { 
    startBaileysClient,
    getClient,
    closeBaileysClient
};
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('../services/taskQueue');
const { createGroup } = require('./groupCreationService');
const pino = require('pino');

const activeClients = {};

async function startBaileysClient(username) {
    if (activeClients[username]) {
        logger.info(`Client for ${username} already exists and is likely connecting.`);
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
            // --- THIS IS THE KEY FIX ---
            // Only start processing the queue once the client for that user is confirmed open.
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

// --- NEW FUNCTION TO PROCESS TASKS FOR A SPECIFIC USER ---
async function processQueueForUser(username) {
    if (taskQueue.isProcessing) return; // A global lock to prevent multiple concurrent processing loops

    const client = getClient(username);
    if (!client || client.ws.readyState !== 1) {
        logger.warn(`Attempted to process queue for ${username}, but client is not ready.`);
        return;
    }

    taskQueue.isProcessing = true;
    logger.info(`Starting queue processing for user: ${username}`);

    try {
        while (taskQueue.queue.length > 0) {
            const taskIndex = taskQueue.queue.findIndex(t => t.username === username);
            
            if (taskIndex === -1) {
                // No more tasks for this user, break the loop
                break;
            }
            
            // Extract the task using splice
            const [task] = taskQueue.queue.splice(taskIndex, 1);

            logger.info(`Processing task for group "${task.groupName}" for user "${task.username}"`);
            
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
                logger.error(`Failed to process task for group "${task.groupName}": ${error.message}`);
            }
        }
    } finally {
        taskQueue.isProcessing = false;
        logger.info(`Finished queue processing for user: ${username}`);
    }
}

// When a new task is added, we don't process immediately.
// We wait for the client to be ready.
taskQueue.on('new_task', () => {
    logger.info('New task added to the queue.');
});


module.exports = { 
    startBaileysClient,
    getClient,
    closeBaileysClient
};
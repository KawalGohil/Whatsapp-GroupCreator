// src/services/whatsappService.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path =require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');

const activeClients = {};

async function startBaileysClient(username) {
    if (activeClients[username]) {
        logger.info(`Client for ${username} already exists.`);
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
                logger.error(`${username} logged out of WhatsApp. Session data will be cleared.`);
                // Clean up the session directory if logged out
                // fs.rmdirSync(sessionPath, { recursive: true });
            }
        } else if (connection === 'open') {
            logger.info(`Client for ${username} connected successfully.`);
            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
            // Trigger queue processing for this user
            processQueue();
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

async function processQueue() {
    if (taskQueue.isProcessing || taskQueue.queue.length === 0) {
        return;
    }
    
    const task = taskQueue.queue[0]; // Peek at the task without removing it
    const client = getClient(task.username);

    // Only process if the user's client is connected and ready
    if (!client || client.ws.readyState !== 1) {
        logger.warn(`Client for ${task.username} not ready. Queue processing paused for this user.`);
        return;
    }

    taskQueue.isProcessing = true;
    taskQueue.getNextTask(); // Now remove the task

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
    } finally {
        taskQueue.isProcessing = false;
        process.nextTick(processQueue);
    }
}

taskQueue.on('new_task', processQueue);

module.exports = { 
    startBaileysClient,
    getClient,
    closeBaileysClient
};
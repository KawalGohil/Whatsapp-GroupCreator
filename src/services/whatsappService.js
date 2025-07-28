// src/services/whatsappService.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');
const pino = require('pino'); // --- FIX: Add this line to import pino ---

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
            }
        } else if (connection === 'open') {
            logger.info(`Client for ${username} connected successfully.`);
            if (userSocketId) {
                global.io.to(userSocketId).emit('status', 'Client is ready!');
            }
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
    
    const task = taskQueue.queue[0];
    const client = getClient(task.username);

    if (!client || client.ws.readyState !== 1) {
        logger.warn(`Client for ${task.username} not ready. Queue processing paused for this user.`);
        return;
    }

    taskQueue.isProcessing = true;
    const confirmedTask = taskQueue.getNextTask();

    logger.info(`Processing task for group "${confirmedTask.groupName}" for user "${confirmedTask.username}"`);

    try {
        await createGroup(client, confirmedTask.username, confirmedTask.groupName, confirmedTask.participants, confirmedTask.adminJid);
        
        const userSocketId = global.userSockets?.[confirmedTask.username];
        if (userSocketId) {
            global.io.to(userSocketId).emit('upload_progress', {
                current: confirmedTask.index,
                total: confirmedTask.total,
                currentGroup: confirmedTask.groupName
            });
        }
    } catch (error) {
        logger.error(`Failed to process task for group "${confirmedTask.groupName}": ${error.message}`);
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
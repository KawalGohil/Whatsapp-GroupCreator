// src/services/whatsappService.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const taskQueue = require('./taskQueue');
const { createGroup } = require('./groupCreationService');
const fs = require('fs');

let sock = null;
const SESSION_FILE_PATH = path.join(config.paths.session, 'main-session');

async function startMainClient() {
    logger.info('Initializing main WhatsApp client...');
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FILE_PATH);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop'),
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            logger.info('QR code generated for main client. Scan with WhatsApp!');
        }

        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error('Main client connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startMainClient();
            } else {
                logger.error('Main client logged out. Delete the "main-session" folder to generate a new QR code.');
            }
        } else if (connection === 'open') {
            logger.info('Main WhatsApp client connected successfully.');
            taskQueue.emit('client_ready');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

function getMainClient() {
    return sock;
}

async function processQueue() {
    if (taskQueue.isProcessing || taskQueue.queue.length === 0) return;
    
    const client = getMainClient();
    if (!client || client.ws.readyState !== 1) { // 1 means WebSocket is OPEN
        logger.warn('Client not ready, waiting to process queue.');
        return;
    }

    taskQueue.isProcessing = true;
    const task = taskQueue.getNextTask();
    
    try {
        await createGroup(client, task.username, task.groupName, task.participants, task.adminJid);
        if (global.io && global.userSockets[task.username]) {
            global.io.to(global.userSockets[task.username]).emit('upload_progress', { current: task.index, total: task.total, currentGroup: task.groupName });
        }
    } catch (error) {
        logger.error(`Failed to process task for group "${task.groupName}": ${error.message}`);
    } finally {
        taskQueue.isProcessing = false;
        // Immediately try to process the next item in the queue
        process.nextTick(processQueue);
    }
}

// Listen for events to start processing the queue
taskQueue.on('new_task', processQueue);
taskQueue.on('client_ready', processQueue);

// This function is no longer needed but we keep it to avoid breaking other files temporarily.
function closeBaileysClient(clientId) {
    logger.info(`User ${clientId} logged out. The main client remains active.`);
}

module.exports = { startMainClient, getMainClient, closeBaileysClient };
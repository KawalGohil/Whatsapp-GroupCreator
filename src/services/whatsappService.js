const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const logger = require('../utils/logger');
const config = require('../../config');

const clients = {}; // Stores active Baileys sockets

/**
 * Starts and manages a Baileys WhatsApp client instance for a given user.
 * @param {string} clientId The username to identify the session.
 */
async function startBaileysClient(clientId) {
    const sessionDir = path.join(config.paths.session, clientId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // A fallback if the QR isn't sent to the frontend
        browser: Browsers.macOS('Desktop'),
        logger: require('pino')({ level: 'silent' }) // Suppress Baileys' own noisy logging
    });

    clients[clientId] = sock;

     let connectionTimeout = setTimeout(() => {
        const socketId = global.userSockets?.[clientId];
        if (sock.ws.readyState !== sock.ws.OPEN && socketId) {
            logger.error(`Connection timed out for ${clientId}.`);
            global.io.to(socketId).emit('status', 'Connection timed out. Please refresh.');
            sock.ws.close(); // Close the WebSocket connection attempt
        }
    }, 45000); // 45-second timeout

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        const socketId = global.userSockets?.[clientId];

        if (connection === 'open' || connection === 'close' || qr) {
            clearTimeout(connectionTimeout);
        }

        if (qr && socketId) {
            logger.info(`QR code available for ${clientId}, sending to frontend.`);
            global.io.to(socketId).emit('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error(`Connection closed for ${clientId}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                startBaileysClient(clientId);
            } else {
                logger.info(`Not reconnecting ${clientId}, user logged out.`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
                delete clients[clientId];
            }
        } else if (connection === 'open') {
            logger.info(`WhatsApp connection opened for ${clientId}`);
            if (socketId) global.io.to(socketId).emit('status', 'Client is ready!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

function getClient(clientId) {
    return clients[clientId];
}

function closeBaileysClient(clientId) {
    const sock = clients[clientId];
    if (sock) {
        logger.info(`Closing Baileys client for ${clientId}.`);
        sock.logout(); // This gracefully closes the connection
        delete clients[clientId];

        // Optional: Clean up session files on logout
        const sessionDir = path.join(config.paths.session, clientId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            logger.info(`Removed session directory for ${clientId}.`);
        }
    }
}

// This function can be expanded later to automatically restart sessions on server startup
function initializeWhatsAppClients() {
    logger.info('WhatsApp service initialized.');
}

module.exports = {
    startBaileysClient,
    getClient,
    closeBaileysClient,
    initializeWhatsAppClients,
};
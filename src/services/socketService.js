const { Server } = require('socket.io');
const logger = require('../utils/logger');
const { startBaileysClient, getClient } = require('./whatsappService');
const path = require('path');
const config = require('../../config'); 
const fs = require('fs');
const { getMainClient } = require('./whatsappService');

// This object will map a username to their active socket ID
global.userSockets = {};

function initializeSocket(server, sessionMiddleware) {
    const io = new Server(server, {
        cors: {
            origin: '*', // In a real production app, restrict this to your frontend's URL
            methods: ['GET', 'POST'],
            credentials: true
        },
    });

    // Make express-session middleware available to socket.io
    io.use((socket, next) => {
        sessionMiddleware(socket.request, {}, next);
    });

    // Main connection handler
    io.on('connection', (socket) => {
        const session = socket.request.session;
        if (!session || !session.user) {
            logger.warn('Unauthorized socket connection attempt was rejected.');
            return socket.disconnect(true);
        }

        const username = session.user.username;
        const oldSocketId = global.userSockets[username];

        if (oldSocketId && oldSocketId !== socket.id) {
            logger.info(`User ${username} connected with a new socket. Disconnecting old one.`);
            io.to(oldSocketId).disconnect();
        }

        global.userSockets[username] = socket.id;
        logger.info(`User '${username}' connected with socket ID: ${socket.id}`);

        // Initialize a Baileys client if one isn't already running for this user
        const sessionDir = path.join(config.paths.session, username);
        if (getClient(username)) {
            // If the client is already running in memory, it's ready.
            logger.info(`Client for ${username} is already running in memory.`);
            socket.emit('status', 'Client is ready!');
        } else if (fs.existsSync(sessionDir)) {
            // If the session files exist on disk, a connection is likely possible without a QR code.
            logger.info(`Session files found for ${username}. Attempting to reconnect...`);
            socket.emit('status', 'Reconnecting to WhatsApp...'); // Give immediate feedback
            startBaileysClient(username);
        } else {
            // No client and no session files means we need a new QR scan.
            logger.info(`No active client or session for ${username}. Starting new Baileys session.`);
            startBaileysClient(username);
        }

        const mainClient = getMainClient();
        if (mainClient && mainClient.ws.readyState === 1) { // 1 means OPEN
            logger.info('Main client is ready, notifying user.');
            socket.emit('status', 'Client is ready!');
        } else {
            logger.warn('Main client not connected. User may need to scan QR from server console.');
            socket.emit('status', 'Server client is not connected. Please contact admin.');
        }

        socket.on('disconnect', (reason) => {
            logger.info(`User '${username}' disconnected. Reason: ${reason}`);
            // Only delete the mapping if the socket ID matches, to prevent race conditions
            if (global.userSockets[username] === socket.id) {
                delete global.userSockets[username];
            }
        });
    });

    logger.info('Socket.IO service initialized.');
    return io;
}

module.exports = { initializeSocket };
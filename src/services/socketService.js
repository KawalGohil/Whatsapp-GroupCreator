const { Server } = require('socket.io');
const logger = require('../utils/logger');
// --- FIX: Import the new main client service ---
const { getMainClient } = require('./whatsappService');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

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


          const mainClient = getMainClient();
        if (mainClient && mainClient.ws.readyState === 1) { // 1 means WebSocket is OPEN
            logger.info('Main client is ready, notifying user.');
            socket.emit('status', 'Client is ready!');
        } else {
            logger.warn('Main client not connected. User may need to scan QR from server console.');
            // We can attempt to send a QR if one becomes available
            const sessionDir = path.join(config.paths.session, 'main-session');
            if (!fs.existsSync(sessionDir)) {
                 socket.emit('status', 'Please scan the QR code from the server console.');
            } else {
                 socket.emit('status', 'Server client is reconnecting...');
            }
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
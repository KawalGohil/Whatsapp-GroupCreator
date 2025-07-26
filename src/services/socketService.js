const { Server } = require('socket.io');
const logger = require('../utils/logger');
const { startBaileysClient, getClient } = require('./whatsappService');

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
        if (!getClient(username)) {
            logger.info(`No active client for ${username}. Starting a new Baileys session.`);
            startBaileysClient(username);
        } else {
            logger.info(`Client for ${username} is already running.`);
            socket.emit('status', 'Client is already connected!');
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
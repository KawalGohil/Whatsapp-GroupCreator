const { Server } = require('socket.io');
const logger = require('../utils/logger');
const { getClient } = require('./whatsappService');

global.userSockets = {};

function initializeSocket(server, sessionMiddleware) {
    const io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            credentials: true
        },
    });

    io.use((socket, next) => {
        sessionMiddleware(socket.request, {}, next);
    });

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

        // --- THIS IS THE FIX ---
        // Check for the client's status after a short delay to allow the state to be retrieved.
        setTimeout(() => {
            const userClient = getClient(username);
            if (userClient && userClient.user) {
                logger.info(`Client for ${username} is already connected and ready.`);
                socket.emit('status', 'Client is ready!');
            } else {
                logger.warn(`Client for ${username} is not connected. Waiting for QR or connection...`);
                socket.emit('status', 'Initializing your session, please wait...');
            }
        }, 1000); // 1-second delay for stability

        socket.on('disconnect', (reason) => {
            logger.info(`User '${username}' disconnected. Reason: ${reason}`);
            if (global.userSockets[username] === socket.id) {
                delete global.userSockets[username];
            }
        });
    });

    logger.info('Socket.IO service initialized.');
    return io;
}

module.exports = { initializeSocket };
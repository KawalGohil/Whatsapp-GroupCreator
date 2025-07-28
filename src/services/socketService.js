const { Server } = require('socket.io');
const logger = require('../utils/logger');
const { getClient } = require('./whatsappService');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

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

        // Check the status of this specific user's client
        const userClient = getClient(username);
        if (userClient && userClient.ws.readyState === 1) {
            logger.info(`Client for ${username} is already ready.`);
            socket.emit('status', 'Client is ready!');
        } else {
            logger.warn(`Client for ${username} is not connected. Waiting for QR or connection...`);
            socket.emit('status', 'Initializing your session, please wait...');
        }

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
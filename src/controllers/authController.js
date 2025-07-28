const userModel = require('../models/userModel');
const { startBaileysClient, closeBaileysClient } = require('../services/whatsappService');
const logger = require('../utils/logger');

// User Registration
exports.register = (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
        return res.status(400).json({ message: 'Username and a password of at least 6 characters are required.' });
    }

    userModel.createUser(username, password, (err, user) => {
        if (err) {
            if (err.message.includes('Username already exists')) {
                return res.status(409).json({ message: 'Username is already taken. Please choose another.' });
            }
            logger.error('Registration error:', err);
            return res.status(500).json({ message: 'An internal server error occurred.' });
        }
        
        req.session.user = { id: user.id, username: user.username };
        logger.info(`User ${username} registered and logged in.`);
        
        startBaileysClient(username);
        
        res.status(201).json({ message: 'Registration successful.' });
    });
};

// User Login
exports.login = (req, res) => {
    const { username, password } = req.body;

    userModel.findUserByUsername(username, (err, user) => {
        if (err) {
            logger.error(`Database error during login for user ${username}:`, err);
            return res.status(500).json({ message: 'An internal server error occurred.' });
        }
        if (!user) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        userModel.verifyPassword(password, user.password, (bcryptErr, isMatch) => {
            if (bcryptErr) {
                logger.error(`Bcrypt error during login for user ${username}:`, bcryptErr);
                return res.status(500).json({ message: 'An internal server error occurred.' });
            }
            if (!isMatch) {
                return res.status(401).json({ message: 'Invalid username or password.' });
            }
            req.session.user = { id: user.id, username: user.username };
            logger.info(`User ${username} logged in.`);

            startBaileysClient(username);
           
            res.status(200).json({ message: 'Login successful.' });
        });
    });
};

// User Logout
exports.logout = (req, res) => {
    const username = req.session.user?.username;

    req.session.destroy(async (err) => { // Made the callback async
        if (err) {
            logger.error('Error destroying session:', err);
            return res.status(500).json({ message: 'Logout failed.' });
        }
        
        if (username) {
            // Added 'await' to ensure we wait for the client to close
            // and can catch any errors if it fails.
            try {
                await closeBaileysClient(username);
            } catch (closeErr) {
                logger.error(`Error closing Baileys client for ${username}:`, closeErr);
            }
            
            const socketId = global.userSockets?.[username];
            if (socketId && global.io) {
                const socket = global.io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.disconnect(true);
                }
                delete global.userSockets[username];
            }
        }

        res.clearCookie('connect.sid');
        logger.info(`User ${username || ''} logged out.`);
        res.status(200).json({ message: 'Logged out successfully.' });
    });
};

// Check Authentication Status
exports.checkAuth = (req, res) => {
    if (req.session.user) {
        res.status(200).json({ user: req.session.user });
    } else {
        res.status(401).json({ message: 'Not authenticated.' });
    }
};
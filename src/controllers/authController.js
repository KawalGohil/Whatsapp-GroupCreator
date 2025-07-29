const userModel = require('../models/userModel');
// --- FIX: closeBaileysClient is no longer called on logout ---
const { startBaileysClient } = require('../services/whatsappService');
const logger = require('../utils/logger');


// User Registration
exports.register = (req, res) => {
    const { username, password } = req.body;
    logger.info(`Registration attempt for username: ${username}`);
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
    logger.info(`Login attempt for username: ${username}`);
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

// --- THIS IS THE FIX for FIRE AND FORGET ---
// The Baileys client is no longer shut down on logout, allowing it to complete its queue.
exports.logout = (req, res) => {
    const username = req.session.user?.username;
    logger.info(`Logout attempt for username: ${username || 'N/A'}`);
    req.session.destroy((err) => {
        if (err) {
            logger.error('Error destroying session:', err);
            return res.status(500).json({ message: 'Logout failed.' });
        }
        
        if (username) {
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
        logger.info(`User ${username || ''} logged out of the web app. WhatsApp client continues to process queue.`);
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
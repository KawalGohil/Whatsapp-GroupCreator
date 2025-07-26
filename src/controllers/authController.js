const userModel = require('../models/userModel');
const { startBaileysClient, getClient } = require('../services/whatsappService');
const logger = require('../utils/logger');

// User Registration
exports.register = (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 6) {
        return res.status(400).json({ message: 'Username and a password of at least 6 characters are required.' });
    }

    userModel.createUser(username, password, (err, user) => {
        if (err) {
            logger.error('Registration error:', err);
            return res.status(409).json({ message: err.message });
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
        if (err || !user) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }

        userModel.verifyPassword(password, user.password, (err, isMatch) => {
            if (err || !isMatch) {
                return res.status(401).json({ message: 'Invalid username or password.' });
            }
            req.session.user = { id: user.id, username: user.username };
            logger.info(`User ${username} logged in.`);
            if (!getClient(username)) {
                startBaileysClient(username);
            }
            res.status(200).json({ message: 'Login successful.' });
        });
    });
};

// User Logout
exports.logout = (req, res) => {
    // Note: Baileys client cleanup is handled in whatsappService on 'loggedOut' event
    req.session.destroy(err => {
        if (err) {
            logger.error('Error destroying session:', err);
            return res.status(500).json({ message: 'Logout failed.' });
        }
        res.clearCookie('connect.sid');
        logger.info(`User logged out.`);
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
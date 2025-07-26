const logger = require('../utils/logger');

function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    logger.warn('Unauthorized access attempt blocked.');
    res.status(401).json({ message: 'You must be logged in to access this resource.' });
}

module.exports = { isAuthenticated };
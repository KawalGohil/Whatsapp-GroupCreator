const express = require('express');
const { register, login, logout, checkAuth } = require('../controllers/authController');
const { isAuthenticated } = require('../middleware/authMiddleware'); // We'll create this middleware

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', isAuthenticated, logout);
router.get('/check-auth', checkAuth);

module.exports = router;
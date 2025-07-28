const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const config = require('./config');
const logger = require('./src/utils/logger');
const { initializeSocket } = require('./src/services/socketService');
const authRoutes = require('./src/routes/authRoutes');
const groupRoutes = require('./src/routes/groupRoutes');

const app = express();
const server = http.createServer(app);

// --- Middleware Setup ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Session Management ---
const sessionMiddleware = session({
    store: new SQLiteStore({
        db: path.basename(config.paths.sessionStore),
        dir: path.dirname(config.paths.sessionStore),
    }),
    secret: process.env.SESSION_SECRET || 'a-super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 1 week
});
app.use(sessionMiddleware);

// --- Initialize Services ---
const io = initializeSocket(server, sessionMiddleware);
global.io = io; // Make io accessible globally

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server is listening on port ${PORT}`);
});
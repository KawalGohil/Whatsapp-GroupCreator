const express = require('express');
const multer = require('multer');
const { createManualGroup, uploadContacts, listLogs, downloadLog } = require('../controllers/groupController');
const { isAuthenticated } = require('../middleware/authMiddleware');

const upload = multer({ dest: 'uploads/' });
const router = express.Router();

router.post('/create-manual', isAuthenticated, createManualGroup);
router.post('/upload-csv', isAuthenticated, upload.single('contacts'), uploadContacts);

router.get('/list-logs', isAuthenticated, listLogs);
router.get('/download-log/:filename', isAuthenticated, downloadLog);

module.exports = router;
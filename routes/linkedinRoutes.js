const express = require('express');
const router = express.Router();
const linkedinController = require('../controllers/linkedinController');

// LinkedIn data retrieval routes
router.post('/data-retrieval', linkedinController.retrieveData);
router.get('/status', linkedinController.checkStatus);

module.exports = router;
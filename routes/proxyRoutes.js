const express = require('express');
const router = express.Router();
const proxyController = require('../controllers/proxyController');

// Proxy route for external API calls
router.post('/', proxyController.proxyRequest);

module.exports = router;
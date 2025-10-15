const express = require('express');
const router = express.Router();
const linkedinInstructionController = require('../controllers/linkedinInstructionController');
const { authenticateUser } = require('../middleware/authentication');

// All routes require authentication
router.use(authenticateUser);

// Extension polling endpoint - get pending instructions
router.get('/instructions', linkedinInstructionController.getInstructions);

// Extension result reporting endpoint - report completion
router.post('/results', linkedinInstructionController.receiveResults);

// Extension throttling notification endpoint
router.post('/throttling', linkedinInstructionController.handleThrottling);

// Extension connection status endpoint
router.get('/connection', linkedinInstructionController.getConnectionStatus);

module.exports = router;

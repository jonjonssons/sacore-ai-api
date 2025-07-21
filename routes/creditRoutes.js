const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const creditController = require('../controllers/creditController');

// Get available credit packages
router.get('/packages', authenticateUser, creditController.getCreditPackages);

// Create checkout session for credit purchase
router.post('/checkout', authenticateUser, creditController.createCreditCheckoutSession);

// Get user's credit balance
router.get('/balance', authenticateUser, creditController.getUserCredits);

// Get credit history
router.get('/history', authenticateUser, creditController.getCreditHistory);

// Get credit summary
router.get('/summary', authenticateUser, creditController.getCreditSummary);

module.exports = router;
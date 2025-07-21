const express = require('express');
const router = express.Router();
const stripeController = require('../controllers/stripeController');
const { authenticateUser } = require('../middleware/authentication');

router.post('/create-checkout-session', authenticateUser, stripeController.createCheckoutSession);
router.post('/webhook', express.raw({ type: 'application/json' }), stripeController.handleWebhook);
router.get('/plans', authenticateUser, stripeController.getPlans);

module.exports = router;
const express = require('express');
const router = express.Router();
const stripeController = require('../controllers/stripeController');
const { authenticateUser } = require('../middleware/authentication');

router.post('/create-checkout-session', authenticateUser, stripeController.createCheckoutSession);
// router.post('/webhook', express.raw({ type: 'application/json' }), stripeController.handleWebhook);
router.get('/plans', authenticateUser, stripeController.getPlans);
router.get('/subscription', authenticateUser, stripeController.getSubscriptionDetails);

// Add new route for invoice history
router.get('/invoices', authenticateUser, stripeController.getInvoiceHistory);

// Add new routes for subscription cancellation
router.post('/subscription/cancel', authenticateUser, stripeController.cancelSubscription);
router.post('/subscription/cancel-immediately', authenticateUser, stripeController.cancelSubscriptionImmediately);

module.exports = router;
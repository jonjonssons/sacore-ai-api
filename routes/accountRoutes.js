const express = require('express');
const router = express.Router();
const accountController = require('../controllers/accountController');
const { authenticateUser } = require('../middleware/authentication');

// All routes require authentication
router.use(authenticateUser);

// Account management
router.get('/', accountController.getAccounts);
router.delete('/:id', accountController.disconnectAccount);
router.post('/:id/test', accountController.testConnection);

// Gmail OAuth
router.get('/gmail/auth-url', accountController.getGmailAuthUrl);
router.post('/gmail/callback', accountController.handleGmailCallback);

// Gmail Token Management (NEW - Automatic Refresh)
router.get('/gmail/valid', accountController.getValidGmailAccount);
router.get('/gmail/valid/:accountId', accountController.getValidGmailAccount);
router.post('/gmail/refresh-all', async (req, res) => {
    try {
        console.log('📧 Starting bulk Gmail token refresh...');

        // Call the utility function
        const result = await accountController.refreshAllExpiredGmailTokens();

        console.log('📧 Bulk refresh completed:', result);

        // Send response back to client
        res.json({
            success: true,
            message: `Successfully refreshed ${result.refreshed} Gmail accounts`,
            refreshed: result.refreshed
        });

    } catch (error) {
        console.error('📧 Bulk refresh route error:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
// LinkedIn OAuth
router.get('/linkedin/auth-url', accountController.getLinkedInAuthUrl);
router.post('/linkedin/callback', accountController.handleLinkedInCallback);

// LinkedIn cookie-based session
router.post('/linkedin/:accountId/cookies', accountController.uploadLinkedInCookies);
router.get('/linkedin/:accountId/cookies/validate', accountController.validateLinkedInCookies);

// Email settings
router.put('/email/:id/default', accountController.setDefaultEmail);

// LinkedIn rate limits
router.get('/linkedin/rate-limits', accountController.getLinkedInRateLimits);
router.put('/linkedin/rate-limits', accountController.updateLinkedInRateLimits);

module.exports = router;
const express = require('express');
const router = express.Router();
const campaignController = require('../controllers/campaignController');
const { authenticateUser } = require('../middleware/authentication');

// All routes require authentication
router.use(authenticateUser);

// Campaign CRUD
router.get('/', campaignController.getCampaigns);
router.post('/', campaignController.createCampaign);

// Campaign limits (check subscription limits)
router.get('/limits', campaignController.getCampaignLimits);

// Special routes (must come before parameterized routes)
router.post('/bulk', campaignController.bulkOperations);
router.delete('/all', campaignController.deleteAllCampaigns);
router.delete('/admin/global-cleanup', campaignController.deleteAllCampaignsGlobal);

// Parameterized routes (must come after special routes)
router.get('/:id', campaignController.getCampaign);
router.put('/:id', campaignController.updateCampaign);
router.delete('/:id', campaignController.deleteCampaign);

// Campaign operations
router.post('/:id/start', campaignController.startCampaign);
router.post('/:id/pause', campaignController.pauseCampaign);
router.post('/:id/resume', campaignController.resumeCampaign);
router.post('/:id/duplicate', campaignController.duplicateCampaign);
router.post('/:id/check-replies', campaignController.manualReplyCheck);
router.post('/:id/prospects', campaignController.addProspectsToCampaign);
router.delete('/:id/prospects', campaignController.deleteProspectsFromCampaign);

// Campaign editing routes
router.get('/:id/edit-status', campaignController.getCampaignEditStatus);
router.put('/:id/paused-update', campaignController.updatePausedCampaign);

// Campaign monitoring routes
router.get('/:id/executions', campaignController.getCampaignExecutions);
router.get('/:id/executions/:prospectId', campaignController.getProspectExecution);
router.get('/:id/prospects/:prospectId', campaignController.getProspectDetails);
router.get('/:id/activity', campaignController.getCampaignActivity);
router.get('/:id/scheduled', campaignController.getScheduledActions);
router.get('/:id/stats', campaignController.getCampaignStats);

// Campaign settings routes
router.get('/:id/settings', campaignController.getCampaignSettings);
router.put('/:id/settings', campaignController.updateCampaignSettings);
router.get('/settings/presets', campaignController.getLinkedInPresets);
router.post('/:id/settings/preset/:preset', campaignController.applyCampaignPreset);
router.post('/:id/settings/reset', campaignController.resetCampaignToGlobalSettings);

module.exports = router;
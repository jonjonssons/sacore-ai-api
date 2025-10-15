const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const searchResultsController = require('../controllers/searchResultsController');

// Apply authentication to all routes
router.use(authenticateUser);

// Save search results (called after profile processing)
router.post('/save-results', searchResultsController.saveSearchResults);

// Get past 24 hours searches
router.get('/recent', searchResultsController.getRecentSearches);

// Get profiles from a specific search
router.get('/:searchId/profiles', searchResultsController.getSearchProfiles);

// Update profile with enrichment data
router.patch('/profiles/:profileId', searchResultsController.updateProfile);

// Batch update multiple profiles
router.patch('/batch-update', searchResultsController.batchUpdateProfiles);

// Delete old searches (cleanup job)
router.delete('/cleanup-old', searchResultsController.cleanupOldSearches);

// Delete a single search profile
router.delete('/profiles/:profileId', searchResultsController.deleteProfile);

// Delete multiple search profiles
router.delete('/profiles', searchResultsController.deleteMultipleProfiles);

module.exports = router;
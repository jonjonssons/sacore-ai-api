const express = require('express');
const router = express.Router();
const savedProfileController = require('../controllers/savedProfileController');
const { authenticateUser } = require('../middleware/authentication');

// Apply authentication middleware to all routes
router.use(authenticateUser);

// Save a profile
router.post('/', savedProfileController.saveProfile);

// Get all saved profiles for a user
router.get('/', savedProfileController.getSavedProfiles);

// Delete a saved profile
router.delete('/:profileId', savedProfileController.deleteSavedProfile);

// Update a saved profile
router.patch('/:profileId', savedProfileController.updateSavedProfile);

module.exports = router;
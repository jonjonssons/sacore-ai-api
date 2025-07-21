const express = require('express');
const router = express.Router();
const profilesController = require('../controllers/profilesController');
const { authenticateUser, checkCredits } = require('../middleware/authentication');

// Create a new profile
router.post('/', authenticateUser, profilesController.createProfile);

// Get all profiles for a project
router.get('/project/:projectId', authenticateUser, profilesController.getProfilesByProject);

// Get all profiles for the authenticated user across all projects
router.get('/user/all', authenticateUser, profilesController.getAllProfilesForUser);

// Get a profile by id
router.get('/:id', authenticateUser, profilesController.getProfileById);

// Update a profile by id
router.put('/:id', authenticateUser, profilesController.updateProfile);

// Delete a profile by id
router.delete('/:id', authenticateUser, profilesController.deleteProfile);

module.exports = router;

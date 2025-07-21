const express = require('express');
const router = express.Router();
const projectsController = require('../controllers/projectsController');
const { authenticateUser, checkCredits } = require('../middleware/authentication');

// Create a new project
router.post('/', authenticateUser, projectsController.createProject);

// Get all projects for a user
router.get('/user', authenticateUser, projectsController.getProjectsByUserId);

// Get a project by id
router.get('/:id', authenticateUser, projectsController.getProjectById);

// Update a project by id
router.put('/:id', authenticateUser, projectsController.updateProject);

// Delete a project by id
router.delete('/:id', authenticateUser, projectsController.deleteProject);

module.exports = router;

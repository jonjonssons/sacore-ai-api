const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { authenticateUser } = require('../middleware/authentication');

// All routes require authentication
router.use(authenticateUser);

// Task CRUD
router.get('/', taskController.getAllTasks);
router.post('/', taskController.createTask);
router.get('/stats', taskController.getTaskStats);
router.patch('/bulk', taskController.bulkUpdateTasks);
router.delete('/bulk', taskController.bulkDeleteTasks);
router.get('/:id', taskController.getTaskById);
router.patch('/:id', taskController.updateTask);
router.delete('/:id', taskController.deleteTask);

module.exports = router; 
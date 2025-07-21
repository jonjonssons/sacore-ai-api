const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const dashboardController = require('../controllers/dashboardController');

router.get('/dashboard', authenticateUser, dashboardController.getDashboardData);

module.exports = router;

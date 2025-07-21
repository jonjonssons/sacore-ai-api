const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateUser } = require('../middleware/authentication');
const { isAdmin } = require('../middleware/authorization');

// Apply authentication and admin authorization to all routes
router.use(authenticateUser, isAdmin);

// Dashboard overview
router.get('/dashboard', adminController.getDashboardOverview);

// User analytics
router.get('/analytics/users', adminController.getUserAnalytics);

// Credit analytics
router.get('/analytics/credits', adminController.getCreditAnalytics);

// Revenue analytics
router.get('/analytics/revenue', adminController.getRevenueAnalytics);

// Search analytics
router.get('/analytics/searches', adminController.getSearchAnalytics);

// User management
router.get('/users', adminController.getUsers);
router.get('/users/:userId', adminController.getUserDetails);
router.patch('/users/:userId', adminController.updateUser);

module.exports = router;
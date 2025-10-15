const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const timezones = require('../config/timezones');

// Get available timezones (used by campaign settings)
router.get('/timezones', authenticateUser, async (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                popular: timezones.popular,
                regions: timezones.regions
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get popular timezones only (for quick selection in campaign settings)
router.get('/timezones/popular', authenticateUser, async (req, res) => {
    try {
        res.json({
            success: true,
            data: timezones.popular
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;

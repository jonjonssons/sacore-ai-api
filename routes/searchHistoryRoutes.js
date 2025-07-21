const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const searchHistoryController = require('../controllers/searchHistoryController');

router.post('/', authenticateUser, searchHistoryController.saveSearchHistory);
router.get('/', authenticateUser, searchHistoryController.getSearchHistories);

module.exports = router;

const SearchHistory = require('../models/SearchHistory');

exports.saveSearchHistory = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { query } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        const newSearchHistory = new SearchHistory({
            userId,
            query
        });

        await newSearchHistory.save();

        res.status(201).json({ message: 'Search history saved successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getSearchHistories = async (req, res) => {
    try {
        const userId = req.user.userId;

        const histories = await SearchHistory.find({ userId }).sort({ createdAt: -1 });

        res.status(200).json(histories);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

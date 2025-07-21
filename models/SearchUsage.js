const mongoose = require('mongoose');

const SearchUsageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
  },
  year: {
    type: Number,
    required: true,
  },
  month: {
    type: Number,
    required: true,
  },
  day: {
    type: Number,
    required: true,
  },
  date: {
    type: Date,
    required: true,
  },
  monthlySearches: {
    type: Number,
    default: 0,
  },
  dailySearches: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  }
});

// Create compound index for efficient queries
SearchUsageSchema.index({ userId: 1, year: 1, month: 1 });
SearchUsageSchema.index({ userId: 1, year: 1, month: 1, day: 1 });

module.exports = mongoose.model('SearchUsage', SearchUsageSchema); 
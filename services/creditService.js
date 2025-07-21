const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const { UnauthenticatedError, ForbiddenError } = require('../errors');
const mongoose = require('mongoose');

// Credit costs for different actions
const CREDIT_COSTS = {
  SEARCH: 1,
  PROFILE_VIEW: 2,
  PROFILE_ANALYSIS: 5,
  EXPORT: 10
};

// Consume credits and log the transaction
exports.consumeCredits = async (userId, operation, amount = 1) => {
  const user = await User.findOne({ _id: userId });

  if (!user) {
    throw new UnauthenticatedError('User not found');
  }

  // Check if user has enough credits
  if (user.credits < amount) {
    throw new ForbiddenError('Not enough credits');
  }

  // Deduct credits
  user.credits -= amount;
  await user.save();

  // Log the transaction
  await CreditTransaction.create({
    user: userId,
    amount: -amount,
    type: 'USAGE',
    description: `Used ${amount} credits for ${operation}`,
    balance: user.credits
  });

  return user.credits;
};

// Add credits and log the transaction
exports.addCredits = async (userId, amount, type = 'TOPUP', description = 'Credit purchase') => {
  const user = await User.findOne({ _id: userId });

  if (!user) {
    throw new UnauthenticatedError('User not found');
  }

  // Add credits
  user.credits += amount;
  await user.save();

  // Log the transaction
  await CreditTransaction.create({
    user: userId,
    amount: amount,
    type: type,
    description: description,
    balance: user.credits
  });

  return user.credits;
};

// Reset credits based on subscription plan
exports.resetCreditsForBilling = async (userId) => {
  const user = await User.findOne({ _id: userId });

  if (!user) {
    throw new Error('User not found');
  }

  // Set credits based on subscription plan
  switch (user.subscription) {
    case 'basic':
      user.credits = 500;
      break;
    case 'pro':
      user.credits = 1500;
      break;
    case 'enterprise':
      user.credits = 6500;
      break;
    default:
      user.credits = 100; // Free tier
  }

  await user.save();

  return {
    subscription: user.subscription,
    totalCredits: user.credits
  };
};


// Get credit history for a user
exports.getCreditHistory = async (userId, filter = {}) => {
  // Validate user exists
  const user = await User.findOne({ _id: userId });

  if (!user) {
    throw new UnauthenticatedError('User not found');
  }

  // Build query
  const query = { user: userId };

  // Add date filters if provided
  if (filter.startDate) {
    query.createdAt = { $gte: new Date(filter.startDate) };
  }

  if (filter.endDate) {
    if (!query.createdAt) query.createdAt = {};
    query.createdAt.$lte = new Date(filter.endDate);
  }

  // Add type filter if provided
  if (filter.type) {
    query.type = filter.type;
  }

  // Get transactions
  const transactions = await CreditTransaction.find(query)
    .sort({ createdAt: -1 })
    .limit(filter.limit || 100);

  // Get summary
  const summary = await this.getCreditSummary(userId);

  return {
    transactions,
    summary
  };
};

// Get credit summary for a user
exports.getCreditSummary = async (userId) => {
  // Get total credits added (INITIAL + TOPUP)
  const creditsAdded = await CreditTransaction.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(userId), type: { $in: ['INITIAL', 'TOPUP'] } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  // Get total credits used
  const creditsUsed = await CreditTransaction.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(userId), type: 'USAGE' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  // Get monthly usage
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const monthlyUsage = await CreditTransaction.aggregate([
    {
      $match: {
        user: new mongoose.Types.ObjectId(userId),
        type: 'USAGE',
        createdAt: { $gte: startOfMonth }
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  // Get user's current balance
  const user = await User.findOne({ _id: userId });

  return {
    totalAdded: creditsAdded.length > 0 ? creditsAdded[0].total : 0,
    totalUsed: creditsUsed.length > 0 ? Math.abs(creditsUsed[0].total) : 0,
    monthlyUsage: monthlyUsage.length > 0 ? Math.abs(monthlyUsage[0].total) : 0,
    currentBalance: user ? user.credits : 0
  };
};

module.exports.CREDIT_COSTS = CREDIT_COSTS;

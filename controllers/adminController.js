const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const { StatusCodes } = require('http-status-codes');

// Get user analytics for admin dashboard
exports.getUserAnalytics = async (req, res) => {
  try {
    // Get total users count
    const totalUsers = await User.countDocuments();
    
    // Get verified users count
    const verifiedUsers = await User.countDocuments({ isVerified: true });
    
    // Get users registered in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const newUsers = await User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });
    
    // Get users by subscription type
    const subscriptionCounts = await User.aggregate([
      { $group: { _id: '$subscription', count: { $sum: 1 } } }
    ]);
    
    res.status(StatusCodes.OK).json({
      totalUsers,
      verifiedUsers,
      newUsers,
      subscriptionBreakdown: subscriptionCounts
    });
  } catch (error) {
    console.error('Error getting user analytics:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get user analytics',
      details: error.message
    });
  }
};

// Get credit usage analytics for admin dashboard
exports.getCreditAnalytics = async (req, res) => {
  try {
    // Get total credits issued
    const creditsIssued = await CreditTransaction.aggregate([
      { $match: { type: { $in: ['INITIAL', 'TOPUP'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get total credits used
    const creditsUsed = await CreditTransaction.aggregate([
      { $match: { type: 'USAGE' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get credit usage by operation type
    const usageByOperation = await CreditTransaction.aggregate([
      { $match: { type: 'USAGE' } },
      { $group: { _id: '$description', total: { $sum: '$amount' } } }
    ]);
    
    // Get top credit consumers
    const topConsumers = await CreditTransaction.aggregate([
      { $match: { type: 'USAGE' } },
      { $group: { _id: '$user', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userDetails' } },
      { $project: { 
        _id: 1, 
        total: 1, 
        'userDetails.email': 1, 
        'userDetails.firstName': 1, 
        'userDetails.lastName': 1 
      }}
    ]);
    
    res.status(StatusCodes.OK).json({
      creditsIssued: creditsIssued.length > 0 ? creditsIssued[0].total : 0,
      creditsUsed: creditsUsed.length > 0 ? Math.abs(creditsUsed[0].total) : 0,
      usageByOperation,
      topConsumers
    });
  } catch (error) {
    console.error('Error getting credit analytics:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get credit analytics',
      details: error.message
    });
  }
};

// Get revenue analytics for admin dashboard
exports.getRevenueAnalytics = async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    
    // Get date range (default to last 30 days)
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    // Get all successful payments from Stripe
    const charges = await stripe.charges.list({
      created: {
        gte: Math.floor(start.getTime() / 1000),
        lte: Math.floor(end.getTime() / 1000)
      },
      limit: 100
    });
    
    // Separate subscription payments from credit purchases
    const subscriptionRevenue = charges.data
      .filter(charge => charge.metadata && charge.metadata.type === 'subscription')
      .reduce((sum, charge) => sum + charge.amount, 0) / 100;
      
    const creditPurchaseRevenue = charges.data
      .filter(charge => charge.metadata && charge.metadata.type === 'credit_purchase')
      .reduce((sum, charge) => sum + charge.amount, 0) / 100;
    
    // Get revenue by day for the period
    const dailyRevenue = {};
    charges.data.forEach(charge => {
      const date = new Date(charge.created * 1000).toISOString().split('T')[0];
      if (!dailyRevenue[date]) dailyRevenue[date] = 0;
      dailyRevenue[date] += charge.amount / 100;
    });
    
    res.status(StatusCodes.OK).json({
      totalRevenue: subscriptionRevenue + creditPurchaseRevenue,
      subscriptionRevenue,
      creditPurchaseRevenue,
      dailyRevenue: Object.entries(dailyRevenue).map(([date, amount]) => ({ date, amount }))
    });
  } catch (error) {
    console.error('Error getting revenue analytics:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get revenue analytics',
      details: error.message
    });
  }
};

// Get search analytics for admin dashboard
exports.getSearchAnalytics = async (req, res) => {
  try {
    // This would require adding a SearchLog model to your application
    // For now, we'll return placeholder data
    
    res.status(StatusCodes.OK).json({
      totalSearches: 0,
      averageSearchesPerUser: 0,
      popularSearchTerms: [],
      searchToProfileViewRate: 0,
      message: "Search analytics tracking needs to be implemented"
    });
  } catch (error) {
    console.error('Error getting search analytics:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get search analytics',
      details: error.message
    });
  }
};

// Get list of users for admin dashboard
exports.getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    
    // Build query
    const query = {};
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Get users with pagination
    const users = await User.find(query)
      .select('_id email firstName lastName isVerified subscription credits createdAt lastLogin')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    // Get total count for pagination
    const totalUsers = await User.countDocuments(query);
    
    res.status(StatusCodes.OK).json({
      users,
      totalUsers,
      totalPages: Math.ceil(totalUsers / limit),
      currentPage: parseInt(page)
    });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get users',
      details: error.message
    });
  }
};

// Get detailed information about a specific user
exports.getUserDetails = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user details
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: 'User not found'
      });
    }
    
    // Get user's credit transactions
    const creditTransactions = await CreditTransaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.status(StatusCodes.OK).json({
      user,
      creditTransactions
    });
  } catch (error) {
    console.error('Error getting user details:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get user details',
      details: error.message
    });
  }
};

// Update user (admin action)
exports.updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { subscription, credits, isVerified, role } = req.body;
    
    // Find user
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: 'User not found'
      });
    }
    
    // Update fields if provided
    if (subscription !== undefined) user.subscription = subscription;
    if (isVerified !== undefined) user.isVerified = isVerified;
    if (role !== undefined) user.role = role;
    
    // Handle credit adjustment if provided
    if (credits !== undefined) {
      const creditDifference = credits - user.credits;
      user.credits = credits;
      
      // Log the credit adjustment
      if (creditDifference !== 0) {
        await CreditTransaction.create({
          user: userId,
          amount: creditDifference,
          type: 'ADMIN',
          description: 'Admin credit adjustment',
          balance: user.credits
        });
      }
    }
    
    await user.save();
    
    res.status(StatusCodes.OK).json({
      message: 'User updated successfully',
      user
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to update user',
      details: error.message
    });
  }
};

// Get dashboard overview for admin
exports.getDashboardOverview = async (req, res) => {
  try {
    // Get total users
    const totalUsers = await User.countDocuments();
    
    // Get new users in last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const newUsers = await User.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
    
    // Get total credits issued
    const creditsIssued = await CreditTransaction.aggregate([
      { $match: { type: { $in: ['INITIAL', 'TOPUP'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get total credits used
    const creditsUsed = await CreditTransaction.aggregate([
      { $match: { type: 'USAGE' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    
    // Get recent credit transactions
    const recentTransactions = await CreditTransaction.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('user', 'email firstName lastName');
    
    res.status(StatusCodes.OK).json({
      userStats: {
        total: totalUsers,
        new: newUsers
      },
      creditStats: {
        issued: creditsIssued.length > 0 ? creditsIssued[0].total : 0,
        used: creditsUsed.length > 0 ? Math.abs(creditsUsed[0].total) : 0
      },
      recentTransactions
    });
  } catch (error) {
    console.error('Error getting dashboard overview:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get dashboard overview',
      details: error.message
    });
  }
};
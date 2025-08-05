const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const { StatusCodes } = require('http-status-codes');
const SearchUsage = require('../models/SearchUsage');
const { default: mongoose } = require('mongoose');
const SearchHistory = require('../models/SearchHistory');
const usageService = require('../services/usageService');
const Projects = require('../models/Projects');
const SavedProfile = require('../models/SavedProfile');


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
      {
        $project: {
          _id: 1,
          total: 1,
          'userDetails.email': 1,
          'userDetails.firstName': 1,
          'userDetails.lastName': 1
        }
      }
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

    // Get users with pagination, using .lean() for better performance
    const users = await User.find(query)
      .select('_id email firstName lastName isVerified subscription credits createdAt lastLogin')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    // Get total count for pagination
    const totalUsers = await User.countDocuments(query);

    // Get user IDs from the current page of results
    const userIds = users.map(user => user._id);
    let usersWithSearchCounts = users;

    // If there are users on the current page, fetch their search counts
    if (userIds.length > 0) {
      const searchCounts = await SearchUsage.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', totalSearches: { $sum: '$monthlySearches' } } }
      ]);

      // Create a map for easy lookup of search counts
      const searchCountMap = new Map();
      searchCounts.forEach(item => {
        searchCountMap.set(item._id.toString(), item.totalSearches);
      });

      // Add search count to each user object
      usersWithSearchCounts = users.map(user => ({
        ...user,
        totalSearches: searchCountMap.get(user._id.toString()) || 0
      }));
    }

    res.status(StatusCodes.OK).json({
      users: usersWithSearchCounts,
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

    // 1. Get user details (excluding password)
    const user = await User.findById(userId).select('-password');

    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: 'User not found'
      });
    }

    // 2. Get credit transactions and summary
    const creditTransactions = await CreditTransaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(50);

    const usageByOperation = await CreditTransaction.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), type: 'USAGE' } },
      {
        $group: {
          _id: '$description',
          count: { $sum: 1 },
          totalCredits: { $sum: '$amount' }
        }
      },
      { $sort: { count: -1 } }
    ]);

    // 3. Get search history (last 20 searches)
    const searchHistory = await SearchHistory.find({ userId })
      .sort({ createdAt: -1 })
      .limit(20);

    // 4. Get search usage stats from usageService
    const searchUsage = await usageService.getSearchUsage(userId);

    // 5. Get project and saved profile counts
    const projectsCount = await Projects.countDocuments({ userId });

    // 6. Get Stripe subscription details if available
    let stripeSubscription = null;
    if (user.stripeCustomerId) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'all',
          limit: 1
        });
        if (subscriptions.data.length > 0) {
          stripeSubscription = subscriptions.data[0];
        }
      } catch (stripeError) {
        console.error(`Error fetching Stripe subscription for user ${userId}:`, stripeError.message);
        stripeSubscription = { error: 'Failed to fetch subscription details from Stripe.' };
      }
    }

    res.status(StatusCodes.OK).json({
      user,
      stats: {
        projects: projectsCount,
        searchUsage
      },
      credits: {
        currentBalance: user.credits,
        usageByOperation: usageByOperation.map(op => ({
          operation: op._id,
          count: op.count,
          creditsUsed: Math.abs(op.totalCredits)
        })),
        recentTransactions: creditTransactions,
      },
      searchHistory,
      stripeSubscription,
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
    const { subscription, credits, isVerified, role, addExtraMonthlySearches, addExtraDailySearches } = req.body;

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

    // Handle extra searches if provided
    const hasExtraMonthly = addExtraMonthlySearches !== undefined && addExtraMonthlySearches > 0;
    const hasExtraDaily = addExtraDailySearches !== undefined && addExtraDailySearches > 0;

    if (hasExtraMonthly || hasExtraDaily) {
      await addExtraSearchesToUser(
        userId,
        hasExtraMonthly ? addExtraMonthlySearches : 0,
        hasExtraDaily ? addExtraDailySearches : 0
      );
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

// Add a dedicated endpoint for adding extra searches
exports.addExtraSearches = async (req, res) => {
  try {
    const { userId } = req.params;
    const { extraMonthlySearches, extraDailySearches } = req.body;

    // Validate input - at least one value should be provided
    if ((!extraMonthlySearches && !extraDailySearches) ||
      (extraMonthlySearches <= 0 && extraDailySearches <= 0)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide a valid number of extra daily or monthly searches'
      });
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: 'User not found'
      });
    }

    // Add extra searches with separate values
    const result = await addExtraSearchesToUser(
      userId,
      extraMonthlySearches || 0,
      extraDailySearches || 0
    );

    // Get updated search usage
    const updatedUsage = await usageService.getSearchUsage(userId);

    res.status(StatusCodes.OK).json({
      message: `Successfully added ${extraMonthlySearches || 0} monthly and ${extraDailySearches || 0} daily extra searches for user`,
      user: {
        _id: user._id,
        email: user.email,
        name: user.firstName + ' ' + user.lastName
      },
      updatedUsage
    });
  } catch (error) {
    console.error('Error adding extra searches:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to add extra searches',
      details: error.message
    });
  }
};

// Helper function to add extra searches to a user
const addExtraSearchesToUser = async (userId, extraMonthlySearches, extraDailySearches) => {
  // Get current date info
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  // Find or create the search usage record for this month
  let monthlyUsage = await SearchUsage.findOne({
    userId,
    year,
    month
  });

  // If no record exists for this month, create one
  if (!monthlyUsage) {
    monthlyUsage = new SearchUsage({
      userId,
      year,
      month,
      day,
      date: now,
      monthlySearches: 0,
      dailySearches: 0
    });
  }

  // Add a negative value to "used" searches to effectively increase the remaining searches
  // This approach lets us work with the existing logic without modifying the limits
  monthlyUsage.monthlySearches = Math.max(0, monthlyUsage.monthlySearches - extraMonthlySearches);

  // Save the monthly usage record
  await monthlyUsage.save();

  // Find or create the search usage record for today
  let dailyUsage = await SearchUsage.findOne({
    userId,
    year,
    month,
    day
  });

  // If no record exists for today, create one
  if (!dailyUsage) {
    dailyUsage = new SearchUsage({
      userId,
      year,
      month,
      day,
      date: now,
      monthlySearches: 0,
      dailySearches: 0
    });
  } else if (dailyUsage._id.toString() === monthlyUsage._id.toString()) {
    // If they're the same record, we've already updated monthlySearches
    // Now we need to update dailySearches separately
    dailyUsage.dailySearches = Math.max(0, dailyUsage.dailySearches - extraDailySearches);
    await dailyUsage.save();

    return {
      monthlySearches: dailyUsage.monthlySearches,
      dailySearches: dailyUsage.dailySearches
    };
  }

  // Otherwise, they're different records, so update dailySearches
  dailyUsage.dailySearches = Math.max(0, dailyUsage.dailySearches - extraDailySearches);

  // If this is a separate record, also make sure monthlySearches gets updated here too
  if (dailyUsage.monthlySearches > 0) {
    dailyUsage.monthlySearches = Math.max(0, dailyUsage.monthlySearches - extraMonthlySearches);
  }

  // Save the daily usage record
  await dailyUsage.save();

  // Additionally, update all other records for this month to ensure consistent monthly counts
  await SearchUsage.updateMany(
    {
      userId,
      year,
      month,
      _id: { $ne: monthlyUsage._id }  // Not the one we already updated
    },
    {
      $set: { monthlySearches: monthlyUsage.monthlySearches }
    }
  );

  return {
    monthlySearches: monthlyUsage.monthlySearches,
    dailySearches: dailyUsage.dailySearches
  };
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

    // Get users by subscription type
    const subscriptionBreakdown = await User.aggregate([
      { $group: { _id: '$subscription', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get verified vs unverified users
    const verifiedUsers = await User.countDocuments({ isVerified: true });
    const unverifiedUsers = totalUsers - verifiedUsers;

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
    const creditUsageByOperation = await CreditTransaction.aggregate([
      { $match: { type: 'USAGE' } },
      { $group: { _id: '$description', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
      { $limit: 5 }
    ]);

    // Get daily credit usage for the last 14 days
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    const dailyCreditUsage = await CreditTransaction.aggregate([
      {
        $match: {
          type: 'USAGE',
          createdAt: { $gte: fourteenDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get top credit consumers
    const topCreditConsumers = await CreditTransaction.aggregate([
      { $match: { type: 'USAGE' } },
      { $group: { _id: '$user', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'userDetails'
        }
      },
      {
        $project: {
          _id: 1,
          total: 1,
          'userDetails.email': 1,
          'userDetails.firstName': 1,
          'userDetails.lastName': 1,
          'userDetails.subscription': 1
        }
      }
    ]);

    // Get recent credit transactions
    const recentTransactions = await CreditTransaction.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('user', 'email firstName lastName subscription');

    // Get users with zero credits
    const zeroCreditsUsers = await User.countDocuments({ credits: 0 });

    // Get users with trial ended
    const trialEndedUsers = await User.countDocuments({ trialEnded: true });

    // Get users created per month for the last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5); // -5 to include current month

    const userSignupsByMonth = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: sixMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 }
      },
      {
        $project: {
          _id: 0,
          month: {
            $concat: [
              { $toString: "$_id.year" },
              "-",
              {
                $cond: {
                  if: { $lt: ["$_id.month", 10] },
                  then: { $concat: ["0", { $toString: "$_id.month" }] },
                  else: { $toString: "$_id.month" }
                }
              }
            ]
          },
          count: 1
        }
      }
    ]);

    // Get system health metrics
    const systemHealth = {
      apiKeys: {
        google: process.env.GOOGLE_SEARCH_API_KEY ? 'configured' : 'missing',
        brave: process.env.BRAVE_API_KEY ? 'configured' : 'missing',
        signalHire: process.env.SIGNALHIRE_API_KEY ? 'configured' : 'missing',
        contactOut: process.env.CONTACTOUT_API_KEY ? 'configured' : 'missing',
        icypeas: process.env.ICYPEAS_API_KEY ? 'configured' : 'missing',
        openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing',
        gemini: process.env.GEMINI_API_KEY ? 'configured' : 'missing'
      }
    };

    res.status(StatusCodes.OK).json({
      userStats: {
        total: totalUsers,
        new: newUsers,
        verified: verifiedUsers,
        unverified: unverifiedUsers,
        zeroCredits: zeroCreditsUsers,
        trialEnded: trialEndedUsers,
        subscriptionBreakdown,
        signupsByMonth: userSignupsByMonth
      },
      creditStats: {
        issued: creditsIssued.length > 0 ? creditsIssued[0].total : 0,
        used: creditsUsed.length > 0 ? Math.abs(creditsUsed[0].total) : 0,
        remaining: creditsIssued.length > 0 && creditsUsed.length > 0 ?
          creditsIssued[0].total - Math.abs(creditsUsed[0].total) : 0,
        usageByOperation: creditUsageByOperation,
        dailyUsage: dailyCreditUsage,
        topConsumers: topCreditConsumers
      },
      recentTransactions,
      systemHealth
    });
  } catch (error) {
    console.error('Error getting dashboard overview:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get dashboard overview',
      details: error.message
    });
  }
};
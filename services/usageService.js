const User = require('../models/User');
const SearchUsage = require('../models/SearchUsage');
const { ForbiddenError, UnauthenticatedError } = require('../errors');

// Subscription limits using existing User model subscription names
const SUBSCRIPTION_LIMITS = {
    free: {
        monthlySearches: 2,
        dailySearches: 1,
    },
    basic: {
        monthlySearches: 10,
        dailySearches: 5,
    },
    pro: {
        monthlySearches: 25,
        dailySearches: 7,
    },
    enterprise: {
        monthlySearches: 50,
        dailySearches: 10,
    },
};

// Check if user can perform a search
exports.checkSearchLimits = async (userId) => {
    const user = await User.findById(userId);

    if (!user) {
        throw new UnauthenticatedError('User not found');
    }

    // Special case for your specific user ID
    const specificUserIds = ["68811dcdcd7c9603fbde2eeb", "687fae236c2df025fa30a880"]; // Array of specific user IDs
    let userLimits;

    if (specificUserIds.includes(userId.toString())) {
        // Custom limits for the specific users
        userLimits = {
            monthlySearches: 300, // 10 searches per day * 30 days
            dailySearches: 10     // 10 searches per day
        };
    } else {
        // Regular limits based on subscription
        userLimits = SUBSCRIPTION_LIMITS[user.subscription] || SUBSCRIPTION_LIMITS.free;
    }
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    // Get or create usage record for current month
    let monthlyUsage = await SearchUsage.findOne({
        userId,
        year,
        month,
    });

    if (!monthlyUsage) {
        monthlyUsage = new SearchUsage({
            userId,
            year,
            month,
            day,
            date: now,
            monthlySearches: 0,
            dailySearches: 0,
        });
    }

    // Get or create usage record for current day
    let dailyUsage = await SearchUsage.findOne({
        userId,
        year,
        month,
        day,
    });

    if (!dailyUsage) {
        dailyUsage = new SearchUsage({
            userId,
            year,
            month,
            day,
            date: now,
            monthlySearches: 0,
            dailySearches: 0,
        });
    }

    // Check limits
    if (monthlyUsage.monthlySearches >= userLimits.monthlySearches) {
        throw new ForbiddenError(`Monthly search limit reached. Your ${user.subscription} plan allows ${userLimits.monthlySearches} searches per month.`);
    }

    if (dailyUsage.dailySearches >= userLimits.dailySearches) {
        throw new ForbiddenError(`Daily search limit reached. Your ${user.subscription} plan allows ${userLimits.dailySearches} searches per day.`);
    }

    return {
        canSearch: true,
        limits: userLimits,
        usage: {
            monthlyUsed: monthlyUsage.monthlySearches,
            dailyUsed: dailyUsage.dailySearches,
        }
    };
};

// Record a search usage
exports.recordSearch = async (userId) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    // Update monthly usage
    await SearchUsage.findOneAndUpdate(
        { userId, year, month },
        {
            $inc: { monthlySearches: 1 },
            $set: { updatedAt: now },
            $setOnInsert: { day, date: now, dailySearches: 0 }
        },
        { upsert: true }
    );

    // Update daily usage
    await SearchUsage.findOneAndUpdate(
        { userId, year, month, day },
        {
            $inc: { dailySearches: 1 },
            $set: { updatedAt: now },
            $setOnInsert: { date: now, monthlySearches: 0 }
        },
        { upsert: true }
    );

    return true;
};

// Get user's search usage statistics
exports.getSearchUsage = async (userId) => {
    const user = await User.findById(userId);

    if (!user) {
        throw new UnauthenticatedError('User not found');
    }

    const userLimits = SUBSCRIPTION_LIMITS[user.subscription] || SUBSCRIPTION_LIMITS.free;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    // Get monthly usage
    const monthlyUsage = await SearchUsage.findOne({
        userId,
        year,
        month,
    });

    // Get daily usage
    const dailyUsage = await SearchUsage.findOne({
        userId,
        year,
        month,
        day,
    });

    return {
        subscription: user.subscription,
        limits: userLimits,
        usage: {
            monthly: {
                used: monthlyUsage ? monthlyUsage.monthlySearches : 0,
                limit: userLimits.monthlySearches,
                remaining: userLimits.monthlySearches - (monthlyUsage ? monthlyUsage.monthlySearches : 0),
            },
            daily: {
                used: dailyUsage ? dailyUsage.dailySearches : 0,
                limit: userLimits.dailySearches,
                remaining: userLimits.dailySearches - (dailyUsage ? dailyUsage.dailySearches : 0),
            }
        }
    };
};

// Reset usage for testing (admin only)
exports.resetUserUsage = async (userId) => {
    await SearchUsage.deleteMany({ userId });
    return true;
};

module.exports.SUBSCRIPTION_LIMITS = SUBSCRIPTION_LIMITS; 
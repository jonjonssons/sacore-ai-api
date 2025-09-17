const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');

// Credit amounts by plan
const PLAN_CREDITS = {
    'basic': 500,
    'explorer': 1500,
    'pro': 6500,
    'free': 100
};

/**
 * Check and reset credits for yearly users based on their individual subscription dates
 */
const checkAndResetYearlyUserCredits = async () => {
    try {
        console.log('🔄 Checking users for scheduler-based credit resets...');

        const today = new Date();
        const currentDay = today.getDate();

        // Find users that need scheduler-based resets
        const usersNeedingSchedulerReset = await User.find({
            $or: [
                // Yearly users (all of them - both Stripe and admin)
                {
                    billingInterval: 'yearly',
                    subscription: { $in: ['basic', 'explorer', 'pro'] }
                },
                // Monthly users WITHOUT Stripe (admin-managed only)
                {
                    billingInterval: 'monthly',
                    subscription: { $in: ['basic', 'explorer', 'pro'] },
                    $or: [
                        { stripeCustomerId: { $exists: false } },
                        { stripeCustomerId: null }
                    ]
                }
            ],
            subscriptionStartDate: { $exists: true, $ne: null }
        });

        console.log(`📊 Checking ${usersNeedingSchedulerReset.length} users for scheduler-based resets`);

        let resetCount = 0;
        let errorCount = 0;

        // Check each user's individual anniversary date
        for (const user of usersNeedingSchedulerReset) {
            try {
                const subscriptionDay = user.subscriptionStartDate.getDate();

                // Handle edge case: if subscribed on 31st but current month has fewer days
                const actualResetDay = Math.min(subscriptionDay, new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate());

                // Check if today is their monthly anniversary
                const shouldReset = currentDay === actualResetDay;

                // Also check if we somehow missed their date (prevent skipping months)
                const daysSinceLastReset = user.lastCreditReset ?
                    Math.floor((today - user.lastCreditReset) / (1000 * 60 * 60 * 24)) : 999;
                const overdue = daysSinceLastReset >= 30; // More than 30 days since last reset

                if (shouldReset || overdue) {
                    const originalCredits = user.credits;
                    const planCredits = PLAN_CREDITS[user.subscription] || 100;

                    // Log expired credits if any
                    if (originalCredits > 0) {
                        await CreditTransaction.create({
                            user: user._id,
                            amount: -originalCredits,
                            type: 'MONTHLY_RESET',
                            description: `Monthly reset (${user.billingInterval.charAt(0).toUpperCase() + user.billingInterval.slice(1)} Plan) - ${originalCredits} unused credits expired`,
                            balance: 0,
                            createdAt: new Date()
                        });
                    }

                    // Reset to plan amount
                    user.credits = planCredits;
                    user.lastCreditReset = new Date();
                    await user.save();

                    // Log new credits
                    await CreditTransaction.create({
                        user: user._id,
                        amount: planCredits,
                        type: 'MONTHLY_RESET',
                        description: `Monthly reset (${user.billingInterval.charAt(0).toUpperCase() + user.billingInterval.slice(1)} Plan) - ${planCredits} fresh credits allocated`,
                        balance: planCredits,
                        createdAt: new Date()
                    });

                    const resetReason = overdue ? 'OVERDUE' : 'SCHEDULED';
                    const userType = user.stripeCustomerId ? 'Stripe' : 'Admin';
                    console.log(`✅ User ${user.email} [${userType} ${user.billingInterval}] (${resetReason}): ${originalCredits} → ${planCredits} credits`);
                    resetCount++;
                }

            } catch (error) {
                console.error(`❌ Error resetting credits for user ${user.email}:`, error.message);
                errorCount++;
            }
        }

        if (resetCount > 0 || errorCount > 0) {
            console.log(`🎯 Credit reset completed: ${resetCount} reset, ${errorCount} errors`);
        }

        return {
            totalUsers: usersNeedingSchedulerReset.length,
            successCount: resetCount,
            errorCount: errorCount
        };

    } catch (error) {
        console.error('❌ Error in scheduler-based credit reset check:', error);
        throw error;
    }
};

module.exports = {
    checkAndResetYearlyUserCredits
};

const { checkAndResetYearlyUserCredits } = require('./creditResetService');

// Daily credit reset check for yearly subscribers
const dailyYearlyCreditCheck = async () => {
    try {
        const result = await checkAndResetYearlyUserCredits();
        if (result.successCount > 0) {
            console.log('📊 Daily credit check result:', result);
        }
    } catch (error) {
        console.error('❌ Error in daily yearly credit check:', error);
    }
};

// Start the scheduler
const startScheduler = () => {

    // Check yearly user credits daily at 3 AM
    setInterval(() => {
        const now = new Date();
        const is3AM = now.getHours() === 3;
        const isFirstMinute = now.getMinutes() === 0;

        if (is3AM && isFirstMinute) {
            dailyYearlyCreditCheck();
        }
    }, 60 * 1000); // Check every minute

    console.log('🚀 Scheduler started: individual credit resets');
};

module.exports = { startScheduler };
const campaignService = require('./campaignService');
const { checkAndResetUserCredits } = require('./creditResetService');
const linkedinReplyMonitor = require('./linkedinReplyMonitor');
const extensionHealthMonitor = require('./extensionHealthMonitor');
// Process scheduled actions every minute
const processScheduledActions = async () => {
    console.log('🔄 [Scheduler] Running at:', new Date().toISOString());
    try {
        await campaignService.processScheduledActions();
    } catch (error) {
        console.error('Error processing scheduled actions:', error);
    }
};

// Check for email replies every 5 minutes
const checkEmailReplies = async () => {
    try {
        const Campaign = require('../models/Campaign');
        const ConnectedAccount = require('../models/ConnectedAccount');
        const campaignService = require('./campaignService');

        // Get active campaigns
        const activeCampaigns = await Campaign.find({ status: 'active' });
        console.log(`🔍 Checking ${activeCampaigns.length} active campaigns for email replies`);

        // Group campaigns by email account to avoid duplicate token refreshes
        const campaignsByAccount = new Map();

        for (const campaign of activeCampaigns) {
            // Get email account for this campaign
            let emailAccountId;
            if (campaign.emailAccountId) {
                emailAccountId = campaign.emailAccountId.toString();
            } else {
                // Find default account for this user
                const defaultAccount = await ConnectedAccount.findOne({
                    userId: campaign.userId,
                    type: 'email',
                    isDefault: true,
                    isActive: true
                });
                emailAccountId = defaultAccount?._id.toString();
            }

            if (emailAccountId) {
                if (!campaignsByAccount.has(emailAccountId)) {
                    campaignsByAccount.set(emailAccountId, []);
                }
                campaignsByAccount.get(emailAccountId).push(campaign);
            }
        }

        // Process each email account once
        for (const [emailAccountId, campaigns] of campaignsByAccount) {
            try {
                const emailAccount = await ConnectedAccount.findById(emailAccountId);
                if (!emailAccount) continue;

                // Refresh token once per account
                await campaignService.refreshGmailToken(emailAccount);
                console.log(`🔄 Token refreshed for account ${emailAccountId} (${campaigns.length} campaigns)`);

                // Check all campaigns for this account
                for (const campaign of campaigns) {
                    await campaignService.checkForEmailReplies(campaign);
                }
            } catch (error) {
                console.error(`❌ Error processing account ${emailAccountId}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error in reply checking job:', error);
    }
};

// Check for LinkedIn replies every 30 minutes
const checkLinkedInReplies = async () => {
    try {
        await linkedinReplyMonitor.checkLinkedInReplies();
    } catch (error) {
        console.error('❌ Error in LinkedIn reply checking:', error);
    }
};

// Check extension health every 2 minutes
const checkExtensionHealth = async () => {
    try {
        await extensionHealthMonitor.checkExtensionHealth();
    } catch (error) {
        console.error('❌ Error in extension health checking:', error);
    }
};

// Daily credit reset check for yearly subscribers
const dailyYearlyCreditCheck = async () => {
    try {
        const result = await checkAndResetUserCredits();
        if (result.successCount > 0) {
            console.log('📊 Daily credit check result:', result);
        }
    } catch (error) {
        console.error('❌ Error in daily yearly credit check:', error);
    }
};

// Start the scheduler
const startScheduler = () => {
    // Process scheduled actions every minute
    setInterval(processScheduledActions, 60000);

    // Check for email replies every 5 minutes
    setInterval(checkEmailReplies, 5 * 60 * 1000);

    // Check for LinkedIn replies every 30 minutes
    setInterval(checkLinkedInReplies, 30 * 60 * 1000);

    // Check extension health every 30 minutes
    setInterval(checkExtensionHealth, 30 * 60 * 1000);

    // Check yearly user credits daily at 3 AM
    setInterval(() => {
        const now = new Date();
        const is3AM = now.getHours() === 4;
        const isFirstMinute = now.getMinutes() === 0;

        if (is3AM && isFirstMinute) {
            dailyYearlyCreditCheck();
        }
    }, 60 * 1000); // Check every minute

    console.log('🚀 Scheduler started: campaigns + email/LinkedIn replies + extension health + credit resets');
};

module.exports = { startScheduler };
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const CampaignExecution = require('../models/CampaignExecution');
const LinkedInInstruction = require('../models/LinkedInInstruction');

/**
 * Extension Health Monitor Service
 * 
 * Monitors LinkedIn extension connectivity and automatically:
 * - Pauses campaigns when extension goes offline
 * - Resumes campaigns when extension comes back online
 * - Cancels pending instructions to prevent queue pile-up
 */

const EXTENSION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Check extension health for all users
 * Run every 2 minutes to detect offline extensions
 */
exports.checkExtensionHealth = async () => {
    try {
        console.log('🔍 [Extension Health] Checking extension health for all users...');

        const now = new Date();
        const timeoutThreshold = new Date(now.getTime() - EXTENSION_TIMEOUT_MS);

        // Find users whose extension was active but hasn't been seen recently
        const inactiveUsers = await User.find({
            'linkedInExtensionStatus.isActive': true,
            'linkedInExtensionStatus.lastSeen': { $lt: timeoutThreshold }
        });

        if (inactiveUsers.length === 0) {
            console.log('✅ [Extension Health] All extensions are healthy');
            return { usersChecked: 0, campaignsPaused: 0 };
        }

        console.log(`⚠️ [Extension Health] Found ${inactiveUsers.length} users with inactive extensions`);

        let totalCampaignsPaused = 0;

        for (const user of inactiveUsers) {
            try {
                const result = await handleExtensionOffline(user._id);
                totalCampaignsPaused += result.campaignsPaused;
            } catch (error) {
                console.error(`❌ [Extension Health] Error handling offline extension for user ${user._id}:`, error);
            }
        }

        console.log(`✅ [Extension Health] Completed. Paused ${totalCampaignsPaused} campaigns for ${inactiveUsers.length} users`);

        return {
            usersChecked: inactiveUsers.length,
            campaignsPaused: totalCampaignsPaused
        };

    } catch (error) {
        console.error('❌ [Extension Health] Error in checkExtensionHealth:', error);
        throw error;
    }
};

/**
 * Handle extension going offline for a specific user
 */
async function handleExtensionOffline(userId) {
    console.log(`⏸️ [Extension Offline] Handling offline extension for user ${userId}`);

    // Find all active campaigns for this user
    const activeCampaigns = await Campaign.find({
        userId: userId,
        status: 'active'
    });

    if (activeCampaigns.length === 0) {
        console.log(`✅ [Extension Offline] No active campaigns for user ${userId}`);

        // Update user status to inactive
        await User.findByIdAndUpdate(userId, {
            'linkedInExtensionStatus.isActive': false,
            'linkedInExtensionStatus.lastDisconnectedAt': new Date()
        });

        return { campaignsPaused: 0 };
    }

    console.log(`📊 [Extension Offline] Found ${activeCampaigns.length} active campaigns to pause`);

    let campaignsPaused = 0;

    // Pause each campaign
    for (const campaign of activeCampaigns) {
        try {
            // Update campaign status
            campaign.status = 'paused';
            campaign.pausedAt = new Date();
            campaign.pauseReason = 'extension_offline';
            campaign.autoresumeWhenOnline = true;
            await campaign.save();

            // Pause all running/waiting executions for this campaign
            await CampaignExecution.updateMany(
                {
                    campaignId: campaign._id,
                    status: { $in: ['waiting', 'running'] }
                },
                {
                    $set: {
                        status: 'paused',
                        pauseReason: 'extension_offline'
                    },
                    $push: {
                        executionHistory: {
                            action: 'paused',
                            status: 'paused',
                            timestamp: new Date(),
                            reason: 'Extension went offline'
                        }
                    }
                }
            );

            // Cancel all pending LinkedIn instructions for this user
            const cancelResult = await LinkedInInstruction.updateMany(
                {
                    userId: userId,
                    campaignId: campaign._id,
                    status: 'pending'
                },
                {
                    $set: {
                        status: 'cancelled',
                        result: {
                            success: false,
                            error: 'Extension went offline',
                            cancelledAt: new Date(),
                            cancelReason: 'extension_offline'
                        }
                    }
                }
            );

            console.log(`✅ [Extension Offline] Paused campaign ${campaign._id}, cancelled ${cancelResult.modifiedCount} pending instructions`);
            campaignsPaused++;

        } catch (error) {
            console.error(`❌ [Extension Offline] Error pausing campaign ${campaign._id}:`, error);
        }
    }

    // Update user status to inactive
    await User.findByIdAndUpdate(userId, {
        'linkedInExtensionStatus.isActive': false,
        'linkedInExtensionStatus.lastDisconnectedAt': new Date()
    });

    console.log(`✅ [Extension Offline] Completed for user ${userId}: ${campaignsPaused} campaigns paused`);

    return { campaignsPaused };
}

/**
 * Handle extension reconnecting (called when extension polls after being offline)
 */
exports.handleExtensionReconnect = async (userId) => {
    try {
        console.log(`🔄 [Extension Reconnect] Handling reconnection for user ${userId}`);

        const user = await User.findById(userId);

        if (!user) {
            console.log(`❌ [Extension Reconnect] User ${userId} not found`);
            return { success: false, error: 'User not found' };
        }

        // Check if this is actually a reconnection (was previously offline)
        const wasOffline = user.linkedInExtensionStatus?.isActive === false;

        // Update user status to active
        await User.findByIdAndUpdate(userId, {
            'linkedInExtensionStatus.isActive': true,
            'linkedInExtensionStatus.lastSeen': new Date(),
            'linkedInExtensionStatus.lastConnectedAt': new Date()
        });

        // If extension was not offline, just update timestamp and return
        if (!wasOffline) {
            return {
                success: true,
                wasOffline: false,
                campaignsResumed: 0
            };
        }

        console.log(`✅ [Extension Reconnect] Extension reconnected for user ${userId}, checking for campaigns to resume`);

        // Find campaigns that should be auto-resumed
        const campaignsToResume = await Campaign.find({
            userId: userId,
            status: 'paused',
            autoresumeWhenOnline: true
        });

        if (campaignsToResume.length === 0) {
            console.log(`✅ [Extension Reconnect] No campaigns to auto-resume for user ${userId}`);
            return {
                success: true,
                wasOffline: true,
                campaignsResumed: 0
            };
        }

        console.log(`📊 [Extension Reconnect] Found ${campaignsToResume.length} campaigns to resume`);

        let campaignsResumed = 0;

        for (const campaign of campaignsToResume) {
            try {
                // Update campaign status
                campaign.status = 'active';
                campaign.resumedAt = new Date();
                campaign.lastResumed = new Date();
                campaign.autoresumeWhenOnline = false;
                campaign.pauseReason = 'manual'; // Reset to default
                await campaign.save();

                // Find all paused executions for this campaign
                const pausedExecutions = await CampaignExecution.find({
                    campaignId: campaign._id,
                    status: 'paused',
                    pauseReason: 'extension_offline'
                });

                console.log(`📊 [Extension Reconnect] Found ${pausedExecutions.length} paused executions for campaign ${campaign._id}`);

                // Process each execution individually
                for (const execution of pausedExecutions) {
                    try {
                        // Check if execution was waiting for an instruction
                        const wasWaitingForInstruction = execution.waitingFor && execution.waitingJobId;

                        if (wasWaitingForInstruction) {
                            // Check if the instruction was cancelled
                            const instruction = await LinkedInInstruction.findById(execution.waitingJobId);

                            if (instruction && instruction.status === 'cancelled') {
                                console.log(`🔄 [Extension Reconnect] Execution ${execution._id} was waiting for cancelled instruction. Retrying step...`);

                                // Clear waiting state and retry the current node
                                execution.status = 'running';
                                execution.pauseReason = undefined;
                                execution.waitingFor = undefined;
                                execution.waitingJobId = undefined;
                                execution.lastActivity = new Date();

                                // Add history entry
                                execution.executionHistory.push({
                                    action: 'resumed_with_retry',
                                    status: 'running',
                                    timestamp: new Date(),
                                    reason: 'Extension reconnected - retrying cancelled instruction'
                                });

                                await execution.save();

                                // Trigger immediate reprocessing of the current node
                                const campaignService = require('./campaignService');
                                setImmediate(() => campaignService.processProspectNode(execution));

                            } else {
                                // Instruction still pending or already processed - just resume
                                console.log(`✅ [Extension Reconnect] Execution ${execution._id} resuming normally`);
                                execution.status = 'running';
                                execution.pauseReason = undefined;
                                execution.lastActivity = new Date();

                                execution.executionHistory.push({
                                    action: 'resumed',
                                    status: 'running',
                                    timestamp: new Date(),
                                    reason: 'Extension reconnected'
                                });

                                await execution.save();
                            }
                        } else {
                            // Not waiting for anything - just resume
                            console.log(`✅ [Extension Reconnect] Execution ${execution._id} resuming (no pending instruction)`);
                            execution.status = 'running';
                            execution.pauseReason = undefined;
                            execution.lastActivity = new Date();

                            execution.executionHistory.push({
                                action: 'resumed',
                                status: 'running',
                                timestamp: new Date(),
                                reason: 'Extension reconnected'
                            });

                            await execution.save();

                            // Trigger processing to continue from where it left off
                            const campaignService = require('./campaignService');
                            setImmediate(() => campaignService.processProspectNode(execution));
                        }

                    } catch (execError) {
                        console.error(`❌ [Extension Reconnect] Error resuming execution ${execution._id}:`, execError);
                    }
                }

                console.log(`✅ [Extension Reconnect] Resumed campaign ${campaign._id}`);
                campaignsResumed++;

            } catch (error) {
                console.error(`❌ [Extension Reconnect] Error resuming campaign ${campaign._id}:`, error);
            }
        }

        console.log(`✅ [Extension Reconnect] Completed for user ${userId}: ${campaignsResumed} campaigns resumed`);

        return {
            success: true,
            wasOffline: true,
            campaignsResumed: campaignsResumed
        };

    } catch (error) {
        console.error(`❌ [Extension Reconnect] Error handling reconnection for user ${userId}:`, error);
        return {
            success: false,
            error: error.message
        };
    }
};

/**
 * Update extension heartbeat (called on every extension poll)
 */
exports.updateExtensionHeartbeat = async (userId) => {
    try {
        await User.findByIdAndUpdate(userId, {
            'linkedInExtensionStatus.lastSeen': new Date()
        });
        return { success: true };
    } catch (error) {
        console.error(`❌ [Extension Heartbeat] Error updating heartbeat for user ${userId}:`, error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    checkExtensionHealth: exports.checkExtensionHealth,
    handleExtensionReconnect: exports.handleExtensionReconnect,
    updateExtensionHeartbeat: exports.updateExtensionHeartbeat
};


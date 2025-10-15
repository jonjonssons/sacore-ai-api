const LinkedInInstruction = require('../models/LinkedInInstruction');
const rateLimitService = require('./rateLimitService');

class LinkedInInstructionService {
    // Create LinkedIn invitation instruction (replaces queue job)
    async createInvitationInstruction(data) {
        const { userId, campaignId, prospectId, executionId, profileUrl, message, nodeId, nextNodeId, campaign } = data;

        console.log(`📝 Creating invitation instruction for ${profileUrl}`);

        // Get campaign settings for timing calculation
        const workingHours = campaign?.linkedinSettings?.workingHours || {
            enabled: true,
            start: 9,
            end: 18,
            timezone: 'UTC',
            weekendsEnabled: false
        };

        // Get campaign delay settings or use defaults
        const invitationDelay = campaign?.linkedinSettings?.delaySettings?.invitations || {
            minDelay: 900000,   // 15 minutes default
            maxDelay: 1800000   // 30 minutes default
        };
        // Calculate random delay between min and max
        const baseDelay = Math.floor(Math.random() * (invitationDelay.maxDelay - invitationDelay.minDelay + 1)) + invitationDelay.minDelay;
        const scheduledTime = await this.calculateScheduledTime(userId, 'send_invitation', baseDelay, workingHours);

        // Get user's rate limits
        const rateLimitService = require('./rateLimitService');
        const userLimits = await rateLimitService.getUserRateLimits(userId, 'invitation');

        // Extract profile ID from URL if possible
        const profileId = this.extractProfileId(profileUrl);

        // Create instruction
        const instruction = await LinkedInInstruction.create({
            userId: userId,
            campaignId: campaignId,
            prospectId: prospectId,
            executionId: executionId,
            action: 'send_invitation',
            profileUrl: profileUrl,
            profileId: profileId,
            message: message,
            customNote: message, // For invitations, message is the custom note
            scheduledFor: new Date(scheduledTime),
            timezone: workingHours.timezone,
            workingHoursOnly: workingHours.enabled,
            weekendsEnabled: workingHours.weekendsEnabled,
            rateLimitContext: {
                hourlyLimit: userLimits.HOURLY,
                dailyLimit: userLimits.DAILY,
                weeklyLimit: userLimits.WEEKLY,
                actionType: 'invitation'
            },
            nodeId: nodeId,
            nextNodeId: nextNodeId,
            workingHours: workingHours
        });

        console.log(`✅ Created invitation instruction ${instruction._id} scheduled for ${new Date(scheduledTime).toISOString()}`);

        return {
            success: true,
            instructionId: instruction._id,
            scheduledFor: new Date(scheduledTime),
            delay: scheduledTime - Date.now()
        };
    }

    // Create LinkedIn message instruction (replaces queue job)
    async createMessageInstruction(data) {
        const { userId, campaignId, prospectId, executionId, profileUrl, targetProfileUrn, message, nodeId, nextNodeId, campaign } = data;

        console.log(`📝 Creating message instruction for ${profileUrl}`);

        // Get campaign settings for timing calculation
        const workingHours = campaign?.linkedinSettings?.workingHours || {
            enabled: true,
            start: 9,
            end: 18,
            timezone: 'UTC',
            weekendsEnabled: false
        };

        // Get campaign delay settings or use defaults
        const messageDelay = campaign?.linkedinSettings?.delaySettings?.messages || {
            minDelay: 120000,  // 2 minutes default
            maxDelay: 300000   // 5 minutes default
        };
        // Calculate random delay between min and max
        const baseDelay = Math.floor(Math.random() * (messageDelay.maxDelay - messageDelay.minDelay + 1)) + messageDelay.minDelay;
        const scheduledTime = await this.calculateScheduledTime(userId, 'send_message', baseDelay, workingHours);

        // Get user's rate limits
        const rateLimitService = require('./rateLimitService');
        const userLimits = await rateLimitService.getUserRateLimits(userId, 'message');

        // Extract profile ID and conversation ID
        const profileId = this.extractProfileId(profileUrl) || targetProfileUrn;
        const conversationId = await this.getOrCreateConversationId(userId, profileId);

        // Create instruction
        const instruction = await LinkedInInstruction.create({
            userId: userId,
            campaignId: campaignId,
            prospectId: prospectId,
            executionId: executionId,
            action: 'send_message',
            profileUrl: profileUrl,
            profileId: profileId,
            conversationId: conversationId,
            message: message,
            scheduledFor: new Date(scheduledTime),
            timezone: workingHours.timezone,
            workingHoursOnly: workingHours.enabled,
            weekendsEnabled: workingHours.weekendsEnabled,
            rateLimitContext: {
                hourlyLimit: userLimits.HOURLY,
                dailyLimit: userLimits.DAILY,
                weeklyLimit: userLimits.WEEKLY,
                actionType: 'message'
            },
            nodeId: nodeId,
            nextNodeId: nextNodeId,
            workingHours: workingHours
        });

        console.log(`✅ Created message instruction ${instruction._id} scheduled for ${new Date(scheduledTime).toISOString()}`);

        return {
            success: true,
            instructionId: instruction._id,
            scheduledFor: new Date(scheduledTime),
            delay: scheduledTime - Date.now()
        };
    }

    // Create profile visit instruction
    async createVisitInstruction(data) {
        const { userId, campaignId, prospectId, executionId, profileUrl, nodeId, nextNodeId, campaign } = data;

        console.log(`📝 Creating visit instruction for ${profileUrl}`);

        // Get campaign settings
        const workingHours = campaign?.linkedinSettings?.workingHours || {
            enabled: true,
            start: 9,
            end: 18,
            timezone: 'UTC',
            weekendsEnabled: false
        };

        // Calculate scheduled time
        const baseDelay = 10 * 1000; // 10 seconds base delay for visits
        const scheduledTime = await this.calculateScheduledTime(userId, 'visit_profile', baseDelay, workingHours);

        // Get user's rate limits
        const rateLimitService = require('./rateLimitService');
        const userLimits = await rateLimitService.getUserRateLimits(userId, 'visit');

        const profileId = this.extractProfileId(profileUrl);

        const instruction = await LinkedInInstruction.create({
            userId: userId,
            campaignId: campaignId,
            prospectId: prospectId,
            executionId: executionId,
            action: 'visit_profile',
            profileUrl: profileUrl,
            profileId: profileId,
            scheduledFor: new Date(scheduledTime),
            timezone: workingHours.timezone,
            workingHoursOnly: workingHours.enabled,
            weekendsEnabled: workingHours.weekendsEnabled,
            rateLimitContext: {
                hourlyLimit: userLimits.HOURLY,
                dailyLimit: userLimits.DAILY,
                weeklyLimit: userLimits.WEEKLY,
                actionType: 'visit'
            },
            nodeId: nodeId,
            nextNodeId: nextNodeId,
            workingHours: workingHours
        });

        console.log(`✅ Created visit instruction ${instruction._id} scheduled for ${new Date(scheduledTime).toISOString()}`);

        return {
            success: true,
            instructionId: instruction._id,
            scheduledFor: new Date(scheduledTime),
            delay: scheduledTime - Date.now()
        };
    }

    // Calculate scheduled time (preserve all existing timing logic)
    async calculateScheduledTime(userId, action, baseDelay, workingHours) {
        try {
            // Get next available slot using existing Redis logic
            const nextSlot = await rateLimitService.getNextAvailableSlot(userId, action, baseDelay);
            let scheduledTime = nextSlot;

            // Apply working hours if enabled (preserve existing logic)
            if (workingHours && workingHours.enabled) {
                const workingTime = rateLimitService.getNextWorkingHour(workingHours);
                scheduledTime = Math.max(scheduledTime, workingTime);
            }

            return scheduledTime;

        } catch (error) {
            console.error('❌ Error calculating scheduled time:', error);
            // Fallback to simple delay
            return Date.now() + baseDelay;
        }
    }

    // Extract LinkedIn profile ID from URL
    extractProfileId(profileUrl) {
        if (!profileUrl) return null;

        // Extract from various LinkedIn URL formats
        const patterns = [
            /\/in\/([^\/\?]+)/,           // /in/john-doe
            /\/profile\/view\?id=([^&]+)/, // /profile/view?id=123
            /ACoAA([A-Za-z0-9_-]+)/       // Direct profile ID
        ];

        for (const pattern of patterns) {
            const match = profileUrl.match(pattern);
            if (match) {
                return match[1];
            }
        }

        return null;
    }

    // Get or create conversation ID (placeholder - will be handled by extension)
    async getOrCreateConversationId(userId, profileId) {
        // The extension will handle conversation ID resolution
        // This is just a placeholder for the instruction
        return `conversation_${profileId}`;
    }

    // Check if user has extension connected (placeholder)
    async isExtensionConnected(userId) {
        // Check for recent instruction activity as proxy for extension connection
        const recentActivity = await LinkedInInstruction.countDocuments({
            userId: userId,
            sentToExtensionAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } // Last 10 minutes
        });

        return recentActivity > 0;
    }

    // Get pending instruction count for user
    async getPendingInstructionCount(userId) {
        return await LinkedInInstruction.countDocuments({
            userId: userId,
            status: 'pending'
        });
    }

    // Cancel pending instructions for campaign
    async cancelCampaignInstructions(campaignId) {
        const result = await LinkedInInstruction.updateMany(
            { campaignId: campaignId, status: { $in: ['pending', 'processing'] } },
            {
                status: 'cancelled',
                result: {
                    success: false,
                    error: 'Campaign cancelled',
                    cancelled: true
                }
            }
        );

        console.log(`🚫 Cancelled ${result.modifiedCount} instructions for campaign ${campaignId}`);
        return result.modifiedCount;
    }

    // Pause instructions for campaign
    async pauseCampaignInstructions(campaignId) {
        const result = await LinkedInInstruction.updateMany(
            { campaignId: campaignId, status: 'pending' },
            { status: 'throttled' } // Use throttled status for paused
        );

        console.log(`⏸️ Paused ${result.modifiedCount} instructions for campaign ${campaignId}`);
        return result.modifiedCount;
    }

    // Resume instructions for campaign
    async resumeCampaignInstructions(campaignId) {
        const result = await LinkedInInstruction.updateMany(
            { campaignId: campaignId, status: 'throttled' },
            { status: 'pending' }
        );

        console.log(`▶️ Resumed ${result.modifiedCount} instructions for campaign ${campaignId}`);
        return result.modifiedCount;
    }
}

module.exports = new LinkedInInstructionService();

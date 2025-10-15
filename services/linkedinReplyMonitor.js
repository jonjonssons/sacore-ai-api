const Campaign = require('../models/Campaign');
const CampaignExecution = require('../models/CampaignExecution');
const LinkedInInstruction = require('../models/LinkedInInstruction');

// Cache to avoid checking same prospect multiple times
const replyCheckCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

/**
 * Main function: Check LinkedIn replies for active prospects
 */
exports.checkLinkedInReplies = async () => {
    try {
        console.log('🔍 [LinkedIn Reply Monitor] Starting reply check...');

        // Get prospects that need checking
        const prospectsToCheck = await getProspectsToCheck();

        if (prospectsToCheck.length === 0) {
            console.log('✅ [LinkedIn Reply Monitor] No prospects to check');
            return;
        }

        console.log(`📊 [LinkedIn Reply Monitor] Checking ${prospectsToCheck.length} prospects`);

        // Check in small batches to avoid overwhelming extension
        const BATCH_SIZE = 5;
        let totalRepliesFound = 0;

        for (let i = 0; i < prospectsToCheck.length; i += BATCH_SIZE) {
            const batch = prospectsToCheck.slice(i, i + BATCH_SIZE);

            for (const item of batch) {
                try {
                    const hasReply = await checkSingleProspect(item);
                    if (hasReply) {
                        totalRepliesFound++;
                        await updateProspectStatus(item.campaign._id, item.prospect._id);
                    }

                    // Update cache
                    const cacheKey = `${item.campaign._id}_${item.prospect._id}`;
                    replyCheckCache.set(cacheKey, Date.now());

                } catch (error) {
                    console.error(`❌ Error checking prospect ${item.prospect._id}:`, error.message);
                }
            }

            // Wait 3 seconds between batches
            if (i + BATCH_SIZE < prospectsToCheck.length) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        console.log(`✅ [LinkedIn Reply Monitor] Completed. Found ${totalRepliesFound} new replies`);

    } catch (error) {
        console.error('❌ [LinkedIn Reply Monitor] Error:', error);
    }
};

/**
 * Get list of prospects that need reply checking
 */
async function getProspectsToCheck() {
    // Only check prospects contacted in last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const campaigns = await Campaign.find({
        status: 'active',
        'prospects.lastContacted': { $gte: sevenDaysAgo },
        'prospects.status': {
            $in: ['linkedin_message_sent', 'contacted', 'linkedin_connected']
        }
    }).select('_id userId prospects').lean();

    const prospectsToCheck = [];

    for (const campaign of campaigns) {
        const prospects = campaign.prospects.filter(p => {
            // Filter criteria
            if (!p.linkedin) return false;
            if (!['linkedin_message_sent', 'contacted', 'linkedin_connected'].includes(p.status)) return false;
            if (!p.lastContacted || p.lastContacted < sevenDaysAgo) return false;

            // Check cache
            const cacheKey = `${campaign._id}_${p._id}`;
            const cachedTime = replyCheckCache.get(cacheKey);
            if (cachedTime && (Date.now() - cachedTime < CACHE_DURATION)) {
                return false; // Skip, checked recently
            }

            return true;
        });

        prospectsToCheck.push(...prospects.map(p => ({
            campaign: { _id: campaign._id, userId: campaign.userId },
            prospect: p
        })));
    }

    return prospectsToCheck;
}

/**
 * Check a single prospect for replies
 */
async function checkSingleProspect(item) {
    const { campaign, prospect } = item;

    try {
        // Find the most recent completed message instruction to get conversation URN
        const LinkedInInstruction = require('../models/LinkedInInstruction');
        const CampaignExecution = require('../models/CampaignExecution');
        const mongoose = require('mongoose');

        const previousMessageInstruction = await LinkedInInstruction.findOne({
            campaignId: campaign._id,
            prospectId: prospect._id,
            action: 'send_message',
            status: 'completed',
            'result.conversationUrn': { $exists: true, $ne: null }
        }).sort({ completedAt: -1 }).lean();

        if (!previousMessageInstruction?.result?.conversationUrn) {
            console.log(`⚠️ No conversation URN found for ${prospect.name} - Message may not have been sent yet`);
            return false;
        }

        const conversationUrn = previousMessageInstruction.result.conversationUrn;

        // Find or get execution ID
        let execution = await CampaignExecution.findOne({
            campaignId: campaign._id,
            prospectId: prospect._id.toString()
        }).lean();

        // If no execution exists, create a placeholder executionId
        const executionId = execution?._id || new mongoose.Types.ObjectId();

        console.log(`🔍 Checking replies for: ${prospect.name} (${prospect.linkedin})`);

        // Create instruction for extension to check replies
        const instruction = new LinkedInInstruction({
            userId: campaign.userId,
            campaignId: campaign._id,
            prospectId: prospect._id,
            executionId: executionId, // ← ADD THIS
            action: 'check_replies',
            profileUrl: prospect.linkedin,
            conversationUrn: conversationUrn,
            scheduledFor: new Date(),
            status: 'pending'
        });

        await instruction.save();

        // Wait for extension to process
        const result = await waitForInstructionCompletion(instruction._id, 25000);

        if (result && (result.hasReplies === true || result.replyCount > 0)) {
            console.log(`✅ Reply detected for: ${prospect.name}`);
            return true;
        }

        return false;

    } catch (error) {
        console.error(`❌ Error checking prospect ${prospect._id}:`, error.message);
        return false;
    }
}

/**
 * Wait for instruction to be completed by extension
 */
async function waitForInstructionCompletion(instructionId, maxWaitTime = 25000) {
    const pollInterval = 2000;
    let waitedTime = 0;

    while (waitedTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waitedTime += pollInterval;

        const instruction = await LinkedInInstruction.findById(instructionId);

        if (!instruction) {
            throw new Error('Instruction not found');
        }

        if (instruction.status === 'completed') {
            return instruction.result || {};
        }

        if (instruction.status === 'failed') {
            console.log(`⚠️ Instruction failed: ${instruction.error}`);
            return null;
        }
    }

    console.log('⏱️ Instruction timeout');
    return null;
}

/**
 * Update prospect status to "replied"
 */
async function updateProspectStatus(campaignId, prospectId) {
    try {
        const result = await Campaign.updateOne(
            {
                _id: campaignId,
                'prospects._id': prospectId
            },
            {
                $set: {
                    'prospects.$.status': 'replied',
                    'prospects.$.lastContacted': new Date()
                }
            }
        );

        if (result.modifiedCount > 0) {
            console.log(`✅ Updated prospect ${prospectId} status to "replied"`);

            // Optional: Pause the campaign execution for this prospect
            await CampaignExecution.updateOne(
                {
                    campaignId: campaignId,
                    prospectId: prospectId.toString(),
                    status: { $in: ['running', 'waiting'] }
                },
                {
                    $set: {
                        status: 'paused',
                        pausedAt: new Date()
                    }
                }
            );

            return true;
        }

        return false;

    } catch (error) {
        console.error(`❌ Error updating prospect status:`, error);
        return false;
    }
}

module.exports = exports;


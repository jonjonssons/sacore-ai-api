const LinkedInInstruction = require('../models/LinkedInInstruction');
const Campaign = require('../models/Campaign');
const CampaignExecution = require('../models/CampaignExecution');
const rateLimitService = require('../services/rateLimitService');
const campaignService = require('../services/campaignService');
const extensionHealthMonitor = require('../services/extensionHealthMonitor');
const { BadRequestError, NotFoundError } = require('../errors');

// Get pending instructions for extension
exports.getInstructions = async (req, res) => {
    try {
        const userId = req.user.userId;
        const limit = parseInt(req.query.limit) || 10;

        console.log(`📥 Extension polling for instructions - User: ${userId}`);

        // Handle extension heartbeat and reconnection
        const reconnectResult = await extensionHealthMonitor.handleExtensionReconnect(userId);

        // Update heartbeat
        await extensionHealthMonitor.updateExtensionHeartbeat(userId);

        // Get instructions that are ready to execute
        const now = new Date();
        const readyInstructions = await LinkedInInstruction.find({
            userId: userId,
            status: 'pending',
            scheduledFor: { $lte: now }
        })
            .sort({ scheduledFor: 1, createdAt: 1 })
            .limit(limit)
            .populate('campaignId', 'name linkedinSettings')
            .lean();

        // Filter instructions based on working hours and rate limits
        const validInstructions = [];

        for (const instruction of readyInstructions) {
            try {
                // Check working hours
                const campaign = instruction.campaignId;
                const workingHours = campaign?.linkedinSettings?.workingHours;

                if (!rateLimitService.isWorkingHours(workingHours)) {
                    console.log(`⏰ Instruction ${instruction._id} outside working hours, skipping`);
                    continue;
                }

                // Check rate limits
                const rateLimits = await rateLimitService.checkRateLimits(userId, instruction.action);
                if (!rateLimits.canSend) {
                    console.log(`🚫 Rate limit exceeded for ${instruction.action}, skipping instruction ${instruction._id}`);
                    continue;
                }

                // Mark as processing to prevent duplicate execution
                await LinkedInInstruction.findByIdAndUpdate(instruction._id, {
                    status: 'processing',
                    sentToExtensionAt: new Date(),
                    processingStartedAt: new Date()
                });

                validInstructions.push({
                    id: instruction._id,
                    action: instruction.action,
                    profileUrl: instruction.profileUrl,
                    profileId: instruction.profileId,
                    conversationId: instruction.conversationId,
                    conversationUrn: instruction.conversationUrn,
                    message: instruction.message,
                    customNote: instruction.customNote,
                    campaignId: instruction.campaignId._id,
                    prospectId: instruction.prospectId,
                    executionId: instruction.executionId,
                    nodeId: instruction.nodeId,
                    rateLimitContext: instruction.rateLimitContext,
                    // NO sensitive data sent to extension
                });

            } catch (error) {
                console.error(`❌ Error processing instruction ${instruction._id}:`, error.message);
                // Mark instruction as failed
                await LinkedInInstruction.findByIdAndUpdate(instruction._id, {
                    status: 'failed',
                    result: {
                        success: false,
                        error: `Processing error: ${error.message}`
                    }
                });
            }
        }

        console.log(`📤 Sending ${validInstructions.length} instructions to extension`);

        // Include reconnection info in response
        const response = {
            success: true,
            instructions: validInstructions,
            count: validInstructions.length,
            timestamp: new Date().toISOString()
        };

        // Add reconnection metadata if extension was offline
        if (reconnectResult.wasOffline) {
            response.reconnected = true;
            response.campaignsResumed = reconnectResult.campaignsResumed;
            console.log(`🔄 Extension reconnected - ${reconnectResult.campaignsResumed} campaigns auto-resumed`);
        }

        res.json(response);

    } catch (error) {
        console.error('❌ Error getting instructions:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Receive results from extension
exports.receiveResults = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { instructionId, success, error, data, executionDuration } = req.body;

        if (!instructionId) {
            throw new BadRequestError('Instruction ID is required');
        }

        console.log(`📨 Receiving result for instruction ${instructionId} - Success: ${success}`);

        // Find the instruction
        const instruction = await LinkedInInstruction.findOne({
            _id: instructionId,
            userId: userId
        }).populate('campaignId executionId');

        if (!instruction) {
            throw new NotFoundError('Instruction not found');
        }

        // Prepare result data
        let result;
        // Around line 127-153
        if (instruction.action === 'check_connection' || instruction.action === 'check_replies') {
            // Add debug logging to see what data we're receiving
            console.log('🔍 [DEBUG] Raw data received:', JSON.stringify(data, null, 2));
            console.log('🔍 [DEBUG] Building result...');

            // Extract nested data if it exists (extension sends data.data)
            const actualData = data?.data || data;

            // For connection and reply checks, preserve all the status data
            result = {
                success: success,
                error: error || null,
                linkedinStatus: null, // HTTP status (keep as null for connection checks)
                throttled: actualData?.throttled || false,
                executionDuration: executionDuration || null,
                // ← ADD ALL THE CONNECTION DATA HERE
                connectionStatus: actualData?.status || 'unknown',
                status: actualData?.status || 'unknown',  // Also add as 'status' for compatibility
                isConnected: actualData?.isConnected || false,
                invitationAccepted: actualData?.invitationAccepted || false,
                invitationPending: actualData?.invitationPending || false,
                profileUsername: actualData?.profileUsername || null,
                method: actualData?.method || 'extension_live_session',
                // Reply check fields
                hasReplies: actualData?.hasReplies || false,
                replyCount: actualData?.replyCount || 0,
                lastReplyDate: actualData?.lastReplyDate || null
            };

            console.log('🔍 [DEBUG] Built result object:', JSON.stringify(result, null, 2));
        } else if (instruction.action === 'send_message') {
            // For message sending, store conversation URN and message ID
            console.log('📥 [DEBUG] Message result data:', JSON.stringify(data, null, 2));

            // Extract the nested data from extension response
            const messageData = data?.data || data;

            result = {
                success: success,
                error: error || null,
                linkedinStatus: messageData?.status || null,
                throttled: data?.throttled || false,
                executionDuration: executionDuration || null,
                // Message sending fields
                conversationUrn: messageData?.conversationUrn || null,
                messageId: messageData?.messageId || null,
                targetProfileUrn: messageData?.targetProfileUrn || null,
                originToken: messageData?.originToken || null,
                sentAt: messageData?.sentAt || null,
                method: messageData?.method || 'extension_live_session'
            };

            console.log('🔗 [DEBUG] Stored conversation URN:', result.conversationUrn);
        } else {
            console.log('🔍 [DEBUG] Using generic result format for action:', instruction.action);
            // For other actions, use the original generic format
            result = {
                success: success,
                error: error || null,
                linkedinStatus: data?.status || null,
                throttled: data?.throttled || false,
                executionDuration: executionDuration || null
            };
        }

        // Handle throttling
        if (data?.throttled || data?.status === 429 || data?.status === 999) {
            console.log(`🚫 LinkedIn throttling detected for user ${userId}`);

            const retryAfter = new Date(Date.now() + (60 * 60 * 1000)); // 1 hour from now
            await instruction.markAsThrottled(retryAfter);

            // Pause all pending instructions for this user temporarily
            await LinkedInInstruction.updateMany(
                { userId: userId, status: 'pending' },
                {
                    status: 'throttled',
                    nextRetryAt: retryAfter
                }
            );

            return res.json({
                success: true,
                message: 'Throttling detected, instructions paused',
                retryAfter: retryAfter
            });
        }

        // Mark instruction as completed
        await instruction.markAsCompleted(result);

        // Record action for rate limiting if successful
        if (success) {
            await rateLimitService.recordAction(userId, instruction.action);
            console.log(`✅ Recorded ${instruction.action} for rate limiting`);
        }

        // Update campaign stats
        if (success && instruction.campaignId) {
            await this.updateCampaignStats(instruction);
        }

        // Update prospect status
        if (instruction.campaignId && instruction.prospectId) {
            await this.updateProspectStatus(instruction, success);
        }

        // Continue campaign execution if successful
        if (success && instruction.executionId) {
            await this.continueExecution(instruction);
        } else if (!success && instruction.canRetry()) {
            // Schedule retry if failed but retryable
            await instruction.scheduleRetry(30); // Retry in 30 minutes
            console.log(`🔄 Scheduled retry for instruction ${instructionId}`);
        }

        res.json({
            success: true,
            message: 'Result processed successfully',
            instructionId: instructionId,
            nextStep: success ? 'continue' : 'retry'
        });

    } catch (error) {
        console.error('❌ Error processing result:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Handle throttling notification from extension
exports.handleThrottling = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { retryAfter, message } = req.body;

        console.log(`🚫 Throttling notification from extension - User: ${userId}`);

        const retryTime = retryAfter ? new Date(retryAfter) : new Date(Date.now() + (60 * 60 * 1000));

        // Pause all pending instructions for this user
        const pausedCount = await LinkedInInstruction.updateMany(
            { userId: userId, status: { $in: ['pending', 'processing'] } },
            {
                status: 'throttled',
                nextRetryAt: retryTime,
                result: {
                    success: false,
                    error: message || 'LinkedIn throttling detected',
                    throttled: true,
                    retryAfter: retryTime
                }
            }
        );

        console.log(`⏸️ Paused ${pausedCount.modifiedCount} instructions due to throttling`);

        res.json({
            success: true,
            message: `Paused ${pausedCount.modifiedCount} instructions`,
            retryAfter: retryTime
        });

    } catch (error) {
        console.error('❌ Error handling throttling:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Get extension connection status
exports.getConnectionStatus = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Check for recent instruction activity
        const recentInstructions = await LinkedInInstruction.countDocuments({
            userId: userId,
            sentToExtensionAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
        });

        const pendingCount = await LinkedInInstruction.countDocuments({
            userId: userId,
            status: 'pending'
        });

        const processingCount = await LinkedInInstruction.countDocuments({
            userId: userId,
            status: 'processing'
        });

        const throttledCount = await LinkedInInstruction.countDocuments({
            userId: userId,
            status: 'throttled'
        });

        res.json({
            success: true,
            connection: {
                active: recentInstructions > 0,
                lastActivity: recentInstructions > 0 ? 'recent' : 'inactive',
                pendingInstructions: pendingCount,
                processingInstructions: processingCount,
                throttledInstructions: throttledCount
            }
        });

    } catch (error) {
        console.error('❌ Error getting connection status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Helper methods
exports.updateCampaignStats = async (instruction) => {
    try {
        const updateField = {};

        switch (instruction.action) {
            case 'send_invitation':
                updateField['stats.linkedinInvitationsSent'] = 1;
                break;
            case 'send_message':
                updateField['stats.linkedinMessagesSent'] = 1;
                break;
            case 'visit_profile':
                updateField['stats.linkedinProfilesVisited'] = 1;
                break;
        }

        if (Object.keys(updateField).length > 0) {
            await Campaign.findByIdAndUpdate(instruction.campaignId._id, {
                $inc: updateField
            });
        }

    } catch (error) {
        console.error('❌ Error updating campaign stats:', error);
    }
};

exports.updateProspectStatus = async (instruction, success) => {
    try {
        const campaign = await Campaign.findById(instruction.campaignId._id);
        if (!campaign) return;

        const prospect = campaign.prospects.id(instruction.prospectId);
        if (!prospect) return;

        if (success) {
            switch (instruction.action) {
                case 'send_invitation':
                    prospect.status = 'linkedin_invitation_sent';
                    prospect.lastContacted = new Date();
                    break;
                case 'send_message':
                    prospect.status = 'linkedin_message_sent';
                    prospect.lastContacted = new Date();
                    break;
                case 'visit_profile':
                    prospect.status = 'visited';
                    break;
            }
        } else {
            switch (instruction.action) {
                case 'send_invitation':
                    prospect.status = 'linkedin_invitation_failed';
                    break;
                case 'send_message':
                    prospect.status = 'linkedin_message_failed';
                    break;
            }
        }

        prospect.lastActivity = new Date();
        await campaign.save();

    } catch (error) {
        console.error('❌ Error updating prospect status:', error);
    }
};

exports.continueExecution = async (instruction) => {
    try {
        // Use existing campaign service logic to continue execution
        if (instruction.nextNodeId) {
            const execution = await CampaignExecution.findById(instruction.executionId);
            if (execution) {
                execution.currentNodeId = instruction.nextNodeId;
                execution.status = 'running';
                execution.lastActivity = new Date();

                // Add to execution history
                execution.executionHistory.push({
                    nodeId: instruction.nodeId,
                    executedAt: new Date(),
                    status: 'completed',
                    result: {
                        action: instruction.action,
                        success: true,
                        executedViaExtension: true
                    },
                    nextNodeId: instruction.nextNodeId
                });

                await execution.save();

                // Continue processing next node
                setImmediate(() => campaignService.processProspectNode(execution));
            }
        } else {
            // No next node - complete the execution
            const execution = await CampaignExecution.findById(instruction.executionId);
            if (execution) {
                // ✅ Use the proper completeExecution method
                await campaignService.completeExecution(execution, 'completed', 'LinkedIn instruction completed - no further steps');
            }
        }

    } catch (error) {
        console.error('❌ Error continuing execution:', error);
    }
};

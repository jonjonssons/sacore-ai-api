const Campaign = require('../models/Campaign');
const mongoose = require('mongoose');
const CampaignExecution = require('../models/CampaignExecution');
const ConnectedAccount = require('../models/ConnectedAccount');
const Task = require('../models/Task');
const campaignService = require('../services/campaignService');
const { BadRequestError, NotFoundError } = require('../errors');

// Helper function to check if user can activate more campaigns based on subscription
async function canActivateCampaign(userId) {
    const User = require('../models/User');
    const user = await User.findById(userId).select('subscription');

    if (!user) {
        throw new Error('User not found');
    }

    const subscription = user.subscription;

    // Define active campaign limits per subscription tier
    const activeCampaignLimits = {
        'free': 1,        // Free: 1 active campaign
        'basic': 5,       // Basic: 5 active campaigns
        'explorer': null, // Unlimited
        'pro': null       // Unlimited
    };

    const limit = activeCampaignLimits[subscription];

    // If unlimited (Explorer/Pro), always allowed
    if (limit === null) {
        return {
            allowed: true,
            limit: 'unlimited',
            current: null,
            subscription: subscription
        };
    }

    // Count currently active and paused campaigns (these are "running" campaigns)
    const activeCampaignCount = await Campaign.countDocuments({
        userId: userId,
        status: { $in: ['active', 'paused'] }
    });

    const allowed = activeCampaignCount < limit;

    return {
        allowed: allowed,
        limit: limit,
        current: activeCampaignCount,
        remaining: Math.max(0, limit - activeCampaignCount),
        subscription: subscription
    };
}

// Create campaign
exports.createCampaign = async (req, res) => {
    try {
        const { name, description, prospects, sequence, linkedinSettings } = req.body;
        const userId = req.user.userId;

        // Validate emailAccountId if provided
        if (req.body.emailAccountId) {
            const emailAccount = await ConnectedAccount.findOne({
                _id: req.body.emailAccountId,
                userId: req.user.userId,
                type: 'email',
                isActive: true
            });

            if (!emailAccount) {
                throw new BadRequestError('Invalid email account selected');
            }
        }
        // Validate LinkedIn settings if provided
        if (linkedinSettings) {
            // Validate delay settings
            if (linkedinSettings.delaySettings?.invitations?.minDelay >= linkedinSettings.delaySettings?.invitations?.maxDelay) {
                return res.status(400).json({
                    success: false,
                    error: 'Invitation minimum delay must be less than maximum delay'
                });
            }

            if (linkedinSettings.delaySettings?.messages?.minDelay >= linkedinSettings.delaySettings?.messages?.maxDelay) {
                return res.status(400).json({
                    success: false,
                    error: 'Message minimum delay must be less than maximum delay'
                });
            }

            // Validate timezone if provided
            if (linkedinSettings.workingHours?.timezone) {
                const timezones = require('../config/timezones');
                if (!timezones.isValidTimezone(linkedinSettings.workingHours.timezone)) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid timezone: ${linkedinSettings.workingHours.timezone}`
                    });
                }
            }
        }

        const campaignData = {
            userId,
            name,
            description,
            prospects: prospects || [],
            sequence: sequence || [],
            emailAccountId: req.body.emailAccountId || null
        };

        // Add LinkedIn settings if provided
        if (linkedinSettings) {
            campaignData.linkedinSettings = linkedinSettings;
        }

        const campaign = new Campaign(campaignData);

        await campaign.save();
        res.status(201).json(campaign);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get all campaigns
exports.getCampaigns = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaigns = await Campaign.find({ userId }).sort({ createdAt: -1 });
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Get campaign limits based on subscription
exports.getCampaignLimits = async (req, res) => {
    try {
        const userId = req.user.userId;
        const User = require('../models/User');

        const user = await User.findById(userId).select('subscription');

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const activeCampaignLimits = {
            'free': 1,
            'basic': 5,
            'explorer': null,
            'pro': null
        };

        const limit = activeCampaignLimits[user.subscription];

        // Count current campaigns by status
        const [activeCampaignCount, pausedCampaignCount, draftCampaignCount, completedCampaignCount] = await Promise.all([
            Campaign.countDocuments({ userId: userId, status: 'active' }),
            Campaign.countDocuments({ userId: userId, status: 'paused' }),
            Campaign.countDocuments({ userId: userId, status: 'draft' }),
            Campaign.countDocuments({ userId: userId, status: 'completed' })
        ]);

        const totalActive = activeCampaignCount + pausedCampaignCount;

        res.json({
            success: true,
            subscription: user.subscription,
            activeCampaigns: {
                limit: limit || 'unlimited',
                current: totalActive,
                remaining: limit ? Math.max(0, limit - totalActive) : 'unlimited',
                canActivateMore: limit === null || totalActive < limit
            },
            totalCampaigns: {
                active: activeCampaignCount,
                paused: pausedCampaignCount,
                draft: draftCampaignCount,
                completed: completedCampaignCount,
                total: activeCampaignCount + pausedCampaignCount + draftCampaignCount + completedCampaignCount
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Get single campaign
exports.getCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaign = await Campaign.findOne({ _id: req.params.id, userId });

        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        res.json(campaign);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Update campaign
exports.updateCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaign = await Campaign.findOneAndUpdate(
            { _id: req.params.id, userId },
            req.body,
            { new: true, runValidators: true }
        );

        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        res.json(campaign);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Safe update for paused campaigns
exports.updatePausedCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;
        const updates = req.body;

        console.log(`✏️ Attempting to update paused campaign ${campaignId}`);

        // 1. Verify campaign exists and is paused
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        if (campaign.status !== 'paused') {
            return res.status(400).json({
                success: false,
                error: 'Campaign must be paused before editing',
                currentStatus: campaign.status,
                suggestion: 'Pause the campaign first using POST /api/campaigns/:id/pause'
            });
        }

        // 2. Verify all executions are paused
        const runningExecutions = await CampaignExecution.find({
            campaignId: campaignId,
            status: { $in: ['running', 'waiting'] }
        });

        if (runningExecutions.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Some executions are still running. Please wait for pause to complete.',
                runningExecutions: runningExecutions.length
            });
        }

        console.log(`✅ Campaign is safely paused - proceeding with updates`);

        // 3. Track original data for comparison
        const originalProspects = [...campaign.prospects];
        const originalSequence = [...campaign.sequence];

        // 4. Apply safe updates
        const allowedUpdates = [
            'name', 'description', 'prospects', 'sequence',
            'emailAccountId', 'linkedinSettings'
        ];

        const safeUpdates = {};
        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                safeUpdates[field] = updates[field];
            }
        });

        // 5. Create change log
        const changeLog = {
            timestamp: new Date(),
            userId: userId,
            changes: Object.keys(safeUpdates),
            sequenceChanged: !!updates.sequence,
            prospectsChanged: !!updates.prospects,
            originalProspectCount: originalProspects.length,
            originalSequenceLength: originalSequence.length
        };

        // Add change log to campaign
        if (!campaign.editHistory) {
            campaign.editHistory = [];
        }
        campaign.editHistory.push(changeLog);
        safeUpdates.editHistory = campaign.editHistory;
        safeUpdates.lastEdited = new Date();

        // 6. Apply updates
        const updatedCampaign = await Campaign.findOneAndUpdate(
            { _id: campaignId, userId },
            safeUpdates,
            { new: true, runValidators: true }
        );

        // 7. Handle execution updates if sequence changed
        if (updates.sequence) {
            const sequenceResult = await handleSequenceChangeForPausedCampaign(
                campaignId, originalSequence, updates.sequence
            );
            changeLog.sequenceChangeResult = sequenceResult;
        }

        // 8. Handle prospect changes
        if (updates.prospects) {
            const prospectResult = await handleProspectChangesForPausedCampaign(
                campaignId, originalProspects, updates.prospects
            );
            changeLog.prospectChangeResult = prospectResult;
        }

        console.log(`✅ Campaign updated successfully:`, Object.keys(safeUpdates));

        res.json({
            success: true,
            message: 'Paused campaign updated successfully',
            campaign: updatedCampaign,
            changes: changeLog.changes,
            changeDetails: {
                sequenceChanged: changeLog.sequenceChanged,
                prospectsChanged: changeLog.prospectsChanged,
                sequenceResult: changeLog.sequenceChangeResult,
                prospectResult: changeLog.prospectChangeResult
            },
            canResume: true
        });

    } catch (error) {
        console.error('❌ Error updating paused campaign:', error);
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Delete campaign
exports.deleteCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaign = await Campaign.findOneAndDelete({ _id: req.params.id, userId });

        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        // Clean up executions
        await CampaignExecution.deleteMany({ campaignId: req.params.id });

        // Clean up LinkedIn instructions
        const LinkedInInstruction = require('../models/LinkedInInstruction');
        const instructionsDeleted = await LinkedInInstruction.deleteMany({ campaignId: req.params.id });
        console.log(`🗑️ Deleted ${instructionsDeleted.deletedCount} LinkedIn instructions for campaign ${req.params.id}`);

        res.json({
            message: 'Campaign deleted successfully',
            deleted: {
                instructions: instructionsDeleted.deletedCount
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Delete all campaigns for user
exports.deleteAllCampaigns = async (req, res) => {
    try {
        const userId = req.user.userId;

        console.log(`🗑️ User ${userId} requested to delete ALL campaigns`);

        // Get count of campaigns before deletion for response
        const campaignCount = await Campaign.countDocuments({ userId });

        if (campaignCount === 0) {
            return res.json({
                success: true,
                message: 'No campaigns found to delete',
                data: {
                    campaignsDeleted: 0,
                    executionsDeleted: 0
                }
            });
        }

        // Get all campaign IDs for this user (for cleaning up executions)
        const userCampaigns = await Campaign.find({ userId }).select('_id');
        const campaignIds = userCampaigns.map(c => c._id);

        console.log(`🗑️ Deleting ${campaignCount} campaigns and their executions for user ${userId}`);

        // Delete all campaigns for this user
        const campaignDeleteResult = await Campaign.deleteMany({ userId });

        // Clean up all executions for these campaigns
        const executionDeleteResult = await CampaignExecution.deleteMany({
            campaignId: { $in: campaignIds }
        });

        // Clean up all LinkedIn instructions for these campaigns
        const LinkedInInstruction = require('../models/LinkedInInstruction');
        const instructionDeleteResult = await LinkedInInstruction.deleteMany({
            campaignId: { $in: campaignIds }
        });

        console.log(`✅ Deleted ${campaignDeleteResult.deletedCount} campaigns, ${executionDeleteResult.deletedCount} executions, and ${instructionDeleteResult.deletedCount} LinkedIn instructions`);

        res.json({
            success: true,
            message: `Successfully deleted all campaigns, executions, and LinkedIn instructions for your account`,
            data: {
                campaignsDeleted: campaignDeleteResult.deletedCount,
                executionsDeleted: executionDeleteResult.deletedCount,
                instructionsDeleted: instructionDeleteResult.deletedCount,
                originalCampaignCount: campaignCount,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Error deleting all campaigns:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

// Start campaign
exports.startCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        // Check if user can activate another campaign
        const activationCheck = await canActivateCampaign(userId);

        if (!activationCheck.allowed) {
            return res.status(403).json({
                success: false,
                error: `Active campaign limit reached. Your ${activationCheck.subscription} subscription allows ${activationCheck.limit} active campaign${activationCheck.limit > 1 ? 's' : ''} at a time. You currently have ${activationCheck.current} active/paused campaign${activationCheck.current > 1 ? 's' : ''}.`,
                message: 'Please pause or complete an existing campaign before starting a new one, or upgrade to Explorer/Pro for unlimited active campaigns.',
                limitInfo: {
                    subscription: activationCheck.subscription,
                    limit: activationCheck.limit,
                    current: activationCheck.current,
                    remaining: 0,
                    upgradeRequired: true
                }
            });
        }

        // Get campaign and update status to 'active' if it's a draft
        const campaign = await Campaign.findOne({ _id: campaignId, userId });

        if (!campaign) {
            return res.status(404).json({
                success: false,
                error: 'Campaign not found'
            });
        }

        // If campaign is draft, activate it
        if (campaign.status === 'draft') {
            campaign.status = 'active';
            campaign.startedAt = new Date();
            await campaign.save();
            console.log(`✅ Campaign ${campaignId} activated from draft to active`);
        } else if (campaign.status !== 'active') {
            return res.status(400).json({
                success: false,
                error: `Cannot start campaign with status '${campaign.status}'. Campaign must be in 'draft' or 'active' status.`,
                currentStatus: campaign.status
            });
        }

        // Now call the service to start executions
        const result = await campaignService.startCampaign(campaignId, userId);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Resume campaign with validation
exports.resumeCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        console.log(`▶️ Resuming campaign ${campaignId}...`);

        // 1. Get campaign and validate
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        if (campaign.status !== 'paused') {
            return res.status(400).json({
                success: false,
                error: 'Campaign is not paused',
                currentStatus: campaign.status,
                suggestion: campaign.status === 'active' ? 'Campaign is already running' : 'Campaign must be paused first'
            });
        }

        // Check if user can activate this campaign (subscription limits)
        const activationCheck = await canActivateCampaign(userId);

        if (!activationCheck.allowed) {
            return res.status(403).json({
                success: false,
                error: `Active campaign limit reached. Your ${activationCheck.subscription} subscription allows ${activationCheck.limit} active campaign${activationCheck.limit > 1 ? 's' : ''} at a time.`,
                message: 'Please pause or complete an existing campaign before resuming this one, or upgrade to Explorer/Pro for unlimited active campaigns.',
                limitInfo: {
                    subscription: activationCheck.subscription,
                    limit: activationCheck.limit,
                    current: activationCheck.current,
                    remaining: 0,
                    upgradeRequired: true
                }
            });
        }

        // 2. Validate campaign is ready to resume
        const validationResult = await validateCampaignForResume(campaign);
        if (!validationResult.valid) {
            return res.status(400).json({
                success: false,
                error: 'Campaign cannot be resumed',
                issues: validationResult.issues,
                suggestions: validationResult.suggestions
            });
        }

        // 3. Update campaign status
        await Campaign.findByIdAndUpdate(campaignId, {
            status: 'active',
            lastResumed: new Date(),
            resumedAt: new Date(),
            autoresumeWhenOnline: false, // Clear auto-resume flag
            pauseReason: 'manual' // Reset to default
        });

        // 4. Resume executions
        const pausedExecutions = await CampaignExecution.find({
            campaignId: campaignId,
            status: 'paused'
        });

        console.log(`📋 Resuming ${pausedExecutions.length} executions`);

        const resumeResults = {
            executionsResumed: 0,
            executionsCompleted: 0,
            manualTasksResumed: 0,
            scheduledActionsResumed: 0,
            errors: []
        };

        for (const execution of pausedExecutions) {
            try {
                // Check if execution is still valid after edits
                const prospect = campaign.prospects.id(execution.prospectId);
                if (!prospect) {
                    // Prospect was removed during edit
                    await CampaignExecution.findByIdAndUpdate(execution._id, {
                        status: 'completed',
                        lastActivity: new Date()
                    });
                    resumeResults.executionsCompleted++;
                    continue;
                }

                // Check if current node still exists
                const currentNode = campaign.sequence.find(node => node.id === execution.currentNodeId);
                if (!currentNode) {
                    // Node was removed, find a safe starting point or complete
                    const startNode = campaign.sequence.find(node => !node.parentId);
                    if (startNode) {
                        execution.currentNodeId = startNode.id;
                        execution.status = 'running';
                        execution.lastActivity = new Date();
                        await execution.save();

                        // Start processing
                        const campaignService = require('../services/campaignService');
                        setImmediate(() => campaignService.processProspectNode(execution));

                        resumeResults.executionsResumed++;
                    } else {
                        // No valid starting point, complete execution
                        await CampaignExecution.findByIdAndUpdate(execution._id, {
                            status: 'completed',
                            lastActivity: new Date()
                        });
                        resumeResults.executionsCompleted++;
                    }
                } else {
                    // Handle manual tasks that were paused
                    if (execution.pausedFromManualTask) {
                        await resumeManualTaskExecution(execution);
                        resumeResults.manualTasksResumed++;
                    }

                    // Resume scheduled actions
                    if (execution.scheduledActions && execution.scheduledActions.length > 0) {
                        await resumeScheduledActionsForExecution(execution);
                        resumeResults.scheduledActionsResumed++;
                    }

                    // Normal resume
                    execution.status = 'running';
                    execution.lastActivity = new Date();
                    await execution.save();

                    // Start processing
                    const campaignService = require('../services/campaignService');
                    setImmediate(() => campaignService.processProspectNode(execution));

                    resumeResults.executionsResumed++;
                }

            } catch (error) {
                console.error(`❌ Error resuming execution ${execution._id}:`, error);
                resumeResults.errors.push({
                    executionId: execution._id,
                    error: error.message
                });
            }
        }

        console.log(`✅ Campaign resumed successfully:`, resumeResults);

        res.json({
            success: true,
            message: 'Campaign resumed successfully',
            details: resumeResults,
            campaignStatus: 'active'
        });

    } catch (error) {
        console.error('❌ Error resuming campaign:', error);
        res.status(500).json({ error: error.message });
    }
};

// Enhanced pause campaign with comprehensive handling
exports.pauseCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;
        const pauseReason = req.body.pauseReason || 'manual'; // Allow specifying pause reason

        console.log(`⏸️ Starting comprehensive campaign pause for ${campaignId} (reason: ${pauseReason})...`);

        // 1. Update campaign status
        const campaign = await Campaign.findOneAndUpdate(
            { _id: campaignId, userId },
            {
                status: 'paused',
                pausedAt: new Date(),
                pauseReason: pauseReason,
                // Only set autoresume flag if NOT a manual pause
                autoresumeWhenOnline: pauseReason === 'extension_offline'
            },
            { new: true }
        );

        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        // 2. Get all active executions
        const activeExecutions = await CampaignExecution.find({
            campaignId: campaignId,
            status: { $in: ['running', 'waiting', 'paused_for_manual_task'] }
        });

        console.log(`📋 Found ${activeExecutions.length} active executions`);

        const pauseResults = {
            executionsPaused: 0,
            queueJobsCancelled: 0,
            manualTasksHandled: 0,
            scheduledActionsPaused: 0,
            errors: []
        };

        // 3. Handle each execution type
        for (const execution of activeExecutions) {
            try {
                // Handle queue jobs
                if (execution.waitingJobId) {
                    await cancelQueueJob(execution.waitingJobId, execution.waitingFor);
                    pauseResults.queueJobsCancelled++;
                }

                // Handle manual tasks
                if (execution.status === 'paused_for_manual_task') {
                    await handleManualTaskPause(execution);
                    pauseResults.manualTasksHandled++;
                }

                // Handle scheduled actions
                if (execution.scheduledActions && execution.scheduledActions.length > 0) {
                    await pauseScheduledActionsForExecution(execution);
                    pauseResults.scheduledActionsPaused++;
                }

                // Update execution status
                execution.status = 'paused';
                execution.pausedAt = new Date();
                execution.waitingJobId = null;
                execution.waitingFor = null;
                execution.lastActivity = new Date();
                await execution.save();

                pauseResults.executionsPaused++;

            } catch (error) {
                console.error(`❌ Error pausing execution ${execution._id}:`, error);
                pauseResults.errors.push({
                    executionId: execution._id,
                    error: error.message
                });
            }
        }

        // 4. Cancel all pending LinkedIn instructions for this campaign
        const LinkedInInstruction = require('../models/LinkedInInstruction');
        const instructionsCancelled = await LinkedInInstruction.updateMany(
            {
                userId: userId,
                campaignId: campaignId,
                status: 'pending'
            },
            {
                $set: {
                    status: 'cancelled',
                    result: {
                        success: false,
                        error: `Campaign paused (${pauseReason})`,
                        cancelledAt: new Date(),
                        cancelReason: pauseReason
                    }
                }
            }
        );

        pauseResults.instructionsCancelled = instructionsCancelled.modifiedCount;

        console.log(`✅ Campaign paused successfully:`, pauseResults);

        res.json({
            success: true,
            message: 'Campaign paused successfully',
            details: pauseResults,
            canEdit: true,
            allStepsCompatible: true
        });

    } catch (error) {
        console.error('❌ Error pausing campaign:', error);
        res.status(500).json({ error: error.message });
    }
};

// Helper function to cancel queue jobs
async function cancelQueueJob(jobId, jobType) {
    try {
        if (jobType === 'linkedin-invitation-completion') {
            const { linkedinInvitationQueue } = require('../services/linkedinInvitationQueue');
            const job = await linkedinInvitationQueue.getJob(jobId);
            if (job) {
                const state = await job.getState();
                if (['waiting', 'delayed', 'active'].includes(state)) {
                    await job.remove();
                    console.log(`🗑️ Cancelled LinkedIn invitation job ${jobId}`);
                }
            }
        } else if (jobType === 'linkedin-message-completion') {
            const { linkedinMessageQueue } = require('../services/linkedinMessageQueue');
            const job = await linkedinMessageQueue.getJob(jobId);
            if (job) {
                const state = await job.getState();
                if (['waiting', 'delayed', 'active'].includes(state)) {
                    await job.remove();
                    console.log(`🗑️ Cancelled LinkedIn message job ${jobId}`);
                }
            }
        }
    } catch (error) {
        console.warn(`⚠️ Could not cancel job ${jobId}:`, error.message);
    }
}

// Helper function to handle manual task pause
async function handleManualTaskPause(execution) {
    try {
        const tasks = await Task.find({
            executionId: execution._id,
            status: { $in: ['pending', 'in_progress'] }
        });

        for (const task of tasks) {
            task.campaignPaused = true;
            task.pausedAt = new Date();
            await task.save();
            console.log(`📋 Marked task ${task._id} as campaign-paused`);
        }
    } catch (error) {
        console.error('❌ Error handling manual task pause:', error);
    }
}

// Helper function to pause scheduled actions
async function pauseScheduledActionsForExecution(execution) {
    try {
        const now = new Date();
        let actionsPaused = 0;

        execution.scheduledActions.forEach(action => {
            if (!action.processed && action.scheduledFor > now) {
                action.pausedAt = new Date();
                action.originalScheduledFor = action.scheduledFor;
                actionsPaused++;
            }
        });

        if (actionsPaused > 0) {
            await execution.save();
            console.log(`⏰ Paused ${actionsPaused} scheduled actions for execution ${execution._id}`);
        }
    } catch (error) {
        console.error('❌ Error pausing scheduled actions:', error);
    }
}

// Handle sequence changes for paused campaign
async function handleSequenceChangeForPausedCampaign(campaignId, oldSequence, newSequence) {
    console.log('🔄 Handling sequence changes for paused campaign');

    const oldNodeIds = oldSequence.map(n => n.id);
    const newNodeIds = newSequence.map(n => n.id);
    const removedNodeIds = oldNodeIds.filter(id => !newNodeIds.includes(id));

    const result = {
        removedNodes: removedNodeIds.length,
        executionsReset: 0,
        executionsCompleted: 0
    };

    if (removedNodeIds.length > 0) {
        console.log(`🗑️ Removing executions on deleted nodes:`, removedNodeIds);

        // Find executions on removed nodes
        const affectedExecutions = await CampaignExecution.find({
            campaignId: campaignId,
            currentNodeId: { $in: removedNodeIds }
        });

        // Reset them to start or complete them
        for (const execution of affectedExecutions) {
            const startNode = newSequence.find(node => !node.parentId);
            if (startNode) {
                execution.currentNodeId = startNode.id;
                execution.executionHistory.push({
                    nodeId: execution.currentNodeId,
                    executedAt: new Date(),
                    status: 'reset',
                    result: { reason: 'Node removed during edit', resetToStart: true }
                });
                await execution.save();
                result.executionsReset++;
                console.log(`🔄 Reset execution ${execution._id} to start node ${startNode.id}`);
            } else {
                execution.status = 'completed';
                execution.executionHistory.push({
                    nodeId: execution.currentNodeId,
                    executedAt: new Date(),
                    status: 'completed',
                    result: { reason: 'No start node after edit' }
                });
                await execution.save();
                result.executionsCompleted++;
                console.log(`✅ Completed execution ${execution._id} (no start node)`);
            }
        }
    }

    return result;
}

// Handle prospect changes for paused campaign
async function handleProspectChangesForPausedCampaign(campaignId, oldProspects, newProspects) {
    console.log('👥 Handling prospect changes for paused campaign');

    const oldProspectIds = oldProspects.map(p => p._id.toString());
    const newProspectIds = newProspects.map(p => p._id ? p._id.toString() : null).filter(Boolean);
    const removedProspectIds = oldProspectIds.filter(id => !newProspectIds.includes(id));

    const result = {
        prospectsRemoved: removedProspectIds.length,
        prospectsAdded: 0,
        executionsDeleted: 0,
        executionsCreated: 0
    };

    if (removedProspectIds.length > 0) {
        console.log(`🗑️ Removing executions for deleted prospects:`, removedProspectIds);

        // Remove executions for deleted prospects
        const deleteResult = await CampaignExecution.deleteMany({
            campaignId: campaignId,
            prospectId: { $in: removedProspectIds }
        });
        result.executionsDeleted = deleteResult.deletedCount;
    }

    // Create executions for new prospects
    const addedProspects = newProspects.filter(p =>
        p._id && !oldProspectIds.includes(p._id.toString())
    );

    if (addedProspects.length > 0) {
        console.log(`➕ Creating executions for new prospects:`, addedProspects.length);

        const campaign = await Campaign.findById(campaignId);
        const startNode = campaign.sequence.find(node => !node.parentId);

        if (startNode) {
            for (const prospect of addedProspects) {
                await CampaignExecution.create({
                    campaignId: campaignId,
                    prospectId: prospect._id.toString(),
                    currentNodeId: startNode.id,
                    status: 'paused' // Will be resumed when campaign resumes
                });
                result.executionsCreated++;
            }
        }
        result.prospectsAdded = addedProspects.length;
    }

    return result;
}

// Validation helper for resume
async function validateCampaignForResume(campaign) {
    const issues = [];
    const suggestions = [];

    // Check if campaign has prospects
    if (!campaign.prospects || campaign.prospects.length === 0) {
        issues.push('Campaign has no prospects');
        suggestions.push('Add prospects before resuming');
    }

    // Check if campaign has sequence
    if (!campaign.sequence || campaign.sequence.length === 0) {
        issues.push('Campaign has no sequence steps');
        suggestions.push('Add sequence steps before resuming');
    }

    // Check if sequence has a starting node
    if (campaign.sequence && !campaign.sequence.find(node => !node.parentId)) {
        issues.push('Campaign sequence has no starting step');
        suggestions.push('Ensure sequence has a starting step (no parent)');
    }

    // Check for orphaned executions
    const executions = await CampaignExecution.find({ campaignId: campaign._id });
    const orphanedExecutions = executions.filter(e => {
        const prospect = campaign.prospects.id(e.prospectId);
        return !prospect;
    });

    if (orphanedExecutions.length > 0) {
        issues.push(`${orphanedExecutions.length} executions have no corresponding prospects`);
        suggestions.push('Remove orphaned executions or add missing prospects');
    }

    return {
        valid: issues.length === 0,
        issues: issues,
        suggestions: suggestions
    };
}

// Resume manual task execution
async function resumeManualTaskExecution(execution) {
    try {
        const tasks = await Task.find({
            executionId: execution._id,
            campaignPaused: true
        });

        for (const task of tasks) {
            task.campaignPaused = false;
            delete task.pausedAt;
            await task.save();
            console.log(`📋 Resumed task ${task._id} from campaign pause`);
        }

        execution.pausedFromManualTask = false;
        await execution.save();
    } catch (error) {
        console.error('❌ Error resuming manual task execution:', error);
    }
}

// Resume scheduled actions for execution
async function resumeScheduledActionsForExecution(execution) {
    try {
        const now = new Date();
        let actionsResumed = 0;

        execution.scheduledActions.forEach(action => {
            if (action.pausedAt && !action.processed) {
                // Calculate how long it was paused
                const pauseDuration = now - action.pausedAt;
                // Adjust scheduled time
                action.scheduledFor = new Date(action.originalScheduledFor.getTime() + pauseDuration);
                delete action.pausedAt;
                delete action.originalScheduledFor;
                actionsResumed++;
            }
        });

        if (actionsResumed > 0) {
            await execution.save();
            console.log(`⏰ Resumed ${actionsResumed} scheduled actions for execution ${execution._id}`);
        }
    } catch (error) {
        console.error('❌ Error resuming scheduled actions:', error);
    }
}

// Add prospects to existing campaign
exports.addProspectsToCampaign = async (req, res) => {
    try {
        const { prospects } = req.body;
        const userId = req.user.userId;
        const campaignId = req.params.id;

        // Validation
        if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
            throw new BadRequestError('Prospects array is required and must not be empty');
        }

        // Validate each prospect
        for (const prospect of prospects) {
            if (!prospect.name || !prospect.name.trim()) {
                throw new BadRequestError('All prospects must have a name');
            }

            // Handle both 'linkedin' and 'linkedinUrl' field names
            const linkedinUrl = prospect.linkedin || prospect.linkedinUrl || '';

            if (!prospect.email && !linkedinUrl) {
                throw new BadRequestError('Each prospect must have either email or LinkedIn URL');
            }

            // Validate email format if provided
            if (prospect.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prospect.email)) {
                throw new BadRequestError(`Invalid email format: ${prospect.email}`);
            }

            // Validate LinkedIn URL format if provided
            if (linkedinUrl && !linkedinUrl.includes('linkedin.com/in/')) {
                throw new BadRequestError(`Invalid LinkedIn URL format: ${linkedinUrl}`);
            }
        }

        // Find campaign
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        // Check for duplicates by email or LinkedIn URL
        const existingEmails = campaign.prospects.map(p => p.email).filter(Boolean);
        const existingLinkedIns = campaign.prospects.map(p => p.linkedin).filter(Boolean);

        const duplicates = [];
        for (const prospect of prospects) {
            const linkedinUrl = prospect.linkedin || prospect.linkedinUrl || '';
            if ((prospect.email && existingEmails.includes(prospect.email)) ||
                (linkedinUrl && existingLinkedIns.includes(linkedinUrl))) {
                duplicates.push(prospect.name || prospect.email || linkedinUrl);
            }
        }

        if (duplicates.length > 0) {
            throw new BadRequestError(`Duplicate prospects found: ${duplicates.join(', ')}`);
        }

        // Add new prospects with default status
        const newProspects = prospects.map(prospect => ({
            name: prospect.name.trim(),
            email: prospect.email || '',
            company: prospect.company || '',
            position: prospect.position || '',
            linkedin: prospect.linkedin || prospect.linkedinUrl || '',
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date()
        }));

        const originalProspectCount = campaign.prospects.length;
        campaign.prospects.push(...newProspects);
        campaign.stats.totalProspects = campaign.prospects.length;
        await campaign.save();

        console.log(`✅ Added ${prospects.length} new prospects to campaign ${campaignId}`);

        // Auto-start processing for new prospects if campaign is active
        let executionsCreated = 0;
        if (campaign.status === 'active') {
            console.log('📋 Campaign is active - starting execution for new prospects');
            const result = await campaignService.startCampaign(campaignId, userId);
            executionsCreated = result.executionsCreated;
            console.log(`🚀 Created ${executionsCreated} new executions for new prospects`);
        } else {
            console.log(`⏸️ Campaign status is '${campaign.status}' - executions will be created when campaign is started`);
        }

        res.json({
            success: true,
            message: `Successfully added ${prospects.length} new prospects to campaign`,
            data: {
                prospectsAdded: prospects.length,
                totalProspects: campaign.prospects.length,
                originalProspectCount: originalProspectCount,
                executionsCreated: executionsCreated,
                campaignStatus: campaign.status,
                autoStarted: campaign.status === 'active',
                newProspects: newProspects.map(p => ({
                    name: p.name,
                    email: p.email,
                    linkedin: p.linkedin,
                    status: p.status
                }))
            }
        });

    } catch (error) {
        console.error('❌ Error adding prospects to campaign:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

// Delete multiple prospects from campaign
exports.deleteProspectsFromCampaign = async (req, res) => {
    // Start MongoDB transaction for atomicity
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { prospectIds } = req.body;
        const campaignId = req.params.id; // Use consistent parameter naming
        const userId = req.user.userId;

        // Validation
        if (!prospectIds || !Array.isArray(prospectIds) || prospectIds.length === 0) {
            throw new BadRequestError('prospectIds array is required and cannot be empty');
        }

        // Validate prospect IDs format
        const invalidIds = prospectIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidIds.length > 0) {
            throw new BadRequestError(`Invalid prospect IDs: ${invalidIds.join(', ')}`);
        }

        // Validate array size (prevent excessive deletions)
        if (prospectIds.length > 1000) {
            throw new BadRequestError('Cannot delete more than 1000 prospects at once');
        }

        console.log(`🗑️ Deleting ${prospectIds.length} prospects from campaign ${campaignId}`);

        // Find and validate campaign with transaction
        const campaign = await Campaign.findOne({ _id: campaignId, userId }).session(session);
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        // Campaign status validation warnings
        if (campaign.status === 'active') {
            console.warn(`⚠️ Deleting prospects from ACTIVE campaign - this may disrupt ongoing executions`);
        }

        // Prevent deleting all prospects (safety check)
        if (prospectIds.length >= campaign.prospects.length) {
            console.warn(`⚠️ Attempting to delete ${prospectIds.length} prospects from campaign with ${campaign.prospects.length} total prospects`);
            if (prospectIds.length === campaign.prospects.length) {
                console.warn(`🚨 WARNING: This will delete ALL prospects from the campaign!`);
            }
        }

        // Find prospects to delete and validate they exist
        const prospectsToDelete = campaign.prospects.filter(p =>
            prospectIds.includes(p._id.toString())
        );

        if (prospectsToDelete.length === 0) {
            throw new NotFoundError('No matching prospects found in campaign');
        }

        if (prospectsToDelete.length !== prospectIds.length) {
            const foundIds = prospectsToDelete.map(p => p._id.toString());
            const notFoundIds = prospectIds.filter(id => !foundIds.includes(id));
            console.warn(`⚠️ Some prospect IDs not found: ${notFoundIds.join(', ')}`);
        }

        console.log(`📋 Found ${prospectsToDelete.length} prospects to delete`);

        // Get prospect details for logging
        const prospectDetails = prospectsToDelete.map(p => ({
            id: p._id.toString(),
            name: p.name,
            email: p.email,
            linkedin: p.linkedin,
            status: p.status
        }));

        console.log('🔍 Prospects to be deleted:', prospectDetails.map(p => `${p.name} (${p.status})`).join(', '));

        let cleanup = {
            executions: 0,
            emailLogs: 0,
            tasks: 0,
            invitationJobs: 0,
            messageJobs: 0,
            errors: []
        };

        // 1. Find associated CampaignExecution records with transaction (optimized)
        console.log('🔍 Finding campaign executions to delete...');
        const executionsToDelete = await CampaignExecution.find({
            campaignId: campaignId,
            prospectId: { $in: prospectIds }
        })
            .hint({ campaignId: 1, prospectId: 1 }) // Use compound index for better performance
            .session(session);

        console.log(`🗑️ Found ${executionsToDelete.length} executions to delete`);

        // 2. Cancel pending LinkedIn invitation and message jobs
        console.log('🔍 Cancelling pending LinkedIn jobs...');
        const { linkedinInvitationQueue } = require('../services/linkedinInvitationQueue');
        const { linkedinMessageQueue } = require('../services/linkedinMessageQueue');

        for (const execution of executionsToDelete) {
            if (execution.waitingJobId) {
                console.log(`🔍 Checking job ${execution.waitingJobId} for execution ${execution._id}`);

                // Try to cancel LinkedIn invitation jobs
                try {
                    const invitationJob = await linkedinInvitationQueue.getJob(execution.waitingJobId);
                    if (invitationJob) {
                        const jobState = await invitationJob.getState();
                        if (['waiting', 'delayed', 'active'].includes(jobState)) {
                            await invitationJob.remove();
                            cleanup.invitationJobs++;
                            console.log(`❌ Cancelled LinkedIn invitation job: ${execution.waitingJobId} (state: ${jobState})`);
                        } else {
                            console.log(`ℹ️ LinkedIn invitation job ${execution.waitingJobId} in state '${jobState}' - cannot cancel`);
                        }
                    }
                } catch (error) {
                    console.warn(`⚠️ Could not cancel invitation job ${execution.waitingJobId}:`, error.message);
                    cleanup.errors.push(`Invitation job ${execution.waitingJobId}: ${error.message}`);
                }

                // Try to cancel LinkedIn message jobs
                try {
                    const messageJob = await linkedinMessageQueue.getJob(execution.waitingJobId);
                    if (messageJob) {
                        const jobState = await messageJob.getState();
                        if (['waiting', 'delayed', 'active'].includes(jobState)) {
                            await messageJob.remove();
                            cleanup.messageJobs++;
                            console.log(`❌ Cancelled LinkedIn message job: ${execution.waitingJobId} (state: ${jobState})`);
                        } else {
                            console.log(`ℹ️ LinkedIn message job ${execution.waitingJobId} in state '${jobState}' - cannot cancel`);
                        }
                    }
                } catch (error) {
                    console.warn(`⚠️ Could not cancel message job ${execution.waitingJobId}:`, error.message);
                    cleanup.errors.push(`Message job ${execution.waitingJobId}: ${error.message}`);
                }
            }
        }

        // 3. Cancel active manual tasks (optimized bulk update)
        console.log('🔍 Cancelling active manual tasks...');
        const Task = require('../models/Task');

        try {
            // Use bulk update for better performance
            const taskUpdateResult = await Task.updateMany(
                {
                    prospectId: { $in: prospectIds },
                    status: { $in: ['pending', 'in_progress'] }
                },
                {
                    $set: {
                        status: 'cancelled',
                        completedAt: new Date()
                    }
                },
                { session }
            );

            cleanup.tasks = taskUpdateResult.modifiedCount;
            console.log(`❌ Cancelled ${cleanup.tasks} manual tasks`);

            // Log individual tasks for debugging (optional, only if there are tasks)
            if (cleanup.tasks > 0) {
                const cancelledTasks = await Task.find({
                    prospectId: { $in: prospectIds },
                    status: 'cancelled',
                    completedAt: { $gte: new Date(Date.now() - 5000) } // Tasks cancelled in last 5 seconds
                }).select('_id title prospectId').session(session);

                console.log('📋 Cancelled tasks:', cancelledTasks.map(t => `${t._id} (${t.title})`).join(', '));
            }
        } catch (error) {
            console.warn('⚠️ Error cancelling manual tasks:', error.message);
            cleanup.errors.push(`Manual tasks: ${error.message}`);
        }

        // 4. Delete EmailLog records for these prospects with transaction
        console.log('🔍 Deleting email logs...');
        try {
            const EmailLog = require('../models/EmailLog');
            const emailLogDeleteResult = await EmailLog.deleteMany({
                campaignId: campaignId,
                prospectId: { $in: prospectIds.map(id => new mongoose.Types.ObjectId(id)) }
            }).session(session);
            cleanup.emailLogs = emailLogDeleteResult.deletedCount;
            console.log(`🗑️ Deleted ${cleanup.emailLogs} email log records`);
        } catch (error) {
            console.warn('⚠️ Error deleting email logs:', error.message);
            cleanup.errors.push(`Email logs: ${error.message}`);
            // Don't throw here, continue with other cleanup
        }

        // 5. Delete CampaignExecution records with transaction
        console.log('🔍 Deleting campaign executions...');
        try {
            const executionDeleteResult = await CampaignExecution.deleteMany({
                campaignId: campaignId,
                prospectId: { $in: prospectIds }
            }).session(session);
            cleanup.executions = executionDeleteResult.deletedCount;
            console.log(`🗑️ Deleted ${cleanup.executions} campaign executions`);
        } catch (error) {
            console.error('❌ Error deleting campaign executions:', error);
            cleanup.errors.push(`Campaign executions: ${error.message}`);
            throw error; // This is critical, so throw if it fails
        }

        // 6. Remove prospects from campaign (atomic operation)
        console.log('🔍 Removing prospects from campaign...');
        const originalProspectCount = campaign.prospects.length;
        const originalStats = { ...campaign.stats };

        // Use atomic update with transaction to prevent race conditions
        const updatedCampaign = await Campaign.findOneAndUpdate(
            { _id: campaignId, userId },
            {
                $pull: {
                    prospects: {
                        _id: { $in: prospectIds.map(id => new mongoose.Types.ObjectId(id)) }
                    }
                }
            },
            { new: true, session }
        );

        if (!updatedCampaign) {
            throw new Error('Failed to update campaign - campaign may have been modified');
        }

        const deletedProspectsCount = originalProspectCount - updatedCampaign.prospects.length;

        // 7. Recalculate campaign statistics based on remaining prospects
        console.log('🔍 Recalculating campaign statistics...');
        const remainingProspects = updatedCampaign.prospects;

        // Count prospects by status
        const statusCounts = remainingProspects.reduce((acc, prospect) => {
            acc[prospect.status] = (acc[prospect.status] || 0) + 1;
            return acc;
        }, {});

        // Update stats based on remaining prospects
        const updatedStats = {
            totalProspects: remainingProspects.length,
            emailsSent: (statusCounts['email_sent'] || 0) +
                (statusCounts['contacted'] || 0) +
                (statusCounts['replied'] || 0),
            linkedinInvitationsSent: (statusCounts['linkedin_invitation_sent'] || 0) +
                (statusCounts['linkedin_connected'] || 0) +
                (statusCounts['contacted'] || 0) +
                (statusCounts['replied'] || 0),
            linkedinInvitationsQueued: statusCounts['linkedin_invitation_queued'] || 0,
            linkedinInvitationsSkipped: statusCounts['linkedin_invitation_skipped'] || 0,
            linkedinMessagesSent: (statusCounts['linkedin_message_sent'] || 0) +
                (statusCounts['contacted'] || 0) +
                (statusCounts['replied'] || 0),
            linkedinProfilesVisited: (statusCounts['profile_visited'] || 0) +
                (statusCounts['contacted'] || 0) +
                (statusCounts['replied'] || 0),
        };

        // Preserve calculated rates and other non-count stats
        updatedCampaign.stats = {
            ...updatedCampaign.stats, // Keep existing rates and other calculated fields
            ...updatedStats           // Update the counts
        };

        // Save the updated campaign with transaction
        await updatedCampaign.save({ session });

        // Commit the transaction
        await session.commitTransaction();

        console.log(`✅ Successfully deleted ${deletedProspectsCount} prospects from campaign ${campaignId}`);
        console.log('📊 Updated campaign stats:', updatedStats);

        // Log cleanup summary
        if (cleanup.errors.length > 0) {
            console.warn('⚠️ Some cleanup operations had errors:', cleanup.errors);
        }

        res.json({
            success: true,
            message: `Successfully deleted ${deletedProspectsCount} prospects from campaign`,
            data: {
                prospectsDeleted: deletedProspectsCount,
                originalProspectCount,
                remainingProspects: updatedCampaign.prospects.length,
                cleanup: {
                    executionsDeleted: cleanup.executions,
                    emailLogsDeleted: cleanup.emailLogs,
                    tasksDeleted: cleanup.tasks,
                    invitationJobsCancelled: cleanup.invitationJobs,
                    messageJobsCancelled: cleanup.messageJobs,
                    errors: cleanup.errors
                },
                statistics: {
                    before: originalStats,
                    after: updatedCampaign.stats,
                    changes: {
                        totalProspects: updatedCampaign.stats.totalProspects - originalStats.totalProspects,
                        emailsSent: updatedCampaign.stats.emailsSent - originalStats.emailsSent,
                        linkedinInvitationsSent: updatedCampaign.stats.linkedinInvitationsSent - originalStats.linkedinInvitationsSent
                    }
                },
                deletedProspects: prospectDetails,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        // Rollback the transaction on error
        await session.abortTransaction();
        console.error('❌ Error deleting prospects from campaign:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message,
            transactionRolledBack: true
        });
    } finally {
        // End the session
        session.endSession();
    }
};

// Bulk operations
exports.bulkOperations = async (req, res) => {
    try {
        const { action, campaignIds } = req.body;
        const userId = req.user.userId;

        if (!action || !campaignIds || !Array.isArray(campaignIds)) {
            throw new BadRequestError('Action and campaignIds array are required');
        }

        let result;
        switch (action) {
            case 'start':
                result = await Promise.all(
                    campaignIds.map(id => campaignService.startCampaign(id, userId))
                );
                break;
            case 'pause':
                await Campaign.updateMany(
                    { _id: { $in: campaignIds }, userId },
                    { status: 'paused' }
                );
                await CampaignExecution.updateMany(
                    { campaignId: { $in: campaignIds }, status: 'running' },
                    { status: 'paused' }
                );
                result = { message: `${campaignIds.length} campaigns paused` };
                break;
            case 'delete':
                await Campaign.deleteMany({ _id: { $in: campaignIds }, userId });
                await CampaignExecution.deleteMany({ campaignId: { $in: campaignIds } });
                result = { message: `${campaignIds.length} campaigns deleted` };
                break;
            default:
                throw new BadRequestError('Invalid action');
        }

        res.json(result);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Duplicate campaign
exports.duplicateCampaign = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        // Fetch the original campaign
        const originalCampaign = await Campaign.findOne({ _id: campaignId, userId });

        if (!originalCampaign) {
            throw new NotFoundError('Campaign not found');
        }

        // Create a copy of the campaign data
        const campaignData = originalCampaign.toObject();

        // Remove the _id and other auto-generated fields
        delete campaignData._id;
        delete campaignData.createdAt;
        delete campaignData.updatedAt;
        delete campaignData.__v;

        // Update the name with "copy_" 
        campaignData.name = `${campaignData.name}_copy`;

        // Reset campaign status and stats for the new campaign
        campaignData.status = 'draft';
        campaignData.stats = {
            totalProspects: campaignData.prospects?.length || 0,
            emailsSent: 0,
            emailsOpened: 0,
            emailsClicked: 0,
            emailsReplied: 0,
            emailsBounced: 0,
            linkedinMessagesSent: 0,
            linkedinInvitationsSent: 0,
            linkedinProfilesVisited: 0
        };

        // Reset prospect statuses to 'pending'
        if (campaignData.prospects && campaignData.prospects.length > 0) {
            campaignData.prospects = campaignData.prospects.map(prospect => ({
                ...prospect,
                status: 'pending',
                lastContacted: null,
                notes: []
            }));
        }

        // Create the new campaign
        const duplicatedCampaign = new Campaign(campaignData);
        await duplicatedCampaign.save();

        res.status(201).json({
            message: 'Campaign duplicated successfully',
            campaign: duplicatedCampaign
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get campaign execution status and details
exports.getCampaignExecutions = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        // Verify campaign belongs to user
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        const executions = await CampaignExecution.find({ campaignId })
            .sort({ createdAt: -1 });

        // Get detailed execution info with prospect data
        const executionDetails = executions.map(execution => {
            const prospect = campaign.prospects.id(execution.prospectId);
            return {
                ...execution.toObject(),
                prospect: prospect ? {
                    name: prospect.name,
                    email: prospect.email,
                    company: prospect.company,
                    status: prospect.status
                } : null
            };
        });

        const summary = {
            total: executions.length,
            running: executions.filter(e => e.status === 'running').length,
            waiting: executions.filter(e => e.status === 'waiting').length,
            completed: executions.filter(e => e.status === 'completed').length,
            failed: executions.filter(e => e.status === 'failed').length,
            paused: executions.filter(e => e.status === 'paused').length
        };

        res.json({
            executions: executionDetails,
            summary,
            campaign: {
                name: campaign.name,
                status: campaign.status,
                stats: campaign.stats
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get detailed execution history for a specific prospect
exports.getProspectExecution = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { campaignId, prospectId } = req.params;

        // Verify campaign belongs to user
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        const execution = await CampaignExecution.findOne({
            campaignId,
            prospectId
        });

        if (!execution) {
            throw new NotFoundError('Execution not found');
        }

        const prospect = campaign.prospects.id(prospectId);

        res.json({
            execution,
            prospect: prospect ? {
                name: prospect.name,
                email: prospect.email,
                company: prospect.company,
                position: prospect.position,
                status: prospect.status,
                lastContacted: prospect.lastContacted
            } : null,
            campaign: {
                name: campaign.name,
                sequence: campaign.sequence
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get campaign activity logs (recent activities across all prospects)
exports.getCampaignActivity = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;
        const limit = parseInt(req.query.limit) || 50;

        // Verify campaign belongs to user
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        const executions = await CampaignExecution.find({ campaignId });

        // Collect all activities from execution histories
        const activities = [];
        executions.forEach(execution => {
            const prospect = campaign.prospects.id(execution.prospectId);

            execution.executionHistory.forEach(history => {
                const node = campaign.sequence.find(n => n.id === history.nodeId);
                activities.push({
                    prospectName: prospect?.name || 'Unknown',
                    prospectEmail: prospect?.email || 'Unknown',
                    nodeId: history.nodeId,
                    stepType: node?.stepType || 'unknown',
                    status: history.status,
                    executedAt: history.executedAt,
                    result: history.result,
                    errorMessage: history.errorMessage,
                    nextNodeId: history.nextNodeId
                });
            });
        });

        // Sort by most recent first
        activities.sort((a, b) => new Date(b.executedAt) - new Date(a.executedAt));

        res.json({
            activities: activities.slice(0, limit),
            total: activities.length,
            campaign: {
                name: campaign.name,
                status: campaign.status
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get scheduled actions for campaign
exports.getScheduledActions = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        // Verify campaign belongs to user
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        const executions = await CampaignExecution.find({
            campaignId,
            'scheduledActions.0': { $exists: true }
        });

        const scheduledActions = [];
        executions.forEach(execution => {
            const prospect = campaign.prospects.id(execution.prospectId);

            execution.scheduledActions.forEach(action => {
                const node = campaign.sequence.find(n => n.id === action.nodeId);
                scheduledActions.push({
                    prospectName: prospect?.name || 'Unknown',
                    prospectEmail: prospect?.email || 'Unknown',
                    nodeId: action.nodeId,
                    stepType: node?.stepType || 'unknown',
                    scheduledFor: action.scheduledFor,
                    actionType: action.actionType,
                    processed: action.processed || false,
                    executionId: execution._id
                });
            });
        });

        // Sort by scheduled time
        scheduledActions.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));

        res.json({
            scheduledActions,
            total: scheduledActions.length,
            campaign: {
                name: campaign.name,
                status: campaign.status
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get campaign statistics and progress
exports.getCampaignStats = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        const executions = await CampaignExecution.find({ campaignId });

        // Calculate progress statistics
        const stats = {
            prospects: {
                total: campaign.prospects.length,
                pending: campaign.prospects.filter(p => p.status === 'pending').length,
                contacted: campaign.prospects.filter(p => p.status === 'contacted').length,
                replied: campaign.prospects.filter(p => p.status === 'replied').length,
                bounced: campaign.prospects.filter(p => p.status === 'bounced').length,
                unsubscribed: campaign.prospects.filter(p => p.status === 'unsubscribed').length
            },
            executions: {
                total: executions.length,
                running: executions.filter(e => e.status === 'running').length,
                waiting: executions.filter(e => e.status === 'waiting').length,
                completed: executions.filter(e => e.status === 'completed').length,
                failed: executions.filter(e => e.status === 'failed').length,
                paused: executions.filter(e => e.status === 'paused').length
            },
            campaign: campaign.stats,
            lastActivity: executions.reduce((latest, exec) => {
                return exec.lastActivity && (!latest || exec.lastActivity > latest)
                    ? exec.lastActivity
                    : latest;
            }, null)
        };

        res.json(stats);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get campaign LinkedIn settings
exports.getCampaignSettings = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaign = await Campaign.findOne({
            _id: req.params.id,
            userId
        }).select('linkedinSettings name');

        if (!campaign) {
            return res.status(404).json({
                success: false,
                error: 'Campaign not found'
            });
        }

        // If campaign has no settings, provide defaults
        const settings = campaign.linkedinSettings || getDefaultCampaignSettings();

        res.json({
            success: true,
            data: {
                campaignName: campaign.name,
                settings: settings
            }
        });

    } catch (error) {
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

// Update campaign LinkedIn settings
exports.updateCampaignSettings = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { delaySettings, workingHours, safetyPreset } = req.body;

        // Validation
        if (delaySettings?.invitations?.minDelay >= delaySettings?.invitations?.maxDelay) {
            return res.status(400).json({
                success: false,
                error: 'Invitation minimum delay must be less than maximum delay'
            });
        }

        if (delaySettings?.messages?.minDelay >= delaySettings?.messages?.maxDelay) {
            return res.status(400).json({
                success: false,
                error: 'Message minimum delay must be less than maximum delay'
            });
        }

        // Validate timezone if provided
        if (workingHours?.timezone) {
            const timezones = require('../config/timezones');
            if (!timezones.isValidTimezone(workingHours.timezone)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid timezone: ${workingHours.timezone}`
                });
            }
        }

        const campaign = await Campaign.findOneAndUpdate(
            { _id: req.params.id, userId },
            {
                $set: {
                    linkedinSettings: { delaySettings, workingHours, safetyPreset }
                }
            },
            { new: true, runValidators: true }
        );

        if (!campaign) {
            return res.status(404).json({
                success: false,
                error: 'Campaign not found'
            });
        }

        res.json({
            success: true,
            message: 'Campaign LinkedIn settings updated successfully',
            data: {
                settings: campaign.linkedinSettings
            }
        });

    } catch (error) {
        if (error.name === 'ValidationError') {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }

        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

// Get LinkedIn presets for campaigns
exports.getLinkedInPresets = async (req, res) => {
    try {
        const presets = {
            conservative: {
                name: 'Conservative',
                description: 'Maximum safety with longer delays (30-60 min invitations, 5-10 min messages)',
                icon: '🐢',
                delaySettings: {
                    invitations: { minDelay: 1800000, maxDelay: 3600000, unit: 'minutes' },
                    messages: { minDelay: 300000, maxDelay: 600000, unit: 'minutes' }
                },
                workingHours: {
                    enabled: true, start: 9, end: 17, timezone: 'UTC', weekendsEnabled: false
                },
                safetyPreset: 'conservative'
            },
            balanced: {
                name: 'Balanced',
                description: 'Good balance between speed and safety (15-30 min invitations, 2-5 min messages)',
                icon: '⚖️',
                delaySettings: {
                    invitations: { minDelay: 900000, maxDelay: 1800000, unit: 'minutes' },
                    messages: { minDelay: 120000, maxDelay: 300000, unit: 'minutes' }
                },
                workingHours: {
                    enabled: true, start: 9, end: 18, timezone: 'UTC', weekendsEnabled: false
                },
                safetyPreset: 'balanced'
            },
            aggressive: {
                name: 'Aggressive',
                description: 'Faster execution with shorter delays (5-10 min invitations, 30s-2min messages)',
                icon: '🚀',
                delaySettings: {
                    invitations: { minDelay: 300000, maxDelay: 600000, unit: 'minutes' },
                    messages: { minDelay: 30000, maxDelay: 120000, unit: 'minutes' }
                },
                workingHours: {
                    enabled: false, start: 0, end: 24, timezone: 'UTC', weekendsEnabled: true
                },
                safetyPreset: 'aggressive'
            }
        };

        res.json({
            success: true,
            data: presets
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Apply preset to campaign
exports.applyCampaignPreset = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { preset } = req.params;

        if (!['conservative', 'balanced', 'aggressive'].includes(preset)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid preset. Use: conservative, balanced, or aggressive'
            });
        }

        const presets = {
            conservative: {
                delaySettings: {
                    invitations: { minDelay: 1800000, maxDelay: 3600000, unit: 'minutes' },
                    messages: { minDelay: 300000, maxDelay: 600000, unit: 'minutes' }
                },
                workingHours: {
                    enabled: true, start: 9, end: 17, timezone: 'UTC', weekendsEnabled: false
                },
                safetyPreset: 'conservative'
            },
            balanced: {
                delaySettings: {
                    invitations: { minDelay: 900000, maxDelay: 1800000, unit: 'minutes' },
                    messages: { minDelay: 120000, maxDelay: 300000, unit: 'minutes' }
                },
                workingHours: {
                    enabled: true, start: 9, end: 18, timezone: 'UTC', weekendsEnabled: false
                },
                safetyPreset: 'balanced'
            },
            aggressive: {
                delaySettings: {
                    invitations: { minDelay: 300000, maxDelay: 600000, unit: 'minutes' },
                    messages: { minDelay: 30000, maxDelay: 120000, unit: 'minutes' }
                },
                workingHours: {
                    enabled: false, start: 0, end: 24, timezone: 'UTC', weekendsEnabled: true
                },
                safetyPreset: 'aggressive'
            }
        };

        const settings = presets[preset];

        const campaign = await Campaign.findOneAndUpdate(
            { _id: req.params.id, userId },
            { $set: { linkedinSettings: settings } },
            { new: true, runValidators: true }
        );

        if (!campaign) {
            return res.status(404).json({
                success: false,
                error: 'Campaign not found'
            });
        }

        res.json({
            success: true,
            message: `Applied ${preset} preset successfully`,
            data: {
                settings: campaign.linkedinSettings
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Reset campaign to use global settings (remove campaign-specific settings)
exports.resetCampaignToGlobalSettings = async (req, res) => {
    try {
        const userId = req.user.userId;

        const campaign = await Campaign.findOneAndUpdate(
            { _id: req.params.id, userId },
            { $unset: { linkedinSettings: 1 } },
            { new: true }
        );

        if (!campaign) {
            return res.status(404).json({
                success: false,
                error: 'Campaign not found'
            });
        }

        res.json({
            success: true,
            message: 'Campaign reset to use global settings',
            data: {
                message: 'Campaign will now use global LinkedIn settings'
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Helper function for default campaign settings
function getDefaultCampaignSettings() {
    return {
        delaySettings: {
            invitations: {
                minDelay: 900000,  // 15 minutes
                maxDelay: 1800000, // 30 minutes
                unit: 'minutes'
            },
            messages: {
                minDelay: 120000, // 2 minutes
                maxDelay: 300000, // 5 minutes
                unit: 'minutes'
            }
        },
        workingHours: {
            enabled: true,
            start: 9,
            end: 18,
            timezone: 'UTC',
            weekendsEnabled: false
        },
        safetyPreset: 'balanced'
    };
}

// Get detailed information for a single prospect by ID
exports.getProspectDetails = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { id: campaignId, prospectId } = req.params;

        // Verify campaign belongs to user
        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        // Find the prospect
        const prospect = campaign.prospects.id(prospectId);
        if (!prospect) {
            throw new NotFoundError('Prospect not found in this campaign');
        }

        // Get execution details
        const execution = await CampaignExecution.findOne({
            campaignId,
            prospectId
        });

        // Get email logs for this prospect
        const EmailLog = require('../models/EmailLog');
        const emailLogs = await EmailLog.find({
            campaignId,
            prospectId
        }).sort({ sentAt: -1 });

        // Get tasks for this prospect
        const Task = require('../models/Task');
        const tasks = await Task.find({
            campaignId,
            prospectId
        }).sort({ createdAt: -1 });

        // Get current step information
        let currentStep = null;
        let nextStep = null;
        if (execution && execution.currentNodeId) {
            const currentNode = campaign.sequence.find(n => n.id === execution.currentNodeId);
            if (currentNode) {
                currentStep = {
                    id: currentNode.id,
                    stepType: currentNode.stepType,
                    name: currentNode.name || currentNode.stepType,
                    status: execution.status,
                    settings: currentNode.settings || {},
                    conditions: currentNode.conditions || {}
                };

                // Find next possible steps
                const nextNodes = campaign.sequence.filter(n => n.parentId === currentNode.id);
                if (nextNodes.length > 0) {
                    nextStep = nextNodes.map(node => ({
                        id: node.id,
                        stepType: node.stepType,
                        name: node.name || node.stepType,
                        branch: node.parentBranch || 'main'
                    }));
                }
            }
        }

        // Build execution timeline
        const timeline = [];
        if (execution && execution.executionHistory.length > 0) {
            execution.executionHistory.forEach(history => {
                const node = campaign.sequence.find(n => n.id === history.nodeId);

                // Check if this is a system event (pause/resume) without a nodeId
                const isSystemEvent = !history.nodeId && (history.action === 'paused' || history.action === 'resumed' || history.action === 'resumed_with_retry');

                if (isSystemEvent) {
                    // System event - display as campaign-level action
                    timeline.push({
                        id: history._id,
                        stepType: 'system_event',
                        stepName: history.action === 'paused' ? 'Campaign Auto-Paused' :
                            history.action === 'resumed_with_retry' ? 'Campaign Resumed (Retrying)' :
                                'Campaign Resumed',
                        status: history.status,
                        executedAt: history.executedAt || history.timestamp,
                        result: history.result,
                        reason: history.reason,
                        errorMessage: history.errorMessage,
                        nextNodeId: history.nextNodeId,
                        duration: history.completedAt ?
                            new Date(history.completedAt) - new Date(history.executedAt) : null
                    });
                } else {
                    // Regular step execution
                    timeline.push({
                        id: history._id,
                        stepType: node?.stepType || 'unknown',
                        stepName: node?.name || node?.stepType || 'Unknown Step',
                        status: history.status,
                        executedAt: history.executedAt,
                        result: history.result,
                        errorMessage: history.errorMessage,
                        nextNodeId: history.nextNodeId,
                        duration: history.completedAt ?
                            new Date(history.completedAt) - new Date(history.executedAt) : null
                    });
                }
            });
        }

        // Calculate interaction statistics
        const stats = {
            // Email stats
            emailsSent: emailLogs.filter(e => e.status === 'sent').length,
            emailsDelivered: emailLogs.filter(e => e.status === 'delivered').length,
            emailsOpened: emailLogs.filter(e => e.opened).length,
            emailsClicked: emailLogs.filter(e => e.clicked).length,
            emailsReplied: emailLogs.filter(e => e.replied).length,
            emailsBounced: emailLogs.filter(e => e.status === 'bounced').length,

            // LinkedIn stats
            linkedinInvitationSent: prospect.status === 'linkedin_invitation_sent',
            linkedinConnected: prospect.status === 'linkedin_connected',
            linkedinMessageSent: prospect.status === 'linkedin_message_sent',

            // Task stats
            tasksTotal: tasks.length,
            tasksCompleted: tasks.filter(t => t.status === 'completed').length,
            tasksPending: tasks.filter(t => t.status === 'pending').length,

            // Engagement metrics
            openRate: emailLogs.filter(e => e.status === 'sent').length > 0 ?
                (emailLogs.filter(e => e.opened).length / emailLogs.filter(e => e.status === 'sent').length * 100).toFixed(2) : 0,
            clickRate: emailLogs.filter(e => e.opened).length > 0 ?
                (emailLogs.filter(e => e.clicked).length / emailLogs.filter(e => e.opened).length * 100).toFixed(2) : 0,
            replyRate: emailLogs.filter(e => e.status === 'sent').length > 0 ?
                (emailLogs.filter(e => e.replied).length / emailLogs.filter(e => e.status === 'sent').length * 100).toFixed(2) : 0
        };

        // Get scheduled actions for this prospect
        const scheduledActions = [];
        if (execution && execution.scheduledActions.length > 0) {
            execution.scheduledActions.forEach(action => {
                const node = campaign.sequence.find(n => n.id === action.nodeId);
                scheduledActions.push({
                    id: action._id,
                    nodeId: action.nodeId,
                    stepType: node?.stepType || 'unknown',
                    stepName: node?.name || node?.stepType || 'Unknown Step',
                    actionType: action.actionType,
                    scheduledFor: action.scheduledFor,
                    processed: action.processed || false,
                    processedAt: action.processedAt
                });
            });
        }

        // Format email logs with more details
        const formattedEmails = emailLogs.map(email => ({
            id: email._id,
            subject: email.subject,
            status: email.status,
            sentAt: email.sentAt,
            deliveredAt: email.deliveredAt,
            opened: email.opened,
            openedAt: email.openedAt,
            clicked: email.clicked,
            clickedAt: email.clickedAt,
            replied: email.replied,
            repliedAt: email.repliedAt,
            bounced: email.bounced,
            bouncedAt: email.bouncedAt,
            bounceReason: email.bounceReason,
            emailProvider: email.emailProvider,
            templateId: email.templateId
        }));

        // Format tasks with details
        const formattedTasks = tasks.map(task => ({
            id: task._id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
            dueDate: task.dueDate,
            assignedTo: task.assignedTo,
            nodeId: task.nodeId,
            stepType: task.stepType
        }));

        // NEW: Search for this prospect across all user's projects
        let projectMatches = [];
        try {
            const Projects = require('../models/Projects');
            const Profiles = require('../models/Profiles');

            // Get all user's projects
            const userProjects = await Projects.find({ userId }).select('_id name');
            const projectIds = userProjects.map(p => p._id);

            if (projectIds.length > 0) {
                // Build search criteria - ONLY LinkedIn URL or Email
                const searchCriteria = [];

                // Search by LinkedIn URL if available
                if (prospect.linkedin && prospect.linkedin.trim()) {
                    searchCriteria.push({ linkedinUrl: prospect.linkedin.trim() });
                }

                // Search by email if available
                if (prospect.email && prospect.email.trim()) {
                    searchCriteria.push({ email: prospect.email.trim() });
                }

                // Only search if we have valid criteria
                if (searchCriteria.length > 0) {
                    const matchingProfiles = await Profiles.find({
                        projectId: { $in: projectIds },
                        $or: searchCriteria
                    }).populate('projectId', 'name');

                    // Group matches by project and include match reasons
                    const projectMatchMap = {};

                    matchingProfiles.forEach(profile => {
                        const projectId = profile.projectId._id.toString();

                        if (!projectMatchMap[projectId]) {
                            projectMatchMap[projectId] = {
                                projectId: profile.projectId._id,
                                projectName: profile.projectId.name,
                                matches: [],
                                matchReasons: []
                            };
                        }

                        // Determine match reason - ONLY LinkedIn URL or Email
                        let matchReason = [];
                        if (prospect.linkedin && profile.linkedinUrl === prospect.linkedin) {
                            matchReason.push('LinkedIn URL');
                        }
                        if (prospect.email && profile.email === prospect.email) {
                            matchReason.push('Email');
                        }

                        projectMatchMap[projectId].matches.push({
                            profileId: profile._id,
                            name: profile.name,
                            email: profile.email,
                            linkedinUrl: profile.linkedinUrl,
                            company: profile.company,
                            matchReason: matchReason.join(', ')
                        });

                        // Add unique match reasons to project level
                        matchReason.forEach(reason => {
                            if (!projectMatchMap[projectId].matchReasons.includes(reason)) {
                                projectMatchMap[projectId].matchReasons.push(reason);
                            }
                        });
                    });

                    projectMatches = Object.values(projectMatchMap);
                }
            }
        } catch (projectSearchError) {
            console.warn('Failed to search prospect in projects:', projectSearchError.message);
            // Continue without project matches
        }

        // Build comprehensive response
        const prospectDetails = {
            // Basic prospect information
            id: prospect._id,
            name: prospect.name,
            email: prospect.email,
            company: prospect.company,
            position: prospect.position,
            linkedin: prospect.linkedin,
            phone: prospect.phone,
            status: prospect.status,
            createdAt: prospect.createdAt,
            updatedAt: prospect.updatedAt,
            lastContacted: prospect.lastContacted,
            customFields: prospect.customFields || {},

            // Campaign context
            campaign: {
                id: campaign._id,
                name: campaign.name,
                status: campaign.status,
                totalSteps: campaign.sequence.length
            },

            // Execution information
            execution: execution ? {
                id: execution._id,
                status: execution.status,
                currentNodeId: execution.currentNodeId,
                startedAt: execution.createdAt,
                completedAt: execution.completedAt,
                pausedAt: execution.pausedAt,
                lastExecutedAt: execution.lastExecutedAt,
                totalStepsCompleted: execution.executionHistory.length
            } : null,

            // Current and next steps
            currentStep,
            nextStep,

            // Execution timeline
            timeline: timeline.sort((a, b) => new Date(b.executedAt) - new Date(a.executedAt)),

            // Interaction statistics
            stats,

            // Scheduled actions
            scheduledActions: scheduledActions.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor)),

            // Communication history
            emails: formattedEmails,
            tasks: formattedTasks,

            // Additional metadata
            metadata: {
                totalInteractions: emailLogs.length + tasks.length,
                lastActivityAt: Math.max(
                    prospect.lastContacted ? new Date(prospect.lastContacted).getTime() : 0,
                    emailLogs.length > 0 ? new Date(emailLogs[0].sentAt).getTime() : 0,
                    tasks.length > 0 ? new Date(tasks[0].createdAt).getTime() : 0
                ),
                campaignProgress: execution && campaign.sequence.length > 0 ?
                    Math.round((execution.executionHistory.length / campaign.sequence.length) * 100) : 0
            },

            // NEW: Project matches
            projectMatches: projectMatches,
            projectMatchSummary: {
                totalMatches: projectMatches.length,
                totalProfiles: projectMatches.reduce((sum, match) => sum + match.matches.length, 0),
                matchedProjects: projectMatches.map(match => ({
                    projectId: match.projectId,
                    projectName: match.projectName,
                    profileCount: match.matches.length,
                    matchReasons: match.matchReasons
                }))
            }
        };

        res.json({
            success: true,
            prospect: prospectDetails
        });

    } catch (error) {
        console.error('❌ Error getting prospect details:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

exports.deleteAllCampaignsGlobal = async (req, res) => {
    try {
        const userId = req.user.userId;
        const userRole = req.user.role;

        // SAFETY CHECK: Only allow admin users
        if (userRole !== 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Access denied. This operation requires admin privileges.'
            });
        }

        console.log(`🚨 ADMIN ${userId} requested GLOBAL campaign cleanup - deleting ALL campaigns for ALL users`);

        // Get counts before deletion for reporting
        const [campaignCount, executionCount, taskCount, emailLogCount, instructionCount] = await Promise.all([
            Campaign.countDocuments({}),
            CampaignExecution.countDocuments({}),
            Task.countDocuments({ campaignId: { $exists: true } }),
            require('../models/EmailLog').countDocuments({}),
            require('../models/LinkedInInstruction').countDocuments({})
        ]);

        console.log(`📊 Pre-deletion counts:`, {
            campaigns: campaignCount,
            executions: executionCount,
            tasks: taskCount,
            emailLogs: emailLogCount,
            instructions: instructionCount
        });

        if (campaignCount === 0 && instructionCount === 0 && executionCount === 0 && taskCount === 0 && emailLogCount === 0) {
            return res.json({
                success: true,
                message: 'No campaign-related data found to delete',
                data: {
                    campaignsDeleted: 0,
                    executionsDeleted: 0,
                    tasksDeleted: 0,
                    emailLogsDeleted: 0,
                    instructionsDeleted: 0,
                    queueJobsCancelled: 0
                }
            });
        }

        console.log(`🚨 Proceeding with cleanup - will delete orphaned data even if no campaigns exist`);


        // Start MongoDB transaction for atomicity
        const session = await mongoose.startSession();
        session.startTransaction();

        let cleanup = {
            campaigns: 0,
            executions: 0,
            tasks: 0,
            emailLogs: 0,
            invitationJobs: 0,
            messageJobs: 0,
            instructions: 0,
            errors: []
        };

        try {
            // 1. Cancel ALL pending LinkedIn jobs (invitations and messages)
            console.log('🔍 Cancelling ALL pending LinkedIn jobs...');

            const { linkedinInvitationQueue } = require('../services/linkedinInvitationQueue');
            const { linkedinMessageQueue } = require('../services/linkedinMessageQueue');

            try {
                // Get all waiting and delayed jobs from invitation queue
                const [waitingInvitations, delayedInvitations] = await Promise.all([
                    linkedinInvitationQueue.getWaiting(),
                    linkedinInvitationQueue.getDelayed()
                ]);

                // Cancel all invitation jobs
                for (const job of [...waitingInvitations, ...delayedInvitations]) {
                    try {
                        await job.remove();
                        cleanup.invitationJobs++;
                    } catch (jobError) {
                        console.warn(`⚠️ Could not cancel invitation job ${job.id}:`, jobError.message);
                        cleanup.errors.push(`Invitation job ${job.id}: ${jobError.message}`);
                    }
                }

                // Get all waiting and delayed jobs from message queue
                const [waitingMessages, delayedMessages] = await Promise.all([
                    linkedinMessageQueue.getWaiting(),
                    linkedinMessageQueue.getDelayed()
                ]);

                // Cancel all message jobs
                for (const job of [...waitingMessages, ...delayedMessages]) {
                    try {
                        await job.remove();
                        cleanup.messageJobs++;
                    } catch (jobError) {
                        console.warn(`⚠️ Could not cancel message job ${job.id}:`, jobError.message);
                        cleanup.errors.push(`Message job ${job.id}: ${jobError.message}`);
                    }
                }

                console.log(`❌ Cancelled ${cleanup.invitationJobs} invitation jobs and ${cleanup.messageJobs} message jobs`);

            } catch (queueError) {
                console.warn('⚠️ Error cancelling queue jobs:', queueError.message);
                cleanup.errors.push(`Queue jobs: ${queueError.message}`);
            }

            // 2. Delete ALL EmailLog records
            console.log('🗑️ Deleting ALL email logs...');
            try {
                const EmailLog = require('../models/EmailLog');
                const emailLogDeleteResult = await EmailLog.deleteMany({}).session(session);
                cleanup.emailLogs = emailLogDeleteResult.deletedCount;
                console.log(`🗑️ Deleted ${cleanup.emailLogs} email log records`);
            } catch (error) {
                console.warn('⚠️ Error deleting email logs:', error.message);
                cleanup.errors.push(`Email logs: ${error.message}`);
            }

            // 3. Delete ALL Tasks related to campaigns
            console.log('🗑️ Deleting ALL campaign-related tasks...');
            try {
                const Task = require('../models/Task');
                const taskDeleteResult = await Task.deleteMany({
                    campaignId: { $exists: true }
                }).session(session);
                cleanup.tasks = taskDeleteResult.deletedCount;
                console.log(`🗑️ Deleted ${cleanup.tasks} campaign tasks`);
            } catch (error) {
                console.warn('⚠️ Error deleting tasks:', error.message);
                cleanup.errors.push(`Tasks: ${error.message}`);
            }

            // 4. Delete ALL CampaignExecution records
            console.log('🗑️ Deleting ALL campaign executions...');
            try {
                const executionDeleteResult = await CampaignExecution.deleteMany({}).session(session);
                cleanup.executions = executionDeleteResult.deletedCount;
                console.log(`🗑️ Deleted ${cleanup.executions} campaign executions`);
            } catch (error) {
                console.error('❌ Error deleting campaign executions:', error);
                cleanup.errors.push(`Campaign executions: ${error.message}`);
                throw error; // This is critical, so throw if it fails
            }

            // 5. Delete ALL Campaigns
            console.log('🗑️ Deleting ALL campaigns...');
            try {
                const campaignDeleteResult = await Campaign.deleteMany({}).session(session);
                cleanup.campaigns = campaignDeleteResult.deletedCount;
                console.log(`🗑️ Deleted ${cleanup.campaigns} campaigns`);
            } catch (error) {
                console.error('❌ Error deleting campaigns:', error);
                cleanup.errors.push(`Campaigns: ${error.message}`);
                throw error; // This is critical, so throw if it fails
            }

            // 6. Delete ALL LinkedIn Instructions
            console.log('🗑️ Deleting ALL LinkedIn instructions...');
            try {
                const LinkedInInstruction = require('../models/LinkedInInstruction');
                const instructionDeleteResult = await LinkedInInstruction.deleteMany({}).session(session);
                cleanup.instructions = instructionDeleteResult.deletedCount;
                console.log(`🗑️ Deleted ${cleanup.instructions} LinkedIn instructions`);
            } catch (error) {
                console.warn('⚠️ Error deleting LinkedIn instructions:', error.message);
                cleanup.errors.push(`LinkedIn instructions: ${error.message}`);
            }

            // 7. Clear any Redis cache related to campaigns (optional)
            console.log('🧹 Clearing campaign-related cache...');
            try {
                const redis = require('ioredis');
                const redisClient = new redis({
                    host: process.env.REDIS_HOST || 'localhost',
                    port: process.env.REDIS_PORT || 6379,
                    password: process.env.REDIS_PASSWORD || undefined,
                });

                // Clear campaign-related cache keys
                const cacheKeys = await redisClient.keys('campaign:*');
                if (cacheKeys.length > 0) {
                    await redisClient.del(...cacheKeys);
                    console.log(`🧹 Cleared ${cacheKeys.length} campaign cache keys`);
                }

                redisClient.disconnect();
            } catch (cacheError) {
                console.warn('⚠️ Error clearing cache:', cacheError.message);
                cleanup.errors.push(`Cache clearing: ${cacheError.message}`);
            }

            // Commit the transaction
            await session.commitTransaction();

            console.log(`✅ GLOBAL CLEANUP COMPLETED SUCCESSFULLY`);
            console.log('📊 Final cleanup summary:', cleanup);

            // Log cleanup summary
            if (cleanup.errors.length > 0) {
                console.warn('⚠️ Some cleanup operations had errors:', cleanup.errors);
            }

            res.json({
                success: true,
                message: `🚨 GLOBAL CLEANUP COMPLETED: Deleted ALL campaigns, executions, tasks, and related data`,
                data: {
                    campaignsDeleted: cleanup.campaigns,
                    executionsDeleted: cleanup.executions,
                    tasksDeleted: cleanup.tasks,
                    emailLogsDeleted: cleanup.emailLogs,
                    instructionsDeleted: cleanup.instructions,
                    queueJobsCancelled: cleanup.invitationJobs + cleanup.messageJobs,
                    breakdown: {
                        invitationJobsCancelled: cleanup.invitationJobs,
                        messageJobsCancelled: cleanup.messageJobs
                    },
                    originalCounts: {
                        campaigns: campaignCount,
                        executions: executionCount,
                        tasks: taskCount,
                        emailLogs: emailLogCount
                    },
                    errors: cleanup.errors,
                    timestamp: new Date().toISOString(),
                    performedBy: userId,
                    operation: 'GLOBAL_CAMPAIGN_CLEANUP'
                }
            });

        } catch (error) {
            // Rollback the transaction on error
            await session.abortTransaction();
            console.error('❌ Error during global campaign cleanup:', error);

            res.status(500).json({
                success: false,
                error: error.message,
                transactionRolledBack: true,
                partialCleanup: cleanup
            });
        } finally {
            // End the session
            session.endSession();
        }

    } catch (error) {
        console.error('❌ Error in global campaign cleanup:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

// Get campaign edit status
exports.getCampaignEditStatus = async (req, res) => {
    try {
        const userId = req.user.userId;
        const campaignId = req.params.id;

        const campaign = await Campaign.findOne({ _id: campaignId, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        const runningExecutions = await CampaignExecution.find({
            campaignId: campaignId,
            status: { $in: ['running', 'waiting'] }
        });

        const pausedExecutions = await CampaignExecution.find({
            campaignId: campaignId,
            status: 'paused'
        });

        const totalExecutions = await CampaignExecution.countDocuments({ campaignId });

        const editStatus = {
            campaignStatus: campaign.status,
            canEdit: campaign.status === 'paused',
            canPause: campaign.status === 'active',
            canResume: campaign.status === 'paused',
            runningExecutions: runningExecutions.length,
            pausedExecutions: pausedExecutions.length,
            totalExecutions: totalExecutions,
            lastEdited: campaign.editHistory ? campaign.editHistory[campaign.editHistory.length - 1] : null,
            pausedAt: campaign.pausedAt,
            lastResumed: campaign.lastResumed
        };

        // Provide user-friendly messages
        if (campaign.status === 'paused') {
            editStatus.message = 'Campaign is paused and safe to edit';
            editStatus.instructions = [
                'You can safely modify campaign name, description, prospects, and sequence',
                'Use PUT /api/campaigns/:id/paused-update to make changes',
                'Use POST /api/campaigns/:id/resume to restart the campaign'
            ];
        } else if (campaign.status === 'active' && runningExecutions.length > 0) {
            editStatus.message = 'Campaign is running. Pause first to edit safely.';
            editStatus.instructions = [
                'Use POST /api/campaigns/:id/pause to safely pause the campaign',
                'Wait for all executions to pause',
                'Then edit and resume when ready'
            ];
        } else if (campaign.status === 'draft') {
            editStatus.message = 'Campaign is in draft mode and can be edited freely';
            editStatus.canEdit = true;
            editStatus.instructions = [
                'Use PUT /api/campaigns/:id to edit the campaign',
                'Start the campaign when ready'
            ];
        } else {
            editStatus.message = 'Campaign can be edited';
            editStatus.instructions = ['Use appropriate endpoints based on campaign status'];
        }

        // Add step-by-step editing capability analysis
        if (runningExecutions.length > 0) {
            const currentNodeIds = runningExecutions.map(e => e.currentNodeId);
            const processedNodeIds = runningExecutions.flatMap(e =>
                (e.executionHistory || []).map(h => h.nodeId)
            );

            editStatus.stepEditability = campaign.sequence.map(step => ({
                stepId: step.id,
                stepType: step.stepType,
                canEdit: !currentNodeIds.includes(step.id) && !processedNodeIds.includes(step.id),
                reason: currentNodeIds.includes(step.id)
                    ? 'Currently being processed'
                    : processedNodeIds.includes(step.id)
                        ? 'Already processed by some prospects'
                        : 'Safe to edit'
            }));
        }

        res.json({
            success: true,
            campaign: {
                id: campaign._id,
                name: campaign.name,
                status: campaign.status,
                totalProspects: campaign.prospects.length,
                totalSteps: campaign.sequence.length
            },
            editStatus: editStatus
        });

    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Manual trigger for LinkedIn reply check
exports.manualReplyCheck = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.userId;

        // Verify campaign exists and belongs to user
        const campaign = await Campaign.findOne({ _id: id, userId });
        if (!campaign) {
            throw new NotFoundError('Campaign not found');
        }

        // Trigger immediate reply check
        const linkedinReplyMonitor = require('../services/linkedinReplyMonitor');

        // Start async check (don't wait for completion)
        linkedinReplyMonitor.checkLinkedInReplies().catch(error => {
            console.error('Manual reply check error:', error);
        });

        res.json({
            success: true,
            message: 'LinkedIn reply check initiated. This may take a few minutes.',
            campaignId: id
        });

    } catch (error) {
        console.error('Manual reply check error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    createCampaign: exports.createCampaign,
    getCampaigns: exports.getCampaigns,
    getCampaignLimits: exports.getCampaignLimits,
    getCampaign: exports.getCampaign,
    updateCampaign: exports.updateCampaign,
    updatePausedCampaign: exports.updatePausedCampaign,
    deleteCampaign: exports.deleteCampaign,
    deleteAllCampaigns: exports.deleteAllCampaigns,
    startCampaign: exports.startCampaign,
    pauseCampaign: exports.pauseCampaign,
    resumeCampaign: exports.resumeCampaign,
    getCampaignEditStatus: exports.getCampaignEditStatus,
    addProspectsToCampaign: exports.addProspectsToCampaign,
    deleteProspectsFromCampaign: exports.deleteProspectsFromCampaign,
    bulkOperations: exports.bulkOperations,
    duplicateCampaign: exports.duplicateCampaign,
    getCampaignExecutions: exports.getCampaignExecutions,
    getProspectExecution: exports.getProspectExecution,
    getCampaignActivity: exports.getCampaignActivity,
    getScheduledActions: exports.getScheduledActions,
    getCampaignStats: exports.getCampaignStats,
    getCampaignSettings: exports.getCampaignSettings,
    updateCampaignSettings: exports.updateCampaignSettings,
    getLinkedInPresets: exports.getLinkedInPresets,
    applyCampaignPreset: exports.applyCampaignPreset,
    resetCampaignToGlobalSettings: exports.resetCampaignToGlobalSettings,
    getProspectDetails: exports.getProspectDetails,
    deleteAllCampaignsGlobal: exports.deleteAllCampaignsGlobal,
    manualReplyCheck: exports.manualReplyCheck
};
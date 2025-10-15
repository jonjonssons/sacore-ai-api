const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const Campaign = require('../models/Campaign');
const CampaignExecution = require('../models/CampaignExecution');

// Add CORS headers for all LinkedIn routes
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Sync LinkedIn session from extension
router.post('/sync-session', authenticateUser, async (req, res) => {
    try {
        const { sessionData } = req.body;
        const userId = req.user.userId;

        // Validate session data
        if (!sessionData || !sessionData.cookies) {
            return res.status(400).json({
                success: false,
                error: 'Invalid session data provided'
            });
        }

        // Transform cookies to match schema expectations
        const transformedCookies = sessionData.cookies.map(cookie => {
            if (cookie.sameSite) {
                // Transform lowercase sameSite values to capitalized ones expected by schema
                switch (cookie.sameSite.toLowerCase()) {
                    case 'lax':
                        cookie.sameSite = 'Lax';
                        break;
                    case 'strict':
                        cookie.sameSite = 'Strict';
                        break;
                    case 'none':
                        cookie.sameSite = 'None';
                        break;
                    case 'unspecified':
                        cookie.sameSite = 'unspecified';
                        break;
                    case 'no_restriction':
                        cookie.sameSite = 'no_restriction';
                        break;
                    default:
                        // If it's already in the correct format or unknown, keep as is
                        break;
                }
            }
            return cookie;
        });

        // Store LinkedIn session data
        const LinkedInSession = require('../models/LinkedInSession');

        const sessionDoc = await LinkedInSession.findOneAndUpdate(
            { userId },
            {
                cookies: transformedCookies,
                userAgent: sessionData.userAgent || 'Unknown',
                lastSync: new Date(),
                isActive: true,
                sessionMetadata: {
                    url: sessionData.url,
                    timestamp: sessionData.timestamp,
                    isLinkedInPage: sessionData.isLinkedInPage,
                    cookieCount: transformedCookies.length
                }
            },
            { upsert: true, new: true }
        );


        // Also create/update ConnectedAccount for backend campaign compatibility
        const ConnectedAccount = require('../models/ConnectedAccount');

        await ConnectedAccount.findOneAndUpdate(
            { userId, type: 'linkedin' },
            {
                userId,
                type: 'linkedin',
                provider: 'linkedin',
                isActive: true,
                cookies: sessionData.cookies,
                userAgent: sessionData.userAgent || 'Unknown',
                cookieUpdatedAt: new Date(),
                lastSync: new Date()
            },
            { upsert: true }
        );


        res.json({
            success: true,
            message: 'LinkedIn session synced successfully',
            sessionId: sessionDoc._id,
            lastSync: sessionDoc.lastSync
        });
    } catch (error) {
        console.error('LinkedIn session sync error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pending LinkedIn actions for extension
router.get('/pending-actions', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;

        console.log('Fetching pending LinkedIn actions for user:', userId);

        // Get pending LinkedIn actions from campaigns
        const pendingExecutions = await CampaignExecution.find({
            userId,
            status: { $in: ['waiting', 'running'] },
            'scheduledActions.scheduledFor': { $lte: new Date() },
            'scheduledActions.processed': false
        }).populate('campaignId');

        console.log(`Found ${pendingExecutions.length} executions with pending actions`);

        const actions = [];

        for (const execution of pendingExecutions) {
            if (!execution.campaignId) continue;

            const unprocessedActions = execution.scheduledActions.filter(
                action => !action.processed && action.scheduledFor <= new Date()
            );

            for (const action of unprocessedActions) {
                // Get the step details
                const step = execution.campaignId.sequence.find(
                    s => s.id === action.nodeId
                );

                if (step && ['linkedin-message', 'linkedin-invitation', 'linkedin-visit'].includes(step.stepType)) {
                    // Get prospect details
                    const prospect = execution.campaignId.prospects.id(execution.prospectId);

                    if (prospect) {
                        actions.push({
                            id: `${execution._id}_${action._id}`,
                            type: step.stepType,
                            data: {
                                prospect: {
                                    name: prospect.name,
                                    email: prospect.email,
                                    company: prospect.company,
                                    position: prospect.position,
                                    linkedin: prospect.linkedin,
                                    profileId: prospect.profileId
                                },
                                content: step.content,
                                executionId: execution._id,
                                actionId: action._id,
                                campaignId: execution.campaignId._id,
                                stepId: step.id
                            },
                            scheduledFor: action.scheduledFor,
                            createdAt: execution.createdAt
                        });
                    }
                }
            }
        }

        console.log(`Returning ${actions.length} pending LinkedIn actions`);

        res.json({
            success: true,
            data: actions,
            count: actions.length
        });
    } catch (error) {
        console.error('Error fetching pending actions:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pending LinkedIn profile visits for extension
router.get('/pending-visits', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No authorization token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        console.log('Fetching pending LinkedIn visits for user:', userId);

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.json({
                success: true,
                visits: [],
                count: 0
            });
        }

        // Get pending visits from the session
        const pendingVisits = session.pendingVisits || [];

        console.log(`Found ${pendingVisits.length} pending visits`);

        res.json({
            success: true,
            visits: pendingVisits,
            count: pendingVisits.length
        });
    } catch (error) {
        console.error('Error fetching pending visits:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pending LinkedIn invitations for extension
router.get('/pending-invitations', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No authorization token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        console.log('Fetching pending LinkedIn invitations for user:', userId);

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.json({
                success: true,
                invitations: [],
                count: 0
            });
        }

        // Get pending invitations from the session
        const pendingInvitations = session.pendingInvitations || [];

        console.log(`Found ${pendingInvitations.length} pending invitations`);

        res.json({
            success: true,
            invitations: pendingInvitations,
            count: pendingInvitations.length
        });
    } catch (error) {
        console.error('Error fetching pending invitations:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Report LinkedIn invitation completion from extension
router.post('/invitation-completed', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No authorization token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        const { invitationId, success, error, profileData } = req.body;

        console.log('Invitation completion report:', { invitationId, success, error });

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'LinkedIn session not found'
            });
        }

        // Find and remove from pending invitations
        const pendingIndex = session.pendingInvitations.findIndex(
            inv => inv.invitationId === invitationId
        );

        if (pendingIndex === -1) {
            return res.status(404).json({
                success: false,
                error: 'Invitation not found in pending queue'
            });
        }

        const invitation = session.pendingInvitations[pendingIndex];
        session.pendingInvitations.splice(pendingIndex, 1);

        // Add to completed invitations
        session.completedInvitations = session.completedInvitations || [];
        session.completedInvitations.push({
            ...invitation,
            completedAt: new Date(),
            success,
            error,
            profileUrl: invitation.profileUrl, // Ensure profileUrl is at root level
            profileName: profileData?.profileName || 'Unknown',
            profileData
        });

        await session.save();

        console.log(`✅ Invitation ${invitationId} marked as ${success ? 'completed' : 'failed'}`);

        res.json({
            success: true,
            message: 'Invitation completion recorded'
        });
    } catch (error) {
        console.error('Error recording invitation completion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pending LinkedIn messages for extension
router.get('/pending-messages', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No authorization token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        console.log('Fetching pending LinkedIn messages for user:', userId);

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.json({
                success: true,
                messages: [],
                count: 0
            });
        }

        // Get pending messages from the session
        const pendingMessages = session.pendingMessages || [];

        console.log(`Found ${pendingMessages.length} pending messages`);

        res.json({
            success: true,
            messages: pendingMessages,
            count: pendingMessages.length
        });
    } catch (error) {
        console.error('Error fetching pending messages:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Report LinkedIn message completion from extension
router.post('/message-completed', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No authorization token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        const { messageId, success, error, profileData } = req.body;

        console.log('Message completion report:', { messageId, success, error });

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'LinkedIn session not found'
            });
        }

        // Find and remove from pending messages
        const pendingIndex = session.pendingMessages.findIndex(
            msg => msg.messageId === messageId
        );

        if (pendingIndex === -1) {
            return res.status(404).json({
                success: false,
                error: 'Message not found in pending queue'
            });
        }

        const message = session.pendingMessages[pendingIndex];
        session.pendingMessages.splice(pendingIndex, 1);

        // Add to completed messages
        session.completedMessages = session.completedMessages || [];
        session.completedMessages.push({
            ...message,
            completedAt: new Date(),
            success,
            error,
            profileUrl: message.profileUrl, // Ensure profileUrl is at root level
            profileName: profileData?.profileName || 'Unknown',
            profileData
        });

        await session.save();

        console.log(`✅ Message ${messageId} marked as ${success ? 'completed' : 'failed'}`);

        res.json({
            success: true,
            message: 'Message completion recorded'
        });
    } catch (error) {
        console.error('Error recording message completion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark action as completed
router.post('/actions/:actionId/complete', authenticateUser, async (req, res) => {
    try {
        const { actionId } = req.params;
        const { result, completedAt } = req.body;
        const userId = req.user.userId;

        console.log('Marking action as completed:', actionId);

        // Parse action ID (format: executionId_actionId)
        const [executionId, scheduledActionId] = actionId.split('_');

        if (!executionId || !scheduledActionId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action ID format'
            });
        }

        // Find and update the execution
        const execution = await CampaignExecution.findOne({
            _id: executionId,
            userId
        });

        if (!execution) {
            return res.status(404).json({
                success: false,
                error: 'Execution not found'
            });
        }

        // Find and mark the scheduled action as processed
        const scheduledAction = execution.scheduledActions.id(scheduledActionId);
        if (scheduledAction) {
            scheduledAction.processed = true;
            scheduledAction.processedAt = new Date(completedAt || Date.now());
        }

        // Add to execution history
        execution.executionHistory.push({
            nodeId: scheduledAction?.nodeId,
            executedAt: new Date(completedAt || Date.now()),
            status: 'success',
            result: result,
            source: 'extension'
        });

        // Update execution status
        execution.lastActivity = new Date();

        // Check if there are more pending actions
        const hasMorePending = execution.scheduledActions.some(
            action => !action.processed && action.scheduledFor <= new Date()
        );

        if (!hasMorePending) {
            execution.status = 'waiting'; // Will be picked up by scheduler for next steps
        }

        await execution.save();

        console.log('Action marked as completed successfully');

        res.json({
            success: true,
            message: 'Action marked as completed',
            executionStatus: execution.status
        });
    } catch (error) {
        console.error('Error marking action as completed:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark action as failed
router.post('/actions/:actionId/fail', authenticateUser, async (req, res) => {
    try {
        const { actionId } = req.params;
        const { error: errorMessage, failedAt } = req.body;
        const userId = req.user.userId;

        console.log('Marking action as failed:', actionId, errorMessage);

        // Parse action ID
        const [executionId, scheduledActionId] = actionId.split('_');

        if (!executionId || !scheduledActionId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action ID format'
            });
        }

        // Find and update the execution
        const execution = await CampaignExecution.findOne({
            _id: executionId,
            userId
        });

        if (!execution) {
            return res.status(404).json({
                success: false,
                error: 'Execution not found'
            });
        }

        // Find and mark the scheduled action as processed (but failed)
        const scheduledAction = execution.scheduledActions.id(scheduledActionId);
        if (scheduledAction) {
            scheduledAction.processed = true;
            scheduledAction.processedAt = new Date(failedAt || Date.now());
        }

        // Add to execution history
        execution.executionHistory.push({
            nodeId: scheduledAction?.nodeId,
            executedAt: new Date(failedAt || Date.now()),
            status: 'failed',
            errorMessage: errorMessage,
            source: 'extension'
        });

        // Update execution status
        execution.lastActivity = new Date();
        execution.status = 'failed';

        await execution.save();

        console.log('Action marked as failed successfully');

        res.json({
            success: true,
            message: 'Action marked as failed',
            executionStatus: execution.status
        });
    } catch (error) {
        console.error('Error marking action as failed:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Handle profile detection from extension
router.post('/profile-detected', authenticateUser, async (req, res) => {
    try {
        const profileData = req.body;
        const userId = req.user.userId;

        console.log('Profile detected from extension:', {
            userId,
            profileId: profileData.profileId,
            name: profileData.name
        });

        // Store profile detection for potential use
        // You could save this to a ProfileDetection model or use it for campaign targeting

        res.json({
            success: true,
            message: 'Profile detection recorded'
        });
    } catch (error) {
        console.error('Profile detection error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get LinkedIn session status
router.get('/session-status', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.json({
                success: true,
                isConnected: false,
                lastSync: null
            });
        }

        // Check if session is recent (within last 24 hours)
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const isRecent = session.lastSync > twentyFourHoursAgo;

        res.json({
            success: true,
            isConnected: true,
            isRecent: isRecent,
            lastSync: session.lastSync,
            cookieCount: session.cookies?.length || 0,
            sessionId: session._id
        });
    } catch (error) {
        console.error('Session status error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Force check campaigns (for manual triggering)
router.post('/check-campaigns', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Trigger campaign processing
        const campaignService = require('../services/campaignService');
        await campaignService.processScheduledActions();

        res.json({
            success: true,
            message: 'Campaign check triggered'
        });
    } catch (error) {
        console.error('Campaign check error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get extension stats
router.get('/stats', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Get campaign stats
        const campaigns = await Campaign.find({ userId });
        const activeCampaigns = campaigns.filter(c => c.status === 'active');

        // Get execution stats
        const executions = await CampaignExecution.find({ userId });
        const linkedinExecutions = executions.filter(e =>
            e.executionHistory.some(h => h.source === 'extension')
        );

        let linkedinMessagesSent = 0;
        let linkedinInvitationsSent = 0;

        linkedinExecutions.forEach(execution => {
            execution.executionHistory.forEach(history => {
                if (history.source === 'extension' && history.status === 'success') {
                    // Count based on step type (you'd need to track this)
                    linkedinMessagesSent++;
                }
            });
        });

        res.json({
            success: true,
            stats: {
                totalCampaigns: campaigns.length,
                activeCampaigns: activeCampaigns.length,
                totalProspects: campaigns.reduce((sum, c) => sum + (c.stats?.totalProspects || 0), 0),
                linkedinMessagesSent,
                linkedinInvitationsSent,
                extensionExecutions: linkedinExecutions.length
            }
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Handle manual profile visits from extension
router.post('/manual-profile-visit', authenticateUser, async (req, res) => {
    try {
        const profileData = req.body;
        const userId = req.user.userId;

        console.log('👤 [Backend] Manual profile visit detected:', {
            profileId: profileData.profileId,
            name: profileData.name,
            url: profileData.url,
            userId: userId
        });

        // Check if this profile visit matches any pending campaign actions
        const CampaignExecution = require('../models/CampaignExecution');
        const Campaign = require('../models/Campaign');

        // Look for active campaigns with linkedin-visit steps waiting for this profile
        const pendingExecutions = await CampaignExecution.find({
            userId: userId,
            status: { $in: ['running', 'paused'] },
            'scheduledActions': {
                $elemMatch: {
                    stepType: 'linkedin-visit',
                    processed: false,
                    profileUrl: { $regex: profileData.profileId, $options: 'i' }
                }
            }
        }).populate('campaignId');

        let matchedCampaign = null;

        if (pendingExecutions.length > 0) {
            const execution = pendingExecutions[0];
            matchedCampaign = {
                id: execution.campaignId._id,
                name: execution.campaignId.name
            };

            console.log('🎯 [Backend] Profile visit matched pending campaign:', matchedCampaign.name);

            // Mark the linkedin-visit action as completed
            await CampaignExecution.updateOne(
                {
                    _id: execution._id,
                    'scheduledActions.stepType': 'linkedin-visit',
                    'scheduledActions.processed': false
                },
                {
                    $set: {
                        'scheduledActions.$.processed': true,
                        'scheduledActions.$.processedAt': new Date(),
                        'scheduledActions.$.result': {
                            success: true,
                            method: 'manual_user_visit',
                            profileData: profileData,
                            visitedAt: profileData.detectedAt
                        }
                    }
                }
            );

            console.log('✅ [Backend] Campaign action marked as completed via manual visit');
        }

        // Store the profile visit for analytics
        const ProfileVisit = require('../models/ProfileVisit');
        await ProfileVisit.create({
            userId: userId,
            profileUrl: profileData.url,
            profileId: profileData.profileId,
            profileName: profileData.name,
            visitType: 'manual_user_visit',
            visitedAt: new Date(profileData.detectedAt || profileData.timestamp),
            campaignId: matchedCampaign?.id || null,
            profileData: profileData
        });

        res.json({
            success: true,
            message: 'Manual profile visit recorded',
            matchedCampaign: matchedCampaign,
            profileId: profileData.profileId
        });

    } catch (error) {
        console.error('❌ [Backend] Error handling manual profile visit:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Mark profile visit as completed
router.post('/visit-completed', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'No authorization token provided'
            });
        }

        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        const { visitId, profileUrl, profileName, success, error, profileData } = req.body;

        console.log('Profile visit completed:', { visitId, profileUrl, profileName, success });

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'LinkedIn session not found'
            });
        }

        // Remove from pending visits using visitId or profileUrl
        const initialPendingCount = session.pendingVisits ? session.pendingVisits.length : 0;
        session.pendingVisits = session.pendingVisits.filter(
            visit => visit.visitId !== visitId && visit.profileUrl !== profileUrl
        );
        const finalPendingCount = session.pendingVisits.length;

        console.log(`Removed ${initialPendingCount - finalPendingCount} visits from pending queue`);

        // Add to completed visits
        if (!session.completedVisits) {
            session.completedVisits = [];
        }

        session.completedVisits.push({
            visitId,
            profileUrl,
            profileName,
            success,
            error,
            profileData,
            completedAt: new Date()
        });

        await session.save();

        console.log('Visit marked as completed and removed from pending queue');

        res.json({
            success: true,
            message: 'Visit completed successfully'
        });
    } catch (error) {
        console.error('Error marking visit as completed:', error);
        console.error('Request body:', req.body);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Save current user's LinkedIn URL and fetch profile URN from /me endpoint
router.post('/save-user-profile', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { linkedinUrl, profileUrn, profileName, linkedinSessionFingerprint, cookies, userAgent } = req.body;

        if (!linkedinUrl) {
            return res.status(400).json({
                success: false,
                error: 'LinkedIn URL is required'
            });
        }

        // ✅ NEW: Allow direct URN from extension (bypass cookie requirement)
        if (profileUrn) {
            console.log('🔍 [API] Caching URN provided by extension:', profileUrn);
            if (linkedinSessionFingerprint) {
                console.log('🔐 [API] LinkedIn session fingerprint:', linkedinSessionFingerprint.substring(0, 10) + '...');
            }

            const User = require('../models/User');
            let user = await User.findById(userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            if (!user.linkedinProfile) {
                user.linkedinProfile = {};
            }

            user.linkedinProfile.profileUrl = linkedinUrl;
            user.linkedinProfile.profileUrn = profileUrn;
            user.linkedinProfile.urnSource = 'extension_provided';
            user.linkedinProfile.urnLastUpdated = new Date();

            // Save profile name if provided
            if (profileName) {
                user.linkedinProfile.profileName = profileName;
            }

            // Save LinkedIn session fingerprint for account switch detection
            if (linkedinSessionFingerprint) {
                user.linkedinProfile.linkedinSessionFingerprint = linkedinSessionFingerprint;
            }

            await user.save();

            console.log('✅ [API] Cached URN from extension successfully');

            return res.json({
                success: true,
                message: 'User LinkedIn profile saved successfully',
                data: {
                    profileUrl: linkedinUrl,
                    profileUrn: profileUrn,
                    profileName: profileName || null,
                    urnSource: 'extension_provided',
                    linkedinSessionFingerprint: linkedinSessionFingerprint || null
                }
            });
        }

        // ✅ EXISTING: Cookie-based flow (for manual setup via frontend)
        if (!cookies || !Array.isArray(cookies)) {
            return res.status(400).json({
                success: false,
                error: 'Active session cookies are required from extension'
            });
        }

        // Validate LinkedIn URL format
        if (!linkedinUrl.match(/linkedin\.com\/in\/[^\/\?]+/)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid LinkedIn profile URL format'
            });
        }

        console.log('🔍 [API] Saving user LinkedIn profile for user:', userId);

        const User = require('../models/User');

        // Get current user
        let user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Clean up URL
        const cleanUrl = linkedinUrl.split('?')[0].split('#')[0];

        // Initialize linkedinProfile if it doesn't exist
        if (!user.linkedinProfile) {
            user.linkedinProfile = {};
        }

        user.linkedinProfile.profileUrl = cleanUrl;

        // Fetch URN from LinkedIn /me endpoint using live session cookies
        let userProfileUrn = null;
        let fetchedProfileName = null;
        let urnSource = 'api_fetch_failed';

        try {
            console.log('🔍 [API] Fetching user profile URN from /me endpoint...');

            // Format cookies for request
            const linkedinService = require('../services/linkedinService');
            const cookieString = linkedinService.formatCookieString(cookies);
            const csrfToken = linkedinService.extractCSRFToken(cookies);

            if (!csrfToken) {
                throw new Error('No CSRF token found in session cookies');
            }

            const axios = require('axios');
            const response = await axios.get('https://www.linkedin.com/voyager/api/me', {
                headers: {
                    'accept': 'application/vnd.linkedin.normalized+json+2.1',
                    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
                    'user-agent': userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
                    'cookie': cookieString,
                    'csrf-token': csrfToken,
                    'x-restli-protocol-version': '2.0.0'
                },
                timeout: 10000
            });

            console.log('✅ [API] /me endpoint response received');

            // Extract URN from response - try multiple sources
            if (response.data?.included?.[0]) {
                const profile = response.data.included[0];

                // Try dashEntityUrn first (most reliable)
                if (profile.dashEntityUrn && profile.dashEntityUrn.includes('fsd_profile:')) {
                    userProfileUrn = profile.dashEntityUrn.split(':').pop(); // Extract ID only
                    urnSource = 'me_endpoint_dash';
                }
                // Fallback to *miniProfile
                else if (response.data.data?.['*miniProfile']) {
                    const miniProfileUrn = response.data.data['*miniProfile'];
                    if (miniProfileUrn.includes('fs_miniProfile:')) {
                        userProfileUrn = miniProfileUrn.split(':').pop(); // Extract ID only
                        urnSource = 'me_endpoint_mini';
                    }
                }
                // Last fallback to plainId
                else if (response.data.data?.plainId) {
                    userProfileUrn = response.data.data.plainId.toString();
                    urnSource = 'me_endpoint_plain';
                }

                // Extract profile name
                if (profile.firstName && profile.lastName) {
                    fetchedProfileName = `${profile.firstName} ${profile.lastName}`;
                } else if (profile.firstName) {
                    fetchedProfileName = profile.firstName;
                }
            }

            if (!userProfileUrn) {
                throw new Error('Could not extract profile URN from /me endpoint response');
            }

            console.log('✅ [API] Profile URN extracted:', userProfileUrn);
            console.log('✅ [API] Profile name extracted:', fetchedProfileName);
            urnSource = 'me_endpoint_success';

        } catch (urnError) {
            console.error('⚠️ [API] Failed to fetch URN from /me endpoint:', urnError.message);
            urnSource = 'me_endpoint_failed';
            // Continue without URN - save URL at least
        }

        // Update user profile with fetched data
        if (userProfileUrn) {
            user.linkedinProfile.profileUrn = userProfileUrn;
            user.linkedinProfile.urnLastUpdated = new Date();
        }

        if (fetchedProfileName) {
            user.linkedinProfile.profileName = fetchedProfileName;
        }

        user.linkedinProfile.urnSource = urnSource;

        await user.save();

        console.log('✅ [API] User LinkedIn profile saved successfully');

        res.json({
            success: true,
            message: 'User LinkedIn profile saved successfully',
            data: {
                profileUrl: cleanUrl,
                profileUrn: userProfileUrn,
                profileName: fetchedProfileName,
                urnSource: urnSource,
                urnLastUpdated: user.linkedinProfile.urnLastUpdated,
                success: urnSource === 'me_endpoint_success',
                needsRetry: urnSource.includes('failed')
            }
        });

    } catch (error) {
        console.error('❌ [API] Error saving user LinkedIn profile:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current user's cached LinkedIn profile
router.get('/user-profile', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { allowStale = false } = req.query;

        console.log('🔍 [API] Getting cached user LinkedIn profile for user:', userId);

        const User = require('../models/User');
        const user = await User.findById(userId).select('linkedinProfile');

        if (!user || !user.linkedinProfile?.profileUrn) {
            return res.json({
                success: true,
                data: null,
                message: 'No cached LinkedIn profile found'
            });
        }

        const profile = user.linkedinProfile;

        // Check cache age
        const cacheAge = profile.urnLastUpdated ?
            Date.now() - new Date(profile.urnLastUpdated).getTime() :
            Infinity;

        const maxAge = allowStale === 'true' ?
            30 * 24 * 60 * 60 * 1000 : // 30 days for stale
            7 * 24 * 60 * 60 * 1000;   // 7 days for fresh

        const isStale = cacheAge > maxAge;

        if (isStale && allowStale !== 'true') {
            return res.json({
                success: true,
                data: null,
                message: 'Cached profile is stale',
                cacheAge: Math.floor(cacheAge / (24 * 60 * 60 * 1000)) + ' days'
            });
        }

        res.json({
            success: true,
            data: {
                profileUrl: profile.profileUrl,
                profileUrn: profile.profileUrn,
                profileName: profile.profileName,
                linkedinSessionFingerprint: profile.linkedinSessionFingerprint || null,
                urnSource: profile.urnSource || 'unknown',
                urnLastUpdated: profile.urnLastUpdated,
                cacheAge: Math.floor(cacheAge / (24 * 60 * 60 * 1000)) + ' days',
                isStale: cacheAge > 7 * 24 * 60 * 60 * 1000
            }
        });

    } catch (error) {
        console.error('❌ [API] Error getting user LinkedIn profile:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get LinkedIn extension status (with LinkedIn account details)
router.get('/extension-status', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        console.log('🔍 [API] Getting extension status for user:', userId);

        const User = require('../models/User');
        const user = await User.findById(userId).select('linkedInExtensionStatus linkedinProfile');

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const status = user.linkedInExtensionStatus || {};
        const now = new Date();
        const lastSeen = status.lastSeen ? new Date(status.lastSeen) : null;

        // Extension is considered online if:
        // 1. isActive flag is true AND
        // 2. Last seen within 2 minutes (matches extension timeout)
        const EXTENSION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
        const isOnline = status.isActive && lastSeen && (now - lastSeen) < EXTENSION_TIMEOUT_MS;

        // Calculate time since last seen
        let timeSinceLastSeen = null;
        if (lastSeen) {
            const diffMs = now - lastSeen;
            const diffSeconds = Math.floor(diffMs / 1000);
            const diffMinutes = Math.floor(diffSeconds / 60);
            const diffHours = Math.floor(diffMinutes / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                timeSinceLastSeen = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            } else if (diffHours > 0) {
                timeSinceLastSeen = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            } else if (diffMinutes > 0) {
                timeSinceLastSeen = `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
            } else {
                timeSinceLastSeen = `${diffSeconds} second${diffSeconds !== 1 ? 's' : ''} ago`;
            }
        }

        // Determine user-friendly message
        let message;
        if (isOnline) {
            message = 'Extension is active and ready';
        } else if (status.isActive && lastSeen) {
            message = 'Extension appears offline - last seen ' + timeSinceLastSeen;
        } else if (!lastSeen) {
            message = 'Extension has never connected - please open Chrome and ensure extension is active';
        } else {
            message = 'Extension is offline - please open Chrome and ensure extension is active';
        }

        // Get LinkedIn profile information
        const profile = user.linkedinProfile || {};
        const hasLinkedInAccount = !!(profile.profileUrl && profile.profileUrn);

        // Build response object
        const response = {
            success: true,
            extension: {
                isOnline: isOnline,
                isActive: status.isActive || false,
                lastSeen: status.lastSeen,
                lastConnectedAt: status.lastConnectedAt,
                lastDisconnectedAt: status.lastDisconnectedAt,
                timeSinceLastSeen: timeSinceLastSeen,
                status: isOnline ? 'online' : 'offline',
                message: message
            }
        };

        // Add LinkedIn account details if available
        if (hasLinkedInAccount) {
            response.linkedinAccount = {
                profileUrl: profile.profileUrl,
                profileName: profile.profileName || null,
                profileUrn: profile.profileUrn,
                lastUpdated: profile.urnLastUpdated || null,
                urnSource: profile.urnSource || 'unknown'
            };
        } else {
            response.linkedinAccount = null;
        }

        console.log('✅ [API] Extension status:', isOnline ? 'online' : 'offline',
            hasLinkedInAccount ? '| LinkedIn account found' : '| No LinkedIn account');

        res.json(response);

    } catch (error) {
        console.error('❌ [API] Error getting extension status:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Save current user's LinkedIn URL from UI
router.post('/save-user-linkedin-url', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { linkedinUrl } = req.body;

        if (!linkedinUrl) {
            return res.status(400).json({
                success: false,
                error: 'LinkedIn URL is required'
            });
        }

        // Validate LinkedIn URL format
        if (!linkedinUrl.match(/linkedin\.com\/in\/[^\/\?]+/)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid LinkedIn profile URL format'
            });
        }

        console.log('🔍 [API] Saving user LinkedIn URL for user:', userId);

        const LinkedInSession = require('../models/LinkedInSession');

        // Find LinkedIn session
        let session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'LinkedIn session not found. Please sync your LinkedIn session first.'
            });
        }

        // Clean up URL (remove query parameters and fragments)
        const cleanUrl = linkedinUrl.split('?')[0].split('#')[0];

        // Save LinkedIn URL
        session.userLinkedInUrl = cleanUrl;
        await session.save();

        console.log('✅ [API] User LinkedIn URL saved successfully:', cleanUrl);

        res.json({
            success: true,
            message: 'User LinkedIn URL saved successfully',
            userLinkedInUrl: cleanUrl
        });

    } catch (error) {
        console.error('❌ [API] Error saving user LinkedIn URL:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Fetch and store current user's profile URN
router.post('/fetch-user-profile-urn', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;

        console.log('🔍 [API] Fetching user profile URN for user:', userId);

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findValidSession(userId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'No valid LinkedIn session found. Please sync your LinkedIn session first.'
            });
        }

        if (!session.userLinkedInUrl) {
            return res.status(400).json({
                success: false,
                error: 'User LinkedIn URL not found. Please save your LinkedIn profile URL first.'
            });
        }

        // Check if we already have the user's profile URN
        if (session.userProfileUrn) {
            console.log('📋 User profile URN already exists:', session.userProfileUrn);
            return res.json({
                success: true,
                message: 'User profile URN already exists',
                userProfileUrn: session.userProfileUrn,
                cached: true
            });
        }

        const linkedinService = require('../services/linkedinService');
        const result = await linkedinService.fetchAndStoreUserProfileUrn(userId);

        res.json({
            success: true,
            message: 'User profile URN fetched and stored successfully',
            userProfileUrn: result.userProfileUrn,
            cached: false
        });

    } catch (error) {
        console.error('❌ [API] Error fetching user profile URN:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Send LinkedIn invitation
router.post('/send-invitation', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { targetProfileUrl, customMessage } = req.body;

        if (!targetProfileUrl) {
            return res.status(400).json({
                success: false,
                error: 'Target profile URL is required'
            });
        }

        console.log('🎯 [API] Sending LinkedIn invitation to:', targetProfileUrl);

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findValidSession(userId);

        if (!session) {
            return res.status(400).json({
                success: false,
                error: 'No valid LinkedIn session found'
            });
        }

        if (!session.userProfileUrn) {
            return res.status(400).json({
                success: false,
                error: 'User profile URN not found. Please setup your profile first using /setup-user-profile'
            });
        }

        const linkedinService = require('../services/linkedinService');

        // Get target profile URN
        console.log('📋 Getting target profile URN...');
        const targetProfileUrn = await linkedinService.getTargetProfileUrn(session, targetProfileUrl);

        // Send invitation
        console.log('📤 Sending invitation...');
        const invitationResult = await linkedinService.sendLinkedInInvitation(
            session,
            targetProfileUrn,
            targetProfileUrl,
            customMessage || 'I would like to connect with you on LinkedIn.'
        );

        res.json({
            success: true,
            message: 'LinkedIn invitation sent successfully',
            targetProfileUrl: targetProfileUrl,
            targetProfileUrn: targetProfileUrn,
            invitationId: invitationResult.invitationId || null
        });

    } catch (error) {
        console.error('❌ [API] Error sending LinkedIn invitation:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check LinkedIn connection status
router.get('/check-connection-status', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { targetProfileUrl } = req.query;

        if (!targetProfileUrl) {
            return res.status(400).json({
                success: false,
                error: 'Target profile URL is required as query parameter'
            });
        }

        console.log('🔍 [API] Checking LinkedIn connection status for:', targetProfileUrl);

        // Use extension-based connection check
        const campaignService = require('../services/campaignService');
        console.log('📊 Checking connection status via extension...');
        const connectionResult = await campaignService.checkConnectionViaExtension(targetProfileUrl, userId);

        res.json({
            success: true,
            message: 'Connection status checked successfully',
            targetProfileUrl: targetProfileUrl,
            ...connectionResult
        });

    } catch (error) {
        console.error('❌ [API] Error checking LinkedIn connection status:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Send LinkedIn message
router.post('/send-message', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { targetProfileUrl, messageText } = req.body;

        if (!targetProfileUrl || !messageText) {
            return res.status(400).json({
                success: false,
                error: 'Target profile URL and message text are required'
            });
        }

        console.log('💬 [API] Sending LinkedIn message to:', targetProfileUrl);
        console.log('📝 [API] Message preview:', messageText.substring(0, 50) + '...');

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findValidSession(userId);

        if (!session) {
            return res.status(400).json({
                success: false,
                error: 'No valid LinkedIn session found'
            });
        }

        if (!session.userProfileUrn) {
            return res.status(400).json({
                success: false,
                error: 'User profile URN not found. Please setup your profile first using /setup-user-profile'
            });
        }

        const linkedinService = require('../services/linkedinService');

        // Get target profile URN
        console.log('📋 Getting target profile URN...');
        const targetProfileUrn = await linkedinService.getTargetProfileUrn(session, targetProfileUrl);

        // Send message
        console.log('💬 Sending LinkedIn message...');
        const messageResult = await linkedinService.sendLinkedInMessage(
            session,
            targetProfileUrn,
            targetProfileUrl,
            messageText
        );

        res.json({
            success: true,
            message: 'LinkedIn message sent successfully',
            targetProfileUrl: targetProfileUrl,
            messageText: messageText,
            ...messageResult
        });

    } catch (error) {
        console.error('❌ [API] Error sending LinkedIn message:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get LinkedIn session for a user
router.get('/session', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;

        console.log('Fetching LinkedIn session for user:', userId);

        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findOne({ userId, isActive: true });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'No active LinkedIn session found for user'
            });
        }

        // Calculate session health and validity
        const isValid = session.isValid;
        const sessionAge = session.sessionAge;
        const canPerformAction = session.canPerformAction();

        // Prepare response data
        const sessionData = {
            sessionId: session._id,
            userId: session.userId,
            isActive: session.isActive,
            isHealthy: session.isHealthy,
            isValid: isValid,
            sessionAge: sessionAge,
            lastSync: session.lastSync,
            userAgent: session.userAgent,
            userProfileUrn: session.userProfileUrn,
            userLinkedInUrl: session.userLinkedInUrl,

            // Session metadata
            sessionMetadata: session.sessionMetadata,

            // Rate limiting info
            rateLimiting: {
                canPerformAction: canPerformAction.allowed,
                reason: canPerformAction.reason,
                waitTime: canPerformAction.waitTime,
                actionsToday: session.rateLimiting?.actionsToday || 0,
                actionsThisHour: session.rateLimiting?.actionsThisHour || 0,
                lastActionTime: session.rateLimiting?.lastActionTime,
                dailyResetTime: session.rateLimiting?.dailyResetTime,
                hourlyResetTime: session.rateLimiting?.hourlyResetTime
            },

            // Usage statistics
            stats: session.stats,

            // Queue information
            queues: {
                pendingVisits: {
                    count: session.pendingVisits?.length || 0,
                    items: session.pendingVisits || []
                },
                pendingInvitations: {
                    count: session.pendingInvitations?.length || 0,
                    items: session.pendingInvitations || []
                },
                pendingMessages: {
                    count: session.pendingMessages?.length || 0,
                    items: session.pendingMessages || []
                },
                completedVisits: {
                    count: session.completedVisits?.length || 0,
                    recent: session.completedVisits?.slice(-5) || [] // Last 5 completed visits
                },
                completedInvitations: {
                    count: session.completedInvitations?.length || 0,
                    recent: session.completedInvitations?.slice(-5) || [] // Last 5 completed invitations
                },
                completedMessages: {
                    count: session.completedMessages?.length || 0,
                    recent: session.completedMessages?.slice(-5) || [] // Last 5 completed messages
                },
                failedVisits: {
                    count: session.failedVisits?.length || 0,
                    recent: session.failedVisits?.slice(-5) || [] // Last 5 failed visits
                }
            },

            // Health check information
            healthCheck: {
                lastHealthCheck: session.lastHealthCheck,
                healthCheckErrors: session.healthCheckErrors || [],
                recentErrors: session.healthCheckErrors?.slice(-3) || [] // Last 3 errors
            },

            // Cookie information (without exposing actual cookie values)
            cookies: {
                count: session.cookies?.length || 0,
                hasLiAt: session.cookies?.some(c => c.name === 'li_at') || false,
                lastUpdated: session.lastSync
            }
        };

        console.log('LinkedIn session retrieved successfully:', {
            sessionId: session._id,
            isValid: isValid,
            canPerformAction: canPerformAction.allowed,
            pendingActions: (session.pendingVisits?.length || 0) +
                (session.pendingInvitations?.length || 0) +
                (session.pendingMessages?.length || 0)
        });

        res.json({
            success: true,
            data: sessionData
        });
    } catch (error) {
        console.error('Error fetching LinkedIn session:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check LinkedIn connection status via extension (for campaigns)
router.post('/check-connection-via-extension', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { profileUrl, connectionResult } = req.body;

        if (!profileUrl) {
            return res.status(400).json({
                success: false,
                error: 'Profile URL is required'
            });
        }

        if (!connectionResult) {
            return res.status(400).json({
                success: false,
                error: 'Connection result from extension is required'
            });
        }

        console.log('🔍 [API] Extension connection check result received:', {
            profileUrl,
            status: connectionResult.status,
            isConnected: connectionResult.isConnected,
            method: connectionResult.method
        });

        // Validate the connection result structure
        if (typeof connectionResult.success !== 'boolean' ||
            typeof connectionResult.isConnected !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'Invalid connection result format from extension'
            });
        }

        // Return the result for campaign processing
        res.json({
            success: true,
            data: {
                profileUrl: profileUrl,
                connectionStatus: connectionResult.status || 'unknown',
                isConnected: connectionResult.isConnected,
                method: connectionResult.method || 'extension_live_session',
                timestamp: new Date(),
                extensionResult: connectionResult
            }
        });

    } catch (error) {
        console.error('❌ [API] Error processing extension connection check:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get pending connection checks for extension polling (NO LinkedInSession)
// Old connection check endpoint removed - now using instruction system

// Report connection check completion from extension (NO LinkedInSession)
// Old connection check completion endpoint removed - now using instruction system

module.exports = router;
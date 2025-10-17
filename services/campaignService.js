const Campaign = require('../models/Campaign');
const CampaignExecution = require('../models/CampaignExecution');
const ConnectedAccount = require('../models/ConnectedAccount');
const EmailLog = require('../models/EmailLog');
const emailService = require('./emailService');
const { google } = require('googleapis');
const linkedinService = require('./linkedinService');
const { isWorkingHours, getNextWorkingHour } = require('./linkedinInvitationQueue');
const linkedinInstructionService = require('./linkedinInstructionService');



const createGmailTransporter = (accessToken) => {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI
    );

    oauth2Client.setCredentials({
        access_token: accessToken
    });

    return google.gmail({ version: 'v1', auth: oauth2Client });
};
// the refreshGmailToken function:
exports.refreshGmailToken = async (emailAccount) => {
    try {
        // Check if token is still valid (with 5-minute buffer)
        const now = new Date();
        const expiryTime = emailAccount.tokenExpires ? new Date(emailAccount.tokenExpires) : null;
        const bufferTime = 5 * 60 * 1000; // 5 minutes buffer

        if (expiryTime && (expiryTime.getTime() - now.getTime()) > bufferTime) {
            console.log('🔋 Gmail token still valid, skipping refresh');
            return true;
        }

        console.log('🔄 Gmail token expired/expiring soon, refreshing for account:', emailAccount._id);

        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            process.env.GMAIL_REDIRECT_URI
        );

        oauth2Client.setCredentials({
            access_token: emailAccount.accessToken,
            refresh_token: emailAccount.refreshToken
        });

        const { credentials } = await oauth2Client.refreshAccessToken();

        console.log('✅ Gmail token refreshed successfully');

        // Update the account with new token and expiry BEFORE validation
        await ConnectedAccount.findByIdAndUpdate(emailAccount._id, {
            accessToken: credentials.access_token,
            tokenExpires: new Date(credentials.expiry_date),
            updatedAt: new Date()
        });

        // Update the emailAccount object in memory
        emailAccount.accessToken = credentials.access_token;
        emailAccount.tokenExpires = new Date(credentials.expiry_date);

        // Debug: Check token scopes by making a test API call
        try {
            console.log('🔍 DEBUGGING GMAIL TOKEN...');
            console.log('📧 Access Token (first 20 chars):', credentials.access_token?.substring(0, 20) + '...');
            console.log('📧 Refresh Token exists:', !!emailAccount.refreshToken);
            console.log('📧 Token expires at:', emailAccount.tokenExpires);

            const tokenInfo = await oauth2Client.getTokenInfo(credentials.access_token);
            console.log('📧 Token validation successful - Gmail access confirmed');

            // Try to check what scopes are available
            const scopeCheckClient = new google.auth.OAuth2();
            scopeCheckClient.setCredentials({ access_token: credentials.access_token });

            try {
                const tokenInfoResponse = await scopeCheckClient.getTokenInfo(credentials.access_token);
                console.log('📧 TOKEN SCOPE ANALYSIS:');
                console.log('   - Scopes in token:', tokenInfoResponse.scopes);
                console.log('   - Has gmail.send?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.send'));
                console.log('   - Has gmail.readonly?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly'));
                console.log('   - Has gmail.modify?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.modify'));
                console.log('   - Token audience:', tokenInfoResponse.aud);
                console.log('   - Token expires in:', tokenInfoResponse.exp);
            } catch (scopeCheckError) {
                console.log('📧 Could not retrieve scope info:', scopeCheckError.message);

                // Alternative method - try to make a test send call to see the exact error
                try {
                    const tokenInfoResponse = await scopeCheckClient.getTokenInfo(emailAccount.accessToken);
                    console.log('📧 TOKEN SCOPE ANALYSIS:');
                    console.log('   - Scopes in token:', tokenInfoResponse.scopes);
                    console.log('   - Has gmail.send?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.send'));
                    console.log('   - Has gmail.readonly?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly'));
                    console.log('   - Has gmail.modify?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.modify'));
                    console.log('   - Token audience:', tokenInfoResponse.aud);
                    console.log('   - Token expires in:', tokenInfoResponse.exp);
                } catch (scopeCheckError2) {
                    console.log('📧 Could not retrieve scope info:', scopeCheckError2.message);

                    // Alternative method - try to make a send test call to see the exact error
                    try {
                        console.log('🧪 Testing send permission with dummy call...');
                        const gmail = google.gmail({ version: 'v1', auth: scopeCheckClient });
                        await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: {
                                raw: 'test' // This will fail but show us the exact error
                            }
                        });
                    } catch (sendTestError) {
                        console.log('📧 Send test error details:');
                        console.log('   - Error code:', sendTestError.code);
                        console.log('   - Error message:', sendTestError.message);
                        console.log('   - Error details:', JSON.stringify(sendTestError.response?.data, null, 2));
                    }
                }
            }
        } catch (tokenError) {
            console.error('❌ Token validation failed:', tokenError.message);
            console.error('❌ Full token error:', JSON.stringify(tokenError.response?.data, null, 2));
            throw new Error('Gmail token is invalid or expired. Please reconnect your Gmail account.');
        }
        // Update the account with new token and expiry
        await ConnectedAccount.findByIdAndUpdate(emailAccount._id, {
            accessToken: credentials.access_token,
            tokenExpires: new Date(credentials.expiry_date), // Changed from tokenExpiry
            updatedAt: new Date()
        });

        // Update the emailAccount object in memory
        emailAccount.accessToken = credentials.access_token;
        emailAccount.tokenExpires = new Date(credentials.expiry_date);

        return true;
    } catch (refreshError) {
        // If refresh fails, we need to re-authenticate
        console.error('❌ Token refresh failed, need re-authentication:', refreshError.message);

        // Mark account as needing re-auth
        await ConnectedAccount.findByIdAndUpdate(emailAccount._id, {
            needsReauth: true,
            updatedAt: new Date()
        });

        throw new Error('Gmail account needs re-authentication. Please reconnect your Gmail account.');
    }

    return true;
};

// Start campaign - initialize executions for all prospects
exports.startCampaign = async (campaignId, userId) => {
    const campaign = await Campaign.findOne({ _id: campaignId, userId });

    if (!campaign) {
        throw new Error('Campaign not found');
    }

    if (campaign.status !== 'active') {
        throw new Error('Campaign must be active to start');
    }

    if (campaign.prospects.length === 0) {
        throw new Error('Campaign has no prospects');
    }

    // Find the starting node (first node without a parent)
    const startNode = campaign.sequence.find(node => !node.parentId);

    if (!startNode) {
        throw new Error('No starting node found in campaign sequence');
    }

    // Create execution records for each prospect
    const executions = [];
    for (const prospect of campaign.prospects) {
        try {
            // Check if execution already exists
            const existingExecution = await CampaignExecution.findOne({
                campaignId,
                prospectId: prospect._id.toString()
            });

            if (!existingExecution) {
                const execution = new CampaignExecution({
                    campaignId,
                    prospectId: prospect._id.toString(),
                    currentNodeId: startNode.id,
                    status: 'running'
                });

                await execution.save();
                executions.push(execution);
            }
        } catch (error) {
            console.error(`Failed to create execution for prospect ${prospect._id}:`, error);
        }
    }

    // Start processing each execution sequentially to avoid race conditions
    for (let i = 0; i < executions.length; i++) {
        const execution = executions[i];
        // Add a small delay between processing each execution to prevent simultaneous job creation
        setTimeout(() => exports.processProspectNode(execution), i * 100); // 100ms delay between each
    }

    return {
        message: 'Campaign started successfully',
        executionsCreated: executions.length
    };
};

// Process a prospect through a specific node
exports.processProspectNode = async (execution) => {
    console.log('🚀 PROCESSING NODE:', {
        executionId: execution._id,
        currentNodeId: execution.currentNodeId,
        status: execution.status,
        timestamp: new Date().toISOString()
    });

    try {
        const campaign = await Campaign.findById(execution.campaignId);
        const prospect = campaign.prospects.id(execution.prospectId);
        const currentNode = campaign.sequence.find(node => node.id === execution.currentNodeId);

        if (!currentNode || !prospect) {
            console.log('❌ Node or prospect not found');
            await exports.completeExecution(execution, 'failed', 'Node or prospect not found');
            return;
        }

        console.log('📋 Current node details:', {
            id: currentNode.id,
            stepType: currentNode.stepType,
            parentId: currentNode.parentId,
            parentBranch: currentNode.parentBranch,
            delay: currentNode?.content?.delay,
            delayUnit: currentNode?.content?.delayUnit
        });

        // Check if current node has a delay and hasn't been delayed yet
        const nodeDelay = currentNode?.content?.delay || 0;
        const nodeDelayUnit = currentNode?.content?.delayUnit || 'minutes';

        // Check if this node execution was already delayed (to avoid infinite delay loops)
        const wasAlreadyDelayed = execution.executionHistory.some(
            history => history.nodeId === currentNode.id &&
                history.status === 'pending' &&
                history.result?.reason === 'delayed_execution'
        );

        if (nodeDelay > 0 && !wasAlreadyDelayed) {
            const scheduledFor = new Date(Date.now() + exports.calculateDelay(nodeDelay, nodeDelayUnit));

            // Record that this node was delayed
            execution.executionHistory.push({
                nodeId: currentNode.id,
                executedAt: new Date(),
                status: 'pending',
                result: {
                    delay: nodeDelay,
                    delayUnit: nodeDelayUnit,
                    scheduledFor: scheduledFor,
                    reason: 'delayed_execution'
                }
            });

            execution.scheduledActions.push({
                nodeId: currentNode.id,
                scheduledFor,
                actionType: 'process_node'
            });
            execution.status = 'waiting';
            execution.lastActivity = new Date();
            await execution.save();

            console.log('⏰ Current node delayed for:', scheduledFor, `(${nodeDelay} ${nodeDelayUnit})`);
            return;
        }

        // Check working hours for LinkedIn-related condition steps
        const linkedinConditionSteps = ['linkedin-connection-check', 'linkedin-reply-check'];
        const isLinkedInCondition = linkedinConditionSteps.includes(currentNode.stepType);

        if (isLinkedInCondition) {
            const workingHoursSettings = {
                enabled: campaign.linkedinSettings?.workingHours?.enabled || false,
                start: campaign.linkedinSettings?.workingHours?.start || 9,
                end: campaign.linkedinSettings?.workingHours?.end || 17,
                timezone: campaign.linkedinSettings?.workingHours?.timezone || 'UTC',
                weekendsEnabled: campaign.linkedinSettings?.workingHours?.weekendsEnabled || false
            };

            if (workingHoursSettings.enabled && !isWorkingHours(workingHoursSettings)) {
                const nextWorking = getNextWorkingHour(workingHoursSettings);

                console.log('⏰ LinkedIn condition step outside working hours. Scheduling for:', nextWorking);
                console.log('🕐 Working hours settings:', workingHoursSettings);

                // Check if already scheduled for working hours to avoid infinite loops
                const alreadyScheduledForWorkingHours = execution.executionHistory.some(
                    history => history.nodeId === currentNode.id &&
                        history.status === 'pending' &&
                        history.result?.reason === 'waiting_for_working_hours'
                );

                if (!alreadyScheduledForWorkingHours) {
                    // Record that this node was delayed for working hours
                    execution.executionHistory.push({
                        nodeId: currentNode.id,
                        executedAt: new Date(),
                        status: 'pending',
                        result: {
                            scheduledFor: nextWorking,
                            reason: 'waiting_for_working_hours',
                            workingHours: workingHoursSettings
                        }
                    });

                    execution.scheduledActions.push({
                        nodeId: currentNode.id,
                        scheduledFor: nextWorking,
                        actionType: 'process_node'
                    });
                    execution.status = 'waiting';
                    execution.lastActivity = new Date();
                    await execution.save();

                    console.log('⏸️ LinkedIn condition step scheduled for next working hour:', nextWorking);
                    return;
                }
            }
        }

        let result;

        // Handle different step types
        console.log('🔍 [DEBUG] About to switch on stepType:', JSON.stringify(currentNode.stepType));
        console.log('🔍 [DEBUG] stepType type:', typeof currentNode.stepType);
        console.log('🔍 [DEBUG] stepType length:', currentNode.stepType?.length);

        switch (currentNode.stepType) {
            case 'email':
                console.log('📧 Processing email step');
                result = await exports.processEmailStep(currentNode, prospect, campaign);
                break;
            case 'linkedin-message':
                console.log('📱 Processing LinkedIn message');
                result = await exports.processLinkedInMessageExtension(currentNode, prospect, campaign, execution);
                break;
            case 'linkedin-invitation':

                console.log('🖥️ Processing LinkedIn invitation');
                result = await exports.processLinkedInInvitationExtension(currentNode, prospect, campaign, execution);
                break;
            case 'linkedin-visit':

                console.log('🖥️ Processing LinkedIn visit');
                result = await exports.processLinkedInVisitExtension(currentNode, prospect, campaign, execution);
                break;
            case 'manual-task':
                result = await exports.processManualTask(currentNode, prospect, campaign, execution);
                break;
            case 'has-email':
            case 'has-linkedin':
            case 'has-phone':
            case 'email-opened':
            case 'email-reply':
            case 'linkedin-connection-check':
            case 'linkedin-accepted':
            case 'linkedin-opened':
            case 'linkedin-reply-check':
            case 'email-clicked':
            case 'email-unsubscribed':
            case 'custom-condition':
                console.log('🔍 Processing condition:', currentNode.stepType);
                result = await exports.processConditionCheck(currentNode, prospect, campaign);
                console.log('✅ Condition result:', result);
                break;
            default:
                throw new Error(`Unsupported step type: ${currentNode.stepType}`);
        }

        console.log('📝 Processing result:', {
            success: result.success,
            nextNodeId: result.nextNodeId,
            data: result.data,
            error: result.error
        });

        // Record execution history
        execution.executionHistory.push({
            nodeId: currentNode.id,
            executedAt: new Date(),
            status: result.success ? 'success' : 'failed',
            result: result.data,
            nextNodeId: result.nextNodeId,
            errorMessage: result.error
        });

        console.log('📋 Added execution history entry');

        // Handle next steps - NO MORE DELAY LOGIC HERE
        if (result.nextNodeId) {
            const nextNode = campaign.sequence.find(n => n.id === result.nextNodeId);

            console.log('⏭️ Next step:', {
                nextNodeId: result.nextNodeId,
                nextNodeFound: !!nextNode
            });

            execution.currentNodeId = result.nextNodeId;
            execution.lastActivity = new Date();
            await execution.save();
            console.log('🔄 Immediately processing next node:', result.nextNodeId);
            return setImmediate(() => exports.processProspectNode(execution));
        } else {
            // Check if this is a manual task pause (nextNodeId is null but success is true)
            if (result.success && result.data?.executionPaused) {
                console.log('⏸️ Execution paused for manual task completion');
                execution.status = 'paused_for_manual_task';
                execution.lastActivity = new Date();
                await execution.save();
                return;
            } else if (result.success && result.waitingFor && result.waitingJobId) {
                // NEW: Handle waiting for queue job completion
                console.log('⏸️ Execution paused - waiting for queue job completion:', result.waitingJobId);
                execution.status = 'waiting';
                execution.waitingFor = result.waitingFor;
                execution.waitingJobId = result.waitingJobId;
                execution.lastActivity = new Date();
                await execution.save();
                return;
            } else {
                console.log('🏁 No next node - completing execution');
                await exports.completeExecution(execution, 'completed');
                return;
            }
        }

    } catch (error) {
        console.error('💥 ERROR in processProspectNode:', error);
        console.error('💥 Stack:', error.stack);

        execution.executionHistory.push({
            nodeId: execution.currentNodeId,
            executedAt: new Date(),
            status: 'failed',
            errorMessage: error.message
        });

        await exports.completeExecution(execution, 'failed', error.message);
    }
};

// Helper function to find the FIRST email in the thread
async function findFirstEmailInThread(prospect, campaign) {
    try {
        // Look for the first email sent in this campaign to this prospect
        const firstEmail = await EmailLog.findOne({
            prospectId: prospect._id,
            campaignId: campaign._id,
            isFirstInSequence: true
        });

        if (firstEmail) {
            return {
                gmailMessageId: firstEmail.gmailMessageId,
                gmailThreadId: firstEmail.gmailThreadId,
                firstMessageId: firstEmail.customMessageId || firstEmail.gmailMessageId, // Use custom first
                originalSubject: firstEmail.subject
            };
        }

        // Fallback: find the earliest email
        const anyPreviousEmail = await EmailLog.findOne({
            prospectId: prospect._id,
            campaignId: campaign._id
        }).sort({ sentAt: 1 });

        if (anyPreviousEmail) {
            return {
                gmailMessageId: anyPreviousEmail.gmailMessageId,
                gmailThreadId: anyPreviousEmail.gmailThreadId,
                firstMessageId: anyPreviousEmail.customMessageId || anyPreviousEmail.gmailMessageId,
                originalSubject: anyPreviousEmail.subject
            };
        }

        return null;
    } catch (error) {
        console.error('❌ Error finding thread info:', error.message);
        return null;
    }
}

// Helper function to store email data for threading
async function storeEmailForThreading(emailData) {
    try {
        console.log('📧 STORING EMAIL LOG:', {
            prospectId: emailData.prospectId,
            campaignId: emailData.campaignId,
            openToken: emailData.openToken,
            gmailMessageId: emailData.gmailMessageId,
            isFirstInSequence: emailData.isFirstInSequence
        });

        const savedLog = await EmailLog.create(emailData);
        console.log('✅ EMAIL LOG SAVED:', {
            _id: savedLog._id,
            openToken: savedLog.openToken,
            openCount: savedLog.openCount
        });
    } catch (error) {
        console.error('❌ Error storing email data:', error.message);
        console.error('❌ Full error:', error);
        // Don't fail the email send if logging fails
    }
}

// Process email step
exports.processEmailStep = async (node, prospect, campaign) => {
    if (!prospect.email) {
        return {
            success: false,
            error: 'Prospect has no email address',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        let emailAccount;

        if (campaign.emailAccountId) {
            emailAccount = await ConnectedAccount.findOne({
                _id: campaign.emailAccountId,
                userId: campaign.userId,
                type: 'email',
                isActive: true
            });
        } else {
            emailAccount = await ConnectedAccount.findOne({
                userId: campaign.userId,
                type: 'email',
                isDefault: true,
                isActive: true
            });
        }

        if (!emailAccount) {
            throw new Error('No connected email account found');
        }

        try {
            await exports.refreshGmailToken(emailAccount);
        } catch (refreshError) {
            console.error('❌ Failed to refresh Gmail token for email sending:', refreshError.message);
            if (refreshError.message.includes('invalid_grant')) {
                throw new Error('Gmail account needs re-authentication. Please reconnect your Gmail account.');
            }
            throw new Error('Gmail token refresh failed. Please try again or reconnect your account.');
        }

        // Prepare email content with variable substitution
        const emailContent = exports.substituteVariables(node.content.message, prospect);
        const emailSubject = exports.substituteVariables(node.content.subject || '', prospect);

        console.log('🔍 DEBUG - Raw inputs:');
        console.log('🔍 Original message:', JSON.stringify(node.content.message));
        console.log('🔍 Substituted content:', JSON.stringify(emailContent));
        console.log('🔍 Content length:', emailContent.length);
        console.log('🔍 Subject:', JSON.stringify(emailSubject));

        if (!emailContent || emailContent.trim().length === 0) {
            throw new Error('Email content is empty or invalid');
        }

        // Check if this is a follow-up email (no subject provided)
        const isFollowUp = !emailSubject || emailSubject.trim().length === 0;

        let finalSubject = emailSubject; // Keep original subject for first email
        let threadInfo = null;

        // Create Gmail API client early so we can use it for thread lookups
        const gmail = createGmailTransporter(emailAccount.accessToken);

        // Debug: Check token scopes BEFORE attempting to send
        try {
            console.log('🔍 DEBUGGING GMAIL TOKEN BEFORE SEND...');
            console.log('📧 Access Token (first 20 chars):', emailAccount.accessToken?.substring(0, 20) + '...');
            console.log('📧 Refresh Token exists:', !!emailAccount.refreshToken);
            console.log('📧 Token expires at:', emailAccount.tokenExpiresAt);

            // Create a separate OAuth2 client to check token info
            const debugOAuth2Client = new google.auth.OAuth2();
            debugOAuth2Client.setCredentials({ access_token: emailAccount.accessToken });

            try {
                const tokenInfoResponse = await debugOAuth2Client.getTokenInfo(emailAccount.accessToken);
                console.log('📧 TOKEN SCOPE ANALYSIS:');
                console.log('   - Scopes in token:', tokenInfoResponse.scopes);
                console.log('   - Has gmail.send?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.send'));
                console.log('   - Has gmail.readonly?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.readonly'));
                console.log('   - Has gmail.modify?', tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.modify'));
                console.log('   - Token audience:', tokenInfoResponse.aud);
                console.log('   - Token expires in:', tokenInfoResponse.exp);

                // If gmail.send scope is missing, invalidate the token and throw an error
                if (!tokenInfoResponse.scopes?.includes('https://www.googleapis.com/auth/gmail.send')) {
                    console.log('🚫 Gmail token has insufficient scopes - invalidating stored token');

                    // Invalidate the stored token to force re-authentication
                    await ConnectedAccount.findByIdAndUpdate(emailAccount._id, {
                        accessToken: null,
                        refreshToken: null,
                        tokenExpires: null,
                        status: 'disconnected',
                        updatedAt: new Date()
                    });

                    throw new Error('Gmail token missing required gmail.send scope. Please re-authenticate your Gmail account with proper permissions.');
                }
            } catch (scopeCheckError) {
                console.log('📧 Could not retrieve scope info:', scopeCheckError.message);

                // Alternative method - try to make a test send call to see the exact error
                try {
                    console.log('🧪 Testing send permission with dummy call...');
                    await gmail.users.messages.send({
                        userId: 'me',
                        requestBody: {
                            raw: 'dGVzdA==' // base64 encoded "test"
                        }
                    });
                } catch (sendTestError) {
                    console.log('📧 Send test error details:');
                    console.log('   - Error code:', sendTestError.code);
                    console.log('   - Error message:', sendTestError.message);
                    console.log('   - Error details:', JSON.stringify(sendTestError.response?.data, null, 2));

                    if (sendTestError.code === 403 && sendTestError.message.includes('insufficient authentication scopes')) {
                        throw new Error('Gmail account needs re-authentication with proper permissions. Please disconnect and reconnect your Gmail account to grant email sending permissions.');
                    }
                }
            }
        } catch (tokenError) {
            console.error('❌ Token validation failed:', tokenError.message);
            throw tokenError;
        }

        if (isFollowUp) {
            console.log('📧 Follow-up email detected - using Gmail REPLY mechanism WITHOUT subject');

            threadInfo = await findFirstEmailInThread(prospect, campaign);

            if (threadInfo) {
                try {
                    const originalMessage = await gmail.users.messages.get({
                        userId: 'me',
                        id: threadInfo.gmailMessageId,
                        format: 'full'
                    });

                    const headers = originalMessage.data.payload.headers;
                    const originalMessageId = headers.find(h => h.name.toLowerCase() === 'message-id')?.value;
                    const originalSubject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';

                    if (!originalMessageId) throw new Error('Could not extract original Message-ID');

                    // Use a normal reply subject so recipient Gmail threads correctly
                    const normalized = originalSubject.trim();
                    finalSubject = normalized.toLowerCase().startsWith('re:') ? normalized : (normalized ? `Re: ${normalized}` : 'Re:');

                    threadInfo.originalMessageId = originalMessageId;
                    threadInfo.gmailThreadId = originalMessage.data.threadId;

                    console.log('📧 Retrieved original message for reply:', {
                        messageId: originalMessageId,
                        originalSubject,
                        chosenSubject: finalSubject,
                        threadId: originalMessage.data.threadId
                    });
                } catch (error) {
                    console.log('📧 Failed to get original message details:', error.message);
                    // Fallback: still reply, use a generic reply subject to help threading
                    finalSubject = 'Re:';
                }
            } else {
                console.log('📧 No previous email thread found');
                // No thread → treat as new but keep subject blank or provided
                finalSubject = emailSubject && emailSubject.trim().length > 0 ? emailSubject.trim() : 'Re:';
            }
        }

        console.log('📧 PREPARING TO SEND REAL EMAIL:');
        console.log('📧 From:', emailAccount.email);
        console.log('📧 To:', prospect.email);
        console.log('📧 Subject:', finalSubject || '(no subject)');
        console.log('📧 Is Follow-up:', isFollowUp);
        console.log('📧 Thread Info:', threadInfo);
        console.log('📧 Message:', emailContent);

        // Helper function to encode email headers with non-ASCII characters (RFC 2047)
        const encodeEmailHeader = (text) => {
            if (!text || !/[^\x00-\x7F]/.test(text)) {
                return text; // No non-ASCII chars, return as-is
            }
            // RFC 2047 MIME encoding using Base64
            const encoded = Buffer.from(text, 'utf8').toString('base64');
            return `=?UTF-8?B?${encoded}?=`;
        };

        // Create email headers with proper Message-ID format and MIME encoding for special characters
        const messageId = `${Date.now()}.${Math.random().toString(36).substr(2, 9)}@${emailAccount.email.split('@')[1]}`;

        // Encode displayName for international characters (e.g., "Jönsson" won't become "JÃƒÂ¶nsson")
        const encodedDisplayName = encodeEmailHeader(emailAccount.displayName);
        const fromHeader = encodedDisplayName
            ? `From: ${encodedDisplayName} <${emailAccount.email}>`
            : `From: ${emailAccount.email}`;

        const emailHeaders = [
            fromHeader,
            `To: ${prospect.email}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${messageId}>`,
            `MIME-Version: 1.0`
        ];

        // Always include Subject if we have one (Gmail threads on recipient mailbox by subject)
        // Encode subject for international characters
        if (finalSubject && finalSubject.trim().length > 0) {
            const encodedSubject = encodeEmailHeader(finalSubject.trim());
            emailHeaders.splice(2, 0, `Subject: ${encodedSubject}`);
        }

        // Add threading headers for follow-ups - using ACTUAL Gmail Message-ID
        if (isFollowUp && threadInfo) {
            if (threadInfo.originalMessageId) {
                emailHeaders.push(`In-Reply-To: ${threadInfo.originalMessageId}`);
                emailHeaders.push(`References: ${threadInfo.originalMessageId}`);
                console.log('📧 Added Gmail reply headers:', { inReplyTo: threadInfo.originalMessageId });
            } else {
                emailHeaders.push(`In-Reply-To: <${threadInfo.firstMessageId}>`);
                emailHeaders.push(`References: <${threadInfo.firstMessageId}>`);
                console.log('📧 Added threading headers (fallback):', threadInfo.firstMessageId);
            }
        }

        // Build multipart/alternative body with tracking pixel (HTML)
        const boundary = `=_boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        emailHeaders.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

        const crypto = require('crypto');
        const openToken = crypto.randomBytes(16).toString('hex');
        const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const pixelUrl = `${baseUrl}/t/o/${openToken}.gif`;

        console.log('🎯 TRACKING DEBUG:');
        console.log('🎯 Generated openToken:', openToken);
        console.log('🎯 Base URL:', baseUrl);
        console.log('🎯 Complete pixel URL:', pixelUrl);
        console.log('🎯 Prospect ID:', prospect._id);
        console.log('🎯 Campaign ID:', campaign._id);

        const textPart = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${emailContent.trim()}\r\n`;
        const htmlBody = `${emailContent.trim().replace(/\n/g, '<br>')}<img src="${pixelUrl}" width="1" height="1" style="display:none" alt=""/>`;
        const htmlPart = `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${htmlBody}\r\n`;
        const endBoundary = `--${boundary}--`;

        const emailMessage = [
            ...emailHeaders,
            '',
            textPart,
            htmlPart,
            endBoundary
        ].join('\r\n');

        console.log('📧 Complete email message:');
        console.log('📧 Message length:', emailMessage.length);
        console.log('📧 Raw message:');
        console.log(emailMessage);
        console.log('📧 =====================================');

        // Encode message in base64 (URL-safe)
        const encodedMessage = Buffer.from(emailMessage, 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        console.log('📧 Encoded message length:', encodedMessage.length);
        console.log('📧 Encoded message preview:', encodedMessage.substring(0, 100) + '...');

        // Send email via Gmail API with proper threading
        let sendOptions = {
            userId: 'me',
            requestBody: {
                raw: encodedMessage
            }
        };

        // For follow-ups, use the stored threadId from the FIRST email
        if (isFollowUp && threadInfo?.gmailThreadId) {
            try {
                sendOptions.requestBody.threadId = threadInfo.gmailThreadId;
                console.log('📧 Using stored Gmail threadId:', threadInfo.gmailThreadId);
            } catch (threadError) {
                console.log('📧 Error setting thread ID:', threadError.message);
            }
        }

        const response = await gmail.users.messages.send(sendOptions);

        console.log('✅ EMAIL SENT SUCCESSFULLY!');
        console.log('📧 Gmail Message ID:', response.data.id);
        console.log('📧 Gmail Thread ID:', response.data.threadId);
        console.log('📧 Thread Status:', isFollowUp ? 'THREADED REPLY' : 'NEW THREAD');
        console.log('📧 ==========================================');

        // Store email information for future threading - CRITICAL STEP
        await storeEmailForThreading({
            prospectId: prospect._id,
            campaignId: campaign._id,
            gmailMessageId: response.data.id,
            gmailThreadId: response.data.threadId,
            customMessageId: messageId, // Our custom Message-ID for threading
            subject: finalSubject,
            isFirstInSequence: !isFollowUp,
            sentAt: new Date(),
            openToken
        });

        // Update campaign stats
        await Campaign.findByIdAndUpdate(campaign._id, {
            $inc: { 'stats.emailsSent': 1 }
        });

        // Update prospect status
        prospect.status = 'contacted';
        prospect.lastContacted = new Date();
        await campaign.save();

        return {
            success: true,
            data: {
                messageId: response.data.id,
                threadId: response.data.threadId,
                customMessageId: messageId,
                sent: true,
                to: prospect.email,
                subject: finalSubject || '(no subject)',
                isFollowUp: isFollowUp,
                isThreaded: isFollowUp && !!threadInfo,
                threadInfo: threadInfo
            },
            nextNodeId: exports.getNextNodeId(node, campaign, 'main'),
            delay: node.content.delay,
            delayUnit: node.content.delayUnit
        };

    } catch (error) {
        console.error('❌ EMAIL SENDING FAILED:', error.message);
        console.error('❌ Full error object:', JSON.stringify(error, null, 2));
        console.error('❌ Error code:', error.code);
        console.error('❌ Error status:', error.status);
        console.error('❌ Error details:', error.response?.data);

        if (error.code === 401) {
            console.error('🔑 Token expired - need to refresh access token');
        }

        return {
            success: false,
            error: error.message,
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }
};

// Process LinkedIn invitation (Extension Mode)
exports.processLinkedInInvitationExtension = async (node, prospect, campaign, execution) => {
    if (!prospect.linkedin) {
        return {
            success: false,
            error: 'No LinkedIn profile URL provided',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        console.log('📝 [Extension] Processing LinkedIn invitation for:', prospect.linkedin);

        // Substitute variables in message
        const customMessage = exports.substituteVariables(node.content.message || '', prospect);

        // Create instruction instead of queue job
        const result = await linkedinInstructionService.createInvitationInstruction({
            userId: campaign.userId,
            campaignId: campaign._id,
            prospectId: prospect._id,
            executionId: execution._id,
            profileUrl: prospect.linkedin,
            message: customMessage,
            nodeId: node.id,
            nextNodeId: exports.getNextNodeId(node, campaign, 'main'),
            campaign: campaign
        });

        // Update campaign stats (queued count)
        await Campaign.findByIdAndUpdate(campaign._id, {
            $inc: { 'stats.linkedinInvitationsQueued': 1 }
        });

        // Update prospect status
        prospect.status = 'linkedin_invitation_queued';
        prospect.lastActivity = new Date();
        await campaign.save();

        console.log(`✅ [Extension] LinkedIn invitation instruction created: ${result.instructionId}`);

        return {
            success: true,
            data: {
                instructionId: result.instructionId,
                scheduledFor: result.scheduledFor,
                delay: result.delay,
                method: 'extension_instruction'
            },
            waitingFor: 'linkedin-invitation-completion',
            waitingJobId: result.instructionId.toString()
        };

    } catch (error) {
        console.error('❌ [Extension] Error creating invitation instruction:', error);
        return {
            success: false,
            error: error.message,
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }
};

// Process LinkedIn message (Extension Mode)
exports.processLinkedInMessageExtension = async (node, prospect, campaign, execution) => {
    if (!prospect.linkedin) {
        return {
            success: false,
            error: 'No LinkedIn profile URL provided',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        console.log('📝 [Extension] Processing LinkedIn message for:', prospect.linkedin);

        // Substitute variables in message
        const messageText = exports.substituteVariables(node.content.message, prospect);

        if (!messageText || messageText.trim().length === 0) {
            throw new Error('Message content is empty after variable substitution');
        }

        // Create instruction instead of queue job
        const result = await linkedinInstructionService.createMessageInstruction({
            userId: campaign.userId,
            campaignId: campaign._id,
            prospectId: prospect._id,
            executionId: execution._id,
            profileUrl: prospect.linkedin,
            message: messageText,
            nodeId: node.id,
            nextNodeId: exports.getNextNodeId(node, campaign, 'main'),
            campaign: campaign
        });

        // Update prospect status
        prospect.status = 'linkedin_message_queued';
        prospect.lastActivity = new Date();
        await campaign.save();

        console.log(`✅ [Extension] LinkedIn message instruction created: ${result.instructionId}`);

        return {
            success: true,
            data: {
                instructionId: result.instructionId,
                scheduledFor: result.scheduledFor,
                delay: result.delay,
                method: 'extension_instruction'
            },
            waitingFor: 'linkedin-message-completion',
            waitingJobId: result.instructionId.toString()
        };

    } catch (error) {
        console.error('❌ [Extension] Error creating message instruction:', error);
        return {
            success: false,
            error: error.message,
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }
};

// Process LinkedIn visit (Extension Mode)
exports.processLinkedInVisitExtension = async (node, prospect, campaign, execution) => {
    if (!prospect.linkedin) {
        return {
            success: false,
            error: 'No LinkedIn profile URL provided',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        console.log('📝 [Extension] Processing LinkedIn visit for:', prospect.linkedin);

        // Create instruction
        const result = await linkedinInstructionService.createVisitInstruction({
            userId: campaign.userId,
            campaignId: campaign._id,
            prospectId: prospect._id,
            executionId: execution._id,
            profileUrl: prospect.linkedin,
            nodeId: node.id,
            nextNodeId: exports.getNextNodeId(node, campaign, 'main'),
            campaign: campaign
        });

        // Update prospect status
        prospect.status = 'visited';
        prospect.lastActivity = new Date();
        await campaign.save();

        console.log(`✅ [Extension] LinkedIn visit instruction created: ${result.instructionId}`);

        return {
            success: true,
            data: {
                instructionId: result.instructionId,
                scheduledFor: result.scheduledFor,
                delay: result.delay,
                method: 'extension_instruction'
            },
            waitingFor: 'linkedin-visit-completion',
            waitingJobId: result.instructionId.toString()
        };

    } catch (error) {
        console.error('❌ [Extension] Error creating visit instruction:', error);
        return {
            success: false,
            error: error.message,
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }
};

// Process LinkedIn message
exports.processLinkedInMessage = async (node, prospect, campaign) => {
    if (!prospect.linkedin) {
        return {
            success: false,
            error: 'Prospect has no LinkedIn profile',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        // Get user profile URN from User model (no LinkedInSession needed)
        const User = require('../models/User');
        const user = await User.findById(campaign.userId);

        if (!user) {
            throw new Error('User not found');
        }

        if (!user.linkedInProfile?.profileUrn) {
            throw new Error('User LinkedIn profile URN not found. Please setup your profile first using /api/linkedin/save-user-profile');
        }

        // Substitute variables in message
        const messageText = exports.substituteVariables(node.content.message, prospect);

        if (!messageText || messageText.trim().length === 0) {
            throw new Error('Message content is empty after variable substitution');
        }

        console.log('💬 [Campaign] Queuing LinkedIn message to:', prospect.linkedin);
        console.log('📝 [Campaign] Message preview:', messageText.substring(0, 100) + '...');

        // Get target profile URN first (needed for queue job)
        const linkedinService = require('../services/linkedinService');
        const targetProfileUrn = await linkedinService.getTargetProfileUrn(session, prospect.linkedin);

        console.log('💬 [Campaign] Queuing message with campaign settings (handled by queue service)');

        // Add message to Redis queue instead of sending immediately
        const { addMessageJob } = require('./linkedinMessageQueue');

        const queueResult = await addMessageJob({
            userId: campaign.userId,
            targetProfileUrn: targetProfileUrn,
            profileUrl: prospect.linkedin,
            message: messageText,
            campaignId: campaign._id.toString(),
            prospectId: prospect._id?.toString()
        });

        console.log('✅ [Campaign] LinkedIn message queued successfully');
        console.log('📊 [Campaign] Queue details:', {
            jobId: queueResult.jobId,
            delay: Math.round(queueResult.delay / 1000) + 's',
            scheduledAt: queueResult.scheduledAt
        });

        // Update campaign stats (queued, not sent yet)
        await Campaign.findByIdAndUpdate(campaign._id, {
            $inc: { 'stats.linkedinMessagesQueued': 1 }
        });

        // Update prospect status to indicate message was queued
        prospect.status = 'linkedin_message_queued';
        prospect.lastActivity = new Date();
        await campaign.save();

        return {
            success: true,
            message: `LinkedIn message queued successfully. Will be sent in ${Math.round(queueResult.delay / 1000)} seconds.`,
            data: {
                jobId: queueResult.jobId,
                delay: queueResult.delay,
                scheduledAt: queueResult.scheduledAt,
                targetProfileUrn: targetProfileUrn,
                messageText: messageText,
                prospectStatus: 'linkedin_message_queued',
                rateLimits: queueResult.rateLimits,
                waitingForJob: true
            },
            // Don't move to next node yet - wait for job completion
            nextNodeId: null,
            waitingFor: 'linkedin-message-completion',
            waitingJobId: queueResult.jobId
        };

    } catch (error) {
        console.error('❌ [Campaign] LinkedIn message queueing failed:', error.message);

        // Handle specific error cases
        let errorMessage = error.message;
        let nextPath = 'no';

        if (error.message.includes('Rate limit exceeded')) {
            errorMessage = `Rate limit exceeded: ${error.message}`;
            nextPath = 'retry'; // If retry path exists, otherwise falls back to 'no'
        } else if (error.message.includes('Session expired') || error.message.includes('CSRF token')) {
            errorMessage = 'LinkedIn session expired. Please re-authenticate.';
        } else if (error.message.includes('Profile not found')) {
            errorMessage = 'LinkedIn profile not found or not accessible.';
        } else if (error.message.includes('User profile URN not found')) {
            errorMessage = 'User LinkedIn profile not set up. Please configure your LinkedIn profile first.';
        } else if (error.message.includes('Message content is empty')) {
            errorMessage = 'Message content is empty. Please check your message template.';
        } else if (error.message.includes('message lock')) {
            errorMessage = 'Message queue is busy. Please try again in a moment.';
        }

        // Update prospect status to indicate message failed
        try {
            prospect.status = 'linkedin_message_failed';
            prospect.lastActivity = new Date();
            await campaign.save();
        } catch (saveError) {
            console.error('❌ Failed to update prospect status:', saveError.message);
        }

        return {
            success: false,
            error: errorMessage,
            data: {
                originalError: error.message,
                prospectStatus: 'linkedin_message_failed',
                targetUrl: prospect.linkedin
            },
            nextNodeId: exports.getNextNodeId(node, campaign, nextPath)
        };
    }
};

// Process LinkedIn invitation
exports.processLinkedInInvitation = async (node, prospect, campaign) => {
    if (!prospect.linkedin) {
        return {
            success: false,
            error: 'No LinkedIn profile URL provided',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        // LinkedIn invitations are now handled purely via extension with live cookies
        // No LinkedInSession dependency needed

        // STEP 1: Check connection status first before sending invitation
        console.log('🔍 [Campaign] Checking LinkedIn connection status before invitation...');

        try {
            const connectionResult = await exports.checkConnectionViaExtension(prospect.linkedin, campaign.userId, campaign._id, prospect._id, null); const isConnected = connectionResult.status === 'connected' || connectionResult.isConnected === true;

            console.log('🔗 [Campaign] Connection status check result:', {
                profileUrl: prospect.linkedin,
                status: connectionResult.status,
                isConnected: isConnected
            });

            if (isConnected) {
                console.log('✅ [Campaign] Already connected to prospect - skipping invitation');

                // Update prospect status to indicate already connected
                prospect.status = 'linkedin_connected';
                prospect.lastActivity = new Date();
                await campaign.save();

                // Update campaign stats
                await Campaign.findByIdAndUpdate(campaign._id, {
                    $inc: { 'stats.linkedinInvitationsSkipped': 1 }
                });

                return {
                    success: true,
                    message: 'Already connected to this LinkedIn profile - invitation skipped',
                    data: {
                        connectionStatus: connectionResult.status,
                        prospectStatus: 'linkedin_connected',
                        profileUrl: prospect.linkedin,
                        skippedReason: 'Already connected'
                    },
                    nextNodeId: exports.getNextNodeId(node, campaign, 'already_connected') || exports.getNextNodeId(node, campaign, 'main')
                };
            }

            // Check if invitation was already sent (pending status)
            if (connectionResult.status === 'pending' ||
                connectionResult.status === 'invitation_sent' ||
                connectionResult.status === 'invitation_pending') {
                console.log('📤 [Campaign] Invitation already sent to prospect - skipping duplicate');

                // Update prospect status to indicate invitation already sent
                prospect.status = 'linkedin_invitation_sent';
                prospect.lastActivity = new Date();
                await campaign.save();

                // Update campaign stats
                await Campaign.findByIdAndUpdate(campaign._id, {
                    $inc: { 'stats.linkedinInvitationsSkipped': 1 }
                });

                return {
                    success: true,
                    message: 'Invitation already sent to this LinkedIn profile - skipping duplicate',
                    data: {
                        connectionStatus: connectionResult.status,
                        prospectStatus: 'linkedin_invitation_sent',
                        profileUrl: prospect.linkedin,
                        skippedReason: 'Invitation already sent'
                    },
                    nextNodeId: exports.getNextNodeId(node, campaign, 'already_sent') || exports.getNextNodeId(node, campaign, 'main')
                };
            }

            console.log('📤 [Campaign] No existing connection/invitation found - proceeding with invitation');

        } catch (connectionCheckError) {
            console.warn('⚠️ [Campaign] Connection status check failed, proceeding with invitation:', connectionCheckError.message);
            // Continue with invitation if connection check fails (fail-safe approach)
        }

        // STEP 2: Proceed with invitation (original logic)
        // Use Redis queue for LinkedIn invitations
        const { addInvitationJob } = require('./linkedinInvitationQueue');

        // Substitute variables in custom message
        const customMessage = exports.substituteVariables(node.content.message || '', prospect);

        console.log('🤝 [Campaign] Queuing invitation with campaign settings (handled by queue service)');
        console.log('🤝 [Campaign] Queuing LinkedIn invitation to:', prospect.linkedin);
        console.log('📝 [Campaign] Custom message:', customMessage || 'No custom message');

        // Add invitation to Redis queue
        const queueResult = await addInvitationJob({
            userId: campaign.userId,
            profileUrl: prospect.linkedin,
            message: customMessage,
            campaignId: campaign._id.toString(),
            prospectId: prospect._id?.toString()
        });

        console.log('✅ [Campaign] LinkedIn invitation queued successfully');
        console.log('📊 [Campaign] Queue details:', {
            jobId: queueResult.jobId,
            delay: Math.round(queueResult.delay / 1000) + 's',
            scheduledAt: queueResult.scheduledAt
        });

        // Update campaign stats
        await Campaign.findByIdAndUpdate(campaign._id, {
            $inc: { 'stats.linkedinInvitationsQueued': 1 }
        });

        // Update prospect status to indicate invitation was queued
        prospect.status = 'linkedin_invitation_queued';
        prospect.lastActivity = new Date();
        await campaign.save();

        return {
            success: true,
            message: `LinkedIn invitation queued successfully. Will be sent in ${Math.round(queueResult.delay / 1000)} seconds.`,
            data: {
                jobId: queueResult.jobId,
                delay: queueResult.delay,
                scheduledAt: queueResult.scheduledAt,
                message: customMessage || 'No message',
                prospectStatus: 'linkedin_invitation_queued',
                rateLimits: queueResult.rateLimits,
                waitingForJob: true
            },
            // Don't move to next node yet - wait for job completion
            nextNodeId: null,
            waitingFor: 'linkedin-invitation-completion',
            waitingJobId: queueResult.jobId
        };

    } catch (error) {
        console.error('❌ [Campaign] LinkedIn invitation queueing failed:', error.message);

        const errorMessage = error.message.includes('Rate limit exceeded')
            ? `Rate limit exceeded: ${error.message}`
            : `LinkedIn invitation queueing failed: ${error.message}`;

        const nextPath = error.message.includes('Rate limit exceeded') ? 'rate_limit' : 'no';

        // Update prospect status to indicate invitation failed
        try {
            prospect.status = 'linkedin_invitation_failed';
            prospect.lastActivity = new Date();
            await campaign.save();
        } catch (saveError) {
            console.error('Error updating prospect status:', saveError);
        }

        return {
            success: false,
            error: errorMessage,
            data: {
                originalError: error.message,
                prospectStatus: 'linkedin_invitation_failed',
                targetUrl: prospect.linkedin
            },
            nextNodeId: exports.getNextNodeId(node, campaign, nextPath)
        };
    }
};

exports.processLinkedInVisit = async (node, prospect, campaign) => {
    if (!prospect.linkedin) {
        return {
            success: false,
            error: 'No LinkedIn profile URL provided',
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }

    try {
        // First try to find ConnectedAccount (legacy support)
        let linkedinAccount = await ConnectedAccount.findOne({
            userId: campaign.userId,
            type: 'linkedin',
            isActive: true
        });

        // If no ConnectedAccount, check for LinkedInSession
        if (!linkedinAccount) {
            const LinkedInSession = require('../models/LinkedInSession');
            const session = await LinkedInSession.findValidSession(campaign.userId);

            if (!session) {
                throw new Error('No LinkedIn session found. Please sync your LinkedIn session via the extension.');
            }

            // Create a mock account object for compatibility
            linkedinAccount = {
                _id: session._id,
                userId: campaign.userId,
                type: 'linkedin',
                isActive: true,
                cookies: session.cookies,
                userAgent: session.userAgent,
                lastSync: session.lastSync
            };
        }

        // Visit profile via cookie-based session
        const result = await linkedinService.visitProfile(linkedinAccount, prospect.linkedin, campaign._id);

        // Update prospect status after successful visit
        prospect.status = 'visited';
        prospect.lastActivity = new Date();
        await campaign.save();

        return {
            success: true,
            data: {
                visitId: result.visitId || `visit_${Date.now()}`,
                method: result.method || 'unknown',
                visitType: result.visitType || 'profile_visit'
            },
            nextNodeId: exports.getNextNodeId(node, campaign, 'main'),
            delay: node.content.delay,
            delayUnit: node.content.delayUnit
        };

    } catch (error) {
        console.error('❌ [Campaign] LinkedIn visit failed:', error.message);
        return {
            success: false,
            error: error.message,
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }
};

// Process manual task
exports.processManualTask = async (node, prospect, campaign, execution) => {
    try {
        const Task = require('../models/Task');

        // Substitute variables in task content
        const taskTitle = exports.substituteVariables(
            node.content.taskTitle || node.content.title || `Manual task for {{name}}`,
            prospect
        );
        const taskDescription = exports.substituteVariables(
            node.content.taskDescription || node.content.message || node.content.description || '',
            prospect
        );

        // Calculate due date if specified
        let dueDate = null;
        if (node.content.dueDate) {
            const specifiedDate = new Date(node.content.dueDate);
            // If specified date is in the past, set to tomorrow
            if (specifiedDate < new Date()) {
                dueDate = new Date(Date.now() + (24 * 60 * 60 * 1000)); // Tomorrow
                console.log(`⚠️ Specified due date ${specifiedDate} is in the past, setting to tomorrow: ${dueDate}`);
            } else {
                dueDate = specifiedDate;
            }
        } else if (node.content.dueDays) {
            dueDate = new Date(Date.now() + (node.content.dueDays * 24 * 60 * 60 * 1000));
        }

        // Create actual task record in database with execution linking
        const task = await Task.create({
            title: taskTitle,
            description: taskDescription,
            priority: node.content.priority || 'medium',
            dueDate: dueDate,
            campaign: campaign.name,
            campaignId: campaign._id, // ✅ Add campaignId for direct reference
            type: 'manual',
            userId: campaign.userId,
            createdBy: campaign.userId,
            executionId: execution._id,
            prospectId: prospect._id.toString()
        });

        console.log(`✅ Manual task created in database: "${task.title}" for ${prospect.name} (Task ID: ${task._id})`);
        console.log(`📋 Task details: Priority: ${task.priority}, Due: ${task.dueDate || 'No due date'}`);
        console.log(`⏸️ Campaign execution PAUSED - waiting for task completion`);

        // Update campaign stats
        await Campaign.findByIdAndUpdate(campaign._id, {
            $inc: { 'stats.manualTasksCreated': 1 }
        });

        // Update prospect status to indicate manual action needed
        prospect.status = 'manual_action_required';
        prospect.lastActivity = new Date();
        await campaign.save();

        // CRITICAL: Return WITHOUT nextNodeId to pause execution
        // Campaign will resume via webhook when task is completed
        return {
            success: true,
            data: {
                taskId: task._id.toString(),
                title: task.title,
                description: task.description,
                priority: task.priority,
                dueDate: task.dueDate,
                prospect: prospect.name,
                campaign: campaign.name,
                executionPaused: true,
                message: 'Campaign paused - waiting for manual task completion'
            },
            nextNodeId: null, // No next node - execution pauses here
            delay: 0,
            delayUnit: 'minutes'
        };

    } catch (error) {
        console.error('❌ Failed to create manual task:', error);
        return {
            success: false,
            error: `Failed to create manual task: ${error.message}`,
            nextNodeId: exports.getNextNodeId(node, campaign, 'no')
        };
    }
};

// Process condition checks
exports.processConditionCheck = async (node, prospect, campaign) => {
    let hasCondition = false;

    switch (node.stepType) {
        case 'has-email':
            hasCondition = !!prospect.email;
            break;
        case 'has-linkedin':
            hasCondition = !!prospect.linkedin;
            break;
        case 'has-phone':
            hasCondition = !!prospect.phone;
            break;
        case 'email-opened': {
            const EmailLog = require('../models/EmailLog');
            const opened = await EmailLog.findOne({ prospectId: prospect._id, campaignId: campaign._id, openCount: { $gt: 0 } });
            hasCondition = !!opened;
            break;
        }
        case 'email-reply': {
            try {
                console.log('🔍 EMAIL-REPLY CONDITION START');
                const EmailLog = require('../models/EmailLog');

                let replied = await EmailLog.findOne({
                    prospectId: prospect._id,
                    campaignId: campaign._id,
                    hasReply: true
                });

                console.log('📧 Cached reply found:', !!replied);

                // Only do real-time check if no cached reply
                if (!replied) {
                    try {
                        console.log('📧 No cached reply - checking Gmail real-time...');
                        await exports.checkForEmailReplies(campaign);
                        replied = await EmailLog.findOne({
                            prospectId: prospect._id,
                            campaignId: campaign._id,
                            hasReply: true
                        });
                        console.log('📧 After real-time check:', !!replied);
                    } catch (gmailError) {
                        console.log('📧 Gmail check failed, using cached result only');
                    }
                }

                const yesId = exports.getNextNodeId(node, campaign, 'yes');
                const noId = exports.getNextNodeId(node, campaign, 'no');
                const chosen = replied ? yesId : noId;

                console.log('📧 EMAIL-REPLY FINAL RESULT:', {
                    hasReply: !!replied,
                    yesId,
                    noId,
                    chosen
                });

                return { success: true, data: { conditionMet: !!replied }, nextNodeId: chosen };

            } catch (error) {
                console.error('💥 ERROR in email-reply condition:', error);
                const noId = exports.getNextNodeId(node, campaign, 'no');
                return { success: false, error: error.message, nextNodeId: noId };
            }
        }
        case 'linkedin-connection-check': {
            try {
                console.log('🔍 LINKEDIN-CONNECTION-CHECK CONDITION START');

                if (!prospect.linkedin) {
                    console.log('❌ No LinkedIn profile URL for prospect');
                    const noId = exports.getNextNodeId(node, campaign, 'no');
                    return { success: true, data: { conditionMet: false, reason: 'No LinkedIn profile' }, nextNodeId: noId };
                }

                console.log('🔗 Checking LinkedIn connection status for:', prospect.linkedin);

                // Use extension-based connection check with live session cookies
                let connectionResult;
                let checkMethod = 'extension_live_session';

                try {
                    console.log('🎯 [Campaign] Using extension-based connection check...');
                    connectionResult = await exports.checkConnectionViaExtension(prospect.linkedin, campaign.userId, campaign._id, prospect._id, null); console.log('✅ [Campaign] Extension connection check successful:', connectionResult);
                } catch (extensionError) {
                    console.log('❌ [Campaign] Extension connection check failed:', extensionError.message);
                    const noId = exports.getNextNodeId(node, campaign, 'no');
                    return {
                        success: false,
                        error: `Extension connection check failed: ${extensionError.message}. Please ensure the LinkedIn extension is active.`,
                        nextNodeId: noId
                    };
                }

                // Determine if connected based on connection status
                const isConnected = connectionResult.status === 'connected' ||
                    connectionResult.isConnected === true;

                const yesId = exports.getNextNodeId(node, campaign, 'yes');
                const noId = exports.getNextNodeId(node, campaign, 'no');
                const chosen = isConnected ? yesId : noId;

                console.log('🔗 LINKEDIN-CONNECTION-CHECK FINAL RESULT:', {
                    isConnected,
                    connectionStatus: connectionResult.status,
                    checkMethod,
                    yesId,
                    noId,
                    chosen
                });

                return {
                    success: true,
                    data: {
                        conditionMet: isConnected,
                        connectionStatus: connectionResult.status,
                        checkMethod: checkMethod,
                        profileUrl: prospect.linkedin
                    },
                    nextNodeId: chosen
                };

            } catch (error) {
                console.error('💥 ERROR in linkedin-connection-check condition:', error);
                const noId = exports.getNextNodeId(node, campaign, 'no');
                return { success: false, error: error.message, nextNodeId: noId };
            }
        }
        case 'linkedin-accepted': {
            try {
                // Check if LinkedIn invitation was accepted
                const LinkedInSession = require('../models/LinkedInSession');
                const session = await LinkedInSession.findValidSession(campaign.userId);

                if (!session) {
                    hasCondition = false;
                    break;
                }

                // Check if prospect is in completedInvitations with success=true
                const acceptedInvitation = session.completedInvitations?.find(
                    inv => inv.profileUrl === prospect.linkedin && inv.success === true
                );
                hasCondition = !!acceptedInvitation;
                break;
            } catch (error) {
                console.error('Error checking LinkedIn acceptance:', error);
                hasCondition = false;
                break;
            }
        }
        case 'linkedin-opened': {
            // Check if LinkedIn message was opened (if tracking is available)
            // This would require LinkedIn message tracking implementation
            hasCondition = false; // Placeholder - implement based on your LinkedIn tracking
            break;
        }
        case 'linkedin-reply-check': {
            try {
                console.log('🔍 LINKEDIN-REPLY-CHECK CONDITION START');

                if (!prospect.linkedin) {
                    console.log('❌ No LinkedIn profile URL for prospect');
                    const noId = exports.getNextNodeId(node, campaign, 'no');
                    return { success: true, data: { conditionMet: false, reason: 'No LinkedIn profile' }, nextNodeId: noId };
                }

                console.log('💬 Checking LinkedIn reply status for:', prospect.linkedin);

                // First, lookup the conversation URN from previous message instruction
                console.log('🔍 [Campaign] Looking up conversation URN from previous message...');
                const LinkedInInstruction = require('../models/LinkedInInstruction');

                const previousMessageInstruction = await LinkedInInstruction.findOne({
                    campaignId: campaign._id,
                    prospectId: prospect._id,
                    action: 'send_message',
                    status: 'completed',
                    'result.conversationUrn': { $exists: true, $ne: null }
                }).sort({ completedAt: -1 }); // Get the most recent message

                let conversationUrn = null;
                if (previousMessageInstruction && previousMessageInstruction.result?.conversationUrn) {
                    conversationUrn = previousMessageInstruction.result.conversationUrn;
                    console.log('✅ [Campaign] Found conversation URN:', conversationUrn);
                } else {
                    console.log('⚠️ [Campaign] No conversation URN found. Message must be sent first.');
                    const noId = exports.getNextNodeId(node, campaign, 'no');
                    return {
                        success: false,
                        error: 'No conversation found. A LinkedIn message must be sent to this prospect first before checking replies.',
                        nextNodeId: noId
                    };
                }

                // Use extension-based reply check
                let replyResult;
                let checkMethod = 'extension_live_session';

                try {
                    console.log('🎯 [Campaign] Using extension-based reply check...');
                    replyResult = await exports.checkLinkedInRepliesViaExtension(prospect.linkedin, campaign.userId, conversationUrn, campaign._id, prospect._id, null);
                    console.log('✅ [Campaign] Extension reply check successful:', replyResult);
                } catch (extensionError) {
                    console.log('❌ [Campaign] Extension reply check failed:', extensionError.message);
                    const noId = exports.getNextNodeId(node, campaign, 'no');
                    return {
                        success: false,
                        error: `Extension reply check failed: ${extensionError.message}. Please ensure the LinkedIn extension is active.`,
                        nextNodeId: noId
                    };
                }

                // Determine if there are replies
                const hasReplies = replyResult.hasReplies === true || replyResult.replyCount > 0;

                const yesId = exports.getNextNodeId(node, campaign, 'yes');
                const noId = exports.getNextNodeId(node, campaign, 'no');
                const chosen = hasReplies ? yesId : noId;

                console.log('💬 LINKEDIN-REPLY-CHECK FINAL RESULT:', {
                    hasReplies: hasReplies,
                    replyCount: replyResult.replyCount || 0,
                    checkMethod: checkMethod,
                    yesId: yesId,
                    noId: noId,
                    chosen: chosen
                });

                return {
                    success: true,
                    data: {
                        conditionMet: hasReplies,
                        replyCount: replyResult.replyCount || 0,
                        checkMethod: checkMethod,
                        profileUrl: prospect.linkedin
                    },
                    nextNodeId: chosen
                };

            } catch (error) {
                console.error('💥 ERROR in linkedin-reply-check condition:', error);
                const noId = exports.getNextNodeId(node, campaign, 'no');
                return { success: false, error: error.message, nextNodeId: noId };
            }
        }
        case 'email-clicked': {
            try {
                const EmailLog = require('../models/EmailLog');
                const clicked = await EmailLog.findOne({
                    prospectId: prospect._id,
                    campaignId: campaign._id,
                    clickCount: { $gt: 0 }
                });
                hasCondition = !!clicked;
                break;
            } catch (error) {
                console.error('Error checking email clicks:', error);
                hasCondition = false;
                break;
            }
        }
        case 'email-unsubscribed': {
            try {
                const EmailLog = require('../models/EmailLog');
                const unsubscribed = await EmailLog.findOne({
                    prospectId: prospect._id,
                    campaignId: campaign._id,
                    unsubscribed: true
                });
                hasCondition = !!unsubscribed;
                break;
            } catch (error) {
                console.error('Error checking email unsubscribe:', error);
                hasCondition = false;
                break;
            }
        }
        case 'custom-condition': {
            // Implement custom condition logic based on node.content
            // This would allow users to define custom conditions
            hasCondition = false; // Placeholder - implement based on requirements
            break;
        }
    }

    return {
        success: true,
        data: { conditionMet: hasCondition },
        nextNodeId: exports.getNextNodeId(node, campaign, hasCondition ? 'yes' : 'no')
    };
};

// Check for email replies in Gmail threads
exports.checkForEmailReplies = async (campaign) => {
    try {
        console.log('🔍 Checking for email replies in campaign:', campaign._id);

        // Get the email account for this campaign
        let emailAccount;

        if (campaign.emailAccountId) {
            emailAccount = await ConnectedAccount.findOne({
                _id: campaign.emailAccountId,
                userId: campaign.userId,
                type: 'email',
                isActive: true
            });
        } else {
            emailAccount = await ConnectedAccount.findOne({
                userId: campaign.userId,
                type: 'email',
                isDefault: true,
                isActive: true
            });
        }

        if (!emailAccount) {
            console.log('❌ No email account found for reply checking');
            return;
        }

        // Refresh token if needed
        // try {
        //     await exports.refreshGmailToken(emailAccount);
        // } catch (refreshError) {
        //     console.error('❌ Failed to refresh Gmail token for reply checking:', refreshError.message);
        //     return; // Skip this campaign if token refresh fails
        // }

        // Create Gmail API client with refreshed token
        const gmail = createGmailTransporter(emailAccount.accessToken);

        // Get all EmailLogs for this campaign that don't have replies yet
        const emailLogs = await EmailLog.find({
            campaignId: campaign._id,
            hasReply: false
        });

        console.log(`📧 Checking ${emailLogs.length} email threads for replies`);

        for (const emailLog of emailLogs) {
            try {
                // Get the Gmail thread to check for new messages
                const thread = await gmail.users.threads.get({
                    userId: 'me',
                    id: emailLog.gmailThreadId
                });

                // Check if thread has more than 1 message (original + reply)
                const messageCount = thread.data.messages?.length || 0;
                if (messageCount > 1) {
                    console.log(`📧 Found ${messageCount} messages in thread ${emailLog.gmailThreadId}`);

                    // Get the latest message (potential reply)
                    const latestMessage = thread.data.messages[messageCount - 1];

                    // Check if it's from the prospect (not from us)
                    const fromHeader = latestMessage.payload.headers.find(h => h.name === 'From');
                    const prospect = await Campaign.findById(campaign._id)
                        .then(c => c.prospects.id(emailLog.prospectId));

                    if (fromHeader && prospect && fromHeader.value.includes(prospect.email)) {
                        console.log('✅ Reply detected from:', fromHeader.value);

                        // Update EmailLog with reply information
                        await EmailLog.findByIdAndUpdate(emailLog._id, {
                            $inc: { replyCount: 1 },
                            $set: {
                                hasReply: true,
                                lastReplyAt: new Date()
                            },
                            $addToSet: {
                                replyMessageIds: latestMessage.id
                            }
                        });

                        // Update campaign stats
                        await Campaign.findByIdAndUpdate(campaign._id, {
                            $inc: { 'stats.replyRate': 1 }
                        });

                        console.log('📧 Reply recorded for prospect:', prospect.email);
                    }
                }
            } catch (error) {
                console.error(`❌ Error checking thread ${emailLog.gmailThreadId}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Error in checkForEmailReplies:', error.message);
    }
};

// Helper function to get next node ID
exports.getNextNodeId = (currentNode, campaign, branch = 'main') => {
    if (!campaign || !campaign.sequence) return null;
    console.log('🔍 Looking for next node:', {
        currentNodeId: currentNode.id,
        branch: branch,
        campaignSequence: campaign.sequence.map(n => ({
            id: n.id,
            stepType: n.stepType,
            parentId: n.parentId,
            parentBranch: n.parentBranch
        }))
    });

    const nextNode = campaign.sequence.find(node =>
        node.parentId === currentNode.id && node.parentBranch === branch
    );
    console.log('🎯 Found next node:', nextNode?.id || 'NONE');

    return nextNode?.id || null;
};

// Helper function to substitute variables in text
exports.substituteVariables = (text, prospect) => {
    if (!text) return '';

    return text
        .replace(/\{\{name\}\}/g, prospect.name || '')
        .replace(/\{\{email\}\}/g, prospect.email || '')
        .replace(/\{\{company\}\}/g, prospect.company || '')
        .replace(/\{\{position\}\}/g, prospect.position || '')
        .replace(/\{\{first_name\}\}/g, prospect.name?.split(' ')[0] || '');
};


// Helper function to calculate delay in milliseconds
exports.calculateDelay = (delay, unit) => {
    let multiplier;
    switch (unit) {
        case 'minutes':
            multiplier = 60 * 1000; // 60 seconds * 1000 ms
            break;
        case 'hours':
            multiplier = 60 * 60 * 1000; // 60 minutes * 60 seconds * 1000 ms
            break;
        case 'days':
        default:
            multiplier = 24 * 60 * 60 * 1000; // 24 hours * 60 minutes * 60 seconds * 1000 ms
            break;
    }
    return (delay || 1) * multiplier;
};

// Complete execution
exports.completeExecution = async (execution, status, reason = null) => {
    execution.status = status;
    if (reason) {
        execution.executionHistory.push({
            nodeId: execution.currentNodeId,
            executedAt: new Date(),
            status: 'completed',
            result: { reason }
        });
    }
    await execution.save();

    // Check if all executions for this campaign are completed
    await checkAndCompleteCampaign(execution.campaignId);
};

// Check if campaign should be marked as completed
async function checkAndCompleteCampaign(campaignId) {
    try {
        const campaign = await Campaign.findById(campaignId);

        // Guard clauses
        if (!campaign) {
            console.log(`⚠️ [Campaign Completion] Campaign ${campaignId} not found`);
            return;
        }

        if (campaign.status === 'completed') {
            return; // Already completed
        }

        // Don't auto-complete if campaign is manually paused
        if (campaign.status === 'paused' && campaign.pauseReason === 'manual') {
            console.log(`⏸️ [Campaign Completion] Campaign ${campaignId} is manually paused, skipping completion check`);
            return;
        }

        // Count total executions
        const totalExecutions = await CampaignExecution.countDocuments({ campaignId });

        if (totalExecutions === 0) {
            console.log(`⚠️ [Campaign Completion] Campaign ${campaignId} has no executions`);
            return;
        }

        // Count finished executions (completed or failed)
        const finishedExecutions = await CampaignExecution.countDocuments({
            campaignId,
            status: { $in: ['completed', 'failed'] }
        });

        // Count active executions (running, waiting, paused, or paused for manual tasks)
        const activeExecutions = await CampaignExecution.countDocuments({
            campaignId,
            status: { $in: ['running', 'waiting', 'paused', 'paused_for_manual_task'] }
        });

        console.log(`📊 [Campaign Completion Check] Campaign ${campaignId}: ${finishedExecutions} finished, ${activeExecutions} active, ${totalExecutions} total`);

        // Only complete if ALL executions are finished (none active)
        if (activeExecutions === 0 && finishedExecutions === totalExecutions) {
            campaign.status = 'completed';
            campaign.completedAt = new Date();
            await campaign.save();

            console.log(`✅ [Campaign Completed] Campaign ${campaignId} marked as completed - all ${totalExecutions} executions finished`);
        } else {
            console.log(`⏳ [Campaign Completion] Campaign ${campaignId} not ready to complete: ${activeExecutions} executions still active`);
        }

    } catch (error) {
        console.error('❌ Error checking campaign completion:', error);
    }
}

// Resume execution after manual task completion
exports.resumeExecutionAfterTask = async (executionId, taskId) => {
    try {
        console.log(`🔍 RESUME DEBUG: Starting resumeExecutionAfterTask`, {
            executionId,
            taskId
        });

        const execution = await CampaignExecution.findById(executionId);
        const Task = require('../models/Task');

        console.log(`🔍 RESUME DEBUG: Execution found:`, {
            found: !!execution,
            status: execution?.status,
            currentNodeId: execution?.currentNodeId
        });

        if (!execution) {
            throw new Error(`Execution ${executionId} not found`);
        }

        // Verify task is completed and belongs to this execution
        const task = await Task.findOne({
            _id: taskId,
            executionId: executionId,
            status: 'completed'
        });

        console.log(`🔍 RESUME DEBUG: Task verification:`, {
            taskFound: !!task,
            taskStatus: task?.status,
            taskExecutionId: task?.executionId,
            matchesExecution: task?.executionId?.toString() === executionId
        });

        if (!task) {
            throw new Error(`Task ${taskId} not found or not completed`);
        }

        console.log(`🎯 Resuming execution ${executionId} after task ${taskId} completion`);

        // Find the campaign and current node
        const campaign = await Campaign.findById(execution.campaignId);
        const currentNode = campaign.sequence.find(node => node.id === execution.currentNodeId);
        const prospect = campaign.prospects.id(execution.prospectId);

        if (!currentNode || !prospect) {
            throw new Error('Current node or prospect not found in campaign sequence');
        }

        // Update prospect status from manual_action_required to contacted (task completed)
        if (prospect.status === 'manual_action_required') {
            prospect.status = 'contacted';
            prospect.lastContacted = new Date();
            console.log(`✅ Updated prospect ${prospect.name} status from 'manual_action_required' to 'contacted' (task completed)`);
            await campaign.save();
        }

        // Get the next node after the manual task
        const nextNodeId = exports.getNextNodeId(currentNode, campaign, 'main');

        if (nextNodeId) {
            execution.currentNodeId = nextNodeId;
            execution.status = 'running';
            execution.lastActivity = new Date();

            // Add to execution history
            execution.executionHistory.push({
                nodeId: currentNode.id,
                executedAt: new Date(),
                status: 'completed',
                result: {
                    taskCompleted: true,
                    taskId: taskId,
                    resumedViaWebhook: true
                },
                nextNodeId: nextNodeId
            });

            await execution.save();

            console.log(`✅ Execution resumed - processing next node: ${nextNodeId}`);
            setImmediate(() => exports.processProspectNode(execution));
        } else {
            // No next node - complete the execution
            console.log('🏁 No next node after manual task - completing execution');

            // Add execution history for the completed manual task
            execution.executionHistory.push({
                nodeId: currentNode.id,
                executedAt: new Date(),
                status: 'completed',
                result: {
                    taskCompleted: true,
                    taskId: taskId,
                    resumedViaWebhook: true,
                    finalStep: true
                }
            });

            await execution.save();
            await exports.completeExecution(execution, 'completed', 'Manual task completed - no further steps');
        }

    } catch (error) {
        console.error('❌ Error resuming execution after task:', error);
        throw error;
    }
};

// Process scheduled actions
exports.processScheduledActions = async () => {
    const now = new Date();
    console.log('🔄 [Campaign] Looking for scheduled actions at:', now.toISOString());

    const executions = await CampaignExecution.find({
        scheduledActions: {
            $elemMatch: {
                scheduledFor: { $lte: now },
                processed: false
            }
        },
        status: { $in: ['waiting', 'running'] }
    });

    console.log(`🔄 [Campaign] Found ${executions.length} executions with scheduled actions`);

    for (const execution of executions) {
        const actionsToProcess = execution.scheduledActions.filter(
            action => action.scheduledFor <= now && !action.processed
        );

        console.log(`🔄 [Campaign] Execution ${execution._id}:`);
        console.log(`  - Total scheduled actions: ${execution.scheduledActions.length}`);
        console.log(`  - Actions ready to process: ${actionsToProcess.length}`);

        // Log all scheduled actions for this execution
        execution.scheduledActions.forEach((action, index) => {
            console.log(`  - Action ${index}: ${action.actionType}, scheduled: ${action.scheduledFor.toISOString()}, processed: ${action.processed}, ready: ${action.scheduledFor <= now}`);
        });

        for (const action of actionsToProcess) {
            console.log('🚀 [Campaign] Processing action:', {
                actionType: action.actionType,
                nodeId: action.nodeId,
                scheduledFor: action.scheduledFor.toISOString(),
                now: now.toISOString(),
                timeDiff: now.getTime() - action.scheduledFor.getTime()
            });

            if (action.actionType === 'process_node') {
                execution.currentNodeId = action.nodeId;
                execution.status = 'running';
                action.processed = true;

                await execution.save();
                console.log('🚀 [Campaign] Triggering node processing for:', action.nodeId);
                setImmediate(() => exports.processProspectNode(execution));
            }
        }
    }
};

// Handle queue job completion and resume campaign execution
exports.handleQueueJobCompletion = async (jobId, success, result = {}) => {
    try {
        console.log('🎯 Handling queue job completion:', { jobId, success });

        // Find executions waiting for this job
        const executions = await CampaignExecution.find({
            waitingJobId: jobId,
            status: 'waiting'
        });

        console.log(`📋 Found ${executions.length} executions waiting for job ${jobId}`);

        for (const execution of executions) {
            console.log('🔄 Resuming execution after job completion:', execution._id);

            // Find the campaign and current node
            const campaign = await Campaign.findById(execution.campaignId);
            const currentNode = campaign.sequence.find(node => node.id === execution.currentNodeId);
            const prospect = campaign.prospects.id(execution.prospectId);

            if (!currentNode || !prospect) {
                console.error('❌ Current node or prospect not found for execution:', execution._id);
                continue;
            }

            // Update prospect status based on job completion for LinkedIn invitation steps
            if (currentNode.stepType === 'linkedin-invitation') {
                if (success) {
                    // Check if invitation was skipped due to existing connection
                    if (result.skipped && result.reason === 'Already connected') {
                        prospect.status = 'linkedin_connected';
                        console.log(`✅ Updated prospect ${prospect.name} status to 'linkedin_connected' (already connected)`);

                        // Update campaign stats
                        await Campaign.findByIdAndUpdate(campaign._id, {
                            $inc: { 'stats.linkedinInvitationsSkipped': 1 }
                        });
                    } else if (result.skipped && result.reason === 'Invitation already pending') {
                        prospect.status = 'linkedin_invitation_sent';
                        console.log(`✅ Updated prospect ${prospect.name} status to 'linkedin_invitation_sent' (already pending)`);

                        // Update campaign stats
                        await Campaign.findByIdAndUpdate(campaign._id, {
                            $inc: { 'stats.linkedinInvitationsSkipped': 1 }
                        });
                    } else {
                        // Successfully sent new invitation
                        prospect.status = 'linkedin_invitation_sent';
                        prospect.lastContacted = new Date();
                        console.log(`✅ Updated prospect ${prospect.name} status to 'linkedin_invitation_sent' (invitation sent)`);

                        // Update campaign stats
                        await Campaign.findByIdAndUpdate(campaign._id, {
                            $inc: {
                                'stats.linkedinInvitationsSent': 1,
                                'stats.linkedinInvitationsQueued': -1 // Decrement queued count
                            }
                        });
                    }
                } else {
                    // Invitation failed
                    prospect.status = 'linkedin_invitation_failed';
                    console.log(`❌ Updated prospect ${prospect.name} status to 'linkedin_invitation_failed'`);

                    // Update campaign stats - decrement queued count
                    await Campaign.findByIdAndUpdate(campaign._id, {
                        $inc: { 'stats.linkedinInvitationsQueued': -1 }
                    });
                }

                // Save prospect status changes
                await campaign.save();
            }

            // Similar handling for LinkedIn message steps
            if (currentNode.stepType === 'linkedin-message') {
                if (success) {
                    prospect.status = 'linkedin_message_sent';
                    prospect.lastContacted = new Date();
                    console.log(`✅ Updated prospect ${prospect.name} status to 'linkedin_message_sent'`);

                    // Update campaign stats
                    await Campaign.findByIdAndUpdate(campaign._id, {
                        $inc: { 'stats.linkedinMessagesSent': 1 }
                    });
                } else {
                    prospect.status = 'linkedin_message_failed';
                    console.log(`❌ Updated prospect ${prospect.name} status to 'linkedin_message_failed'`);
                }

                // Save prospect status changes
                await campaign.save();
            }

            // Record the job completion in execution history
            execution.executionHistory.push({
                nodeId: currentNode.id,
                executedAt: new Date(),
                status: success ? 'success' : 'failed',
                result: {
                    jobCompleted: true,
                    jobId: jobId,
                    jobResult: result,
                    completedViaQueue: true
                },
                nextNodeId: success ? exports.getNextNodeId(currentNode, campaign, 'main') : exports.getNextNodeId(currentNode, campaign, 'no')
            });

            // Determine next node based on job success and type
            let nextNodeId;
            if (success) {
                nextNodeId = exports.getNextNodeId(currentNode, campaign, 'main');
            } else {
                // Handle different failure types for LinkedIn steps
                const errorMessage = result.error || '';
                if (currentNode.stepType === 'linkedin-invitation' || currentNode.stepType === 'linkedin-message') {
                    // LinkedIn-specific error handling
                    if (errorMessage.includes('CANT_RESEND_YET') ||
                        errorMessage.includes('already connected') ||
                        errorMessage.includes('400') ||
                        result.reason === 'Already connected' ||
                        result.reason === 'Invitation already pending') {
                        // For connection-related errors, continue to main flow (connection check will handle it)
                        console.log('📋 LinkedIn job failed due to connection status - continuing to main branch');
                        nextNodeId = exports.getNextNodeId(currentNode, campaign, 'main');
                    } else {
                        // For other errors, try 'no' branch first, then fallback to 'main'
                        nextNodeId = exports.getNextNodeId(currentNode, campaign, 'no') ||
                            exports.getNextNodeId(currentNode, campaign, 'main');
                    }
                } else {
                    // For non-LinkedIn steps, use standard error routing
                    nextNodeId = exports.getNextNodeId(currentNode, campaign, 'no') ||
                        exports.getNextNodeId(currentNode, campaign, 'main');
                }

                console.log('📋 Job failed - routing decision:', {
                    stepType: currentNode.stepType,
                    error: result.error,
                    reason: result.reason,
                    nextNodeId: nextNodeId,
                    reasoning: (errorMessage.includes('CANT_RESEND_YET') || result.reason === 'Already connected')
                        ? 'Connection error - continue main flow'
                        : 'Other error - try no branch or main'
                });
            }

            if (nextNodeId) {
                // Move to next node
                execution.currentNodeId = nextNodeId;
                execution.status = 'running';
                execution.waitingFor = null;
                execution.waitingJobId = null;
                execution.lastActivity = new Date();

                await execution.save();

                console.log('✅ Resuming execution - processing next node:', nextNodeId);
                setImmediate(() => exports.processProspectNode(execution));
            } else {
                // No next node - complete execution
                console.log('🏁 Job completed - no next node, completing execution');
                execution.waitingFor = null;
                execution.waitingJobId = null;
                await execution.save();
                await exports.completeExecution(execution, 'completed', 'Queue job completed - no further steps');
            }
        }

    } catch (error) {
        console.error('❌ Error handling queue job completion:', error);
    }
};

// Check LinkedIn connection status via extension using instruction system (same as invitations/messages)
exports.checkConnectionViaExtension = async (profileUrl, userId, campaignId = null, prospectId = null, executionId = null) => {
    try {
        console.log('🎯 [Extension Check] Creating connection check instruction for:', profileUrl);

        // Use the same instruction system as invitations and messages
        const LinkedInInstruction = require('../models/LinkedInInstruction');
        const mongoose = require('mongoose');

        const instruction = new LinkedInInstruction({
            userId: userId,
            campaignId: campaignId || new mongoose.Types.ObjectId(), // Use dummy ID if not provided
            prospectId: prospectId || new mongoose.Types.ObjectId(), // Use dummy ID if not provided  
            executionId: executionId || new mongoose.Types.ObjectId(), // Use dummy ID if not provided
            action: 'check_connection',
            profileUrl: profileUrl,
            scheduledFor: new Date(), // Execute immediately
            status: 'pending'
        });

        await instruction.save();
        console.log('📝 [Extension Check] Connection check instruction created:', instruction._id);

        // Wait for instruction to be completed (same pattern as existing instructions)
        const maxWaitTime = 60000; // Increase to 60 seconds (was 30)
        const pollInterval = 500; // Check every 0.5 seconds (was 1 second)
        let waitedTime = 0;

        while (waitedTime < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            waitedTime += pollInterval;

            // Check if instruction is completed
            const updatedInstruction = await LinkedInInstruction.findById(instruction._id);

            if (updatedInstruction.status === 'completed') {
                console.log('✅ [Extension Check] Connection check completed:', updatedInstruction.result);

                // DEBUG: Add comprehensive logging
                console.log('🔍 [DEBUG] Full instruction result structure:', JSON.stringify(updatedInstruction.result, null, 2));
                console.log('🔍 [DEBUG] Result keys:', Object.keys(updatedInstruction.result || {}));
                console.log('🔍 [DEBUG] connectionStatus field:', updatedInstruction.result?.connectionStatus);
                console.log('🔍 [DEBUG] status field:', updatedInstruction.result?.status);
                console.log('🔍 [DEBUG] isConnected field:', updatedInstruction.result?.isConnected);
                console.log('🔍 [DEBUG] invitationAccepted field:', updatedInstruction.result?.invitationAccepted);
                console.log('🔍 [DEBUG] profileUsername field:', updatedInstruction.result?.profileUsername);

                const resultData = updatedInstruction.result || {};

                return {
                    success: resultData.success || false,
                    status: resultData.status || resultData.connectionStatus || 'unknown',  // ← Use connectionStatus field
                    isConnected: resultData.isConnected || false,
                    invitationAccepted: resultData.invitationAccepted || false,
                    invitationPending: resultData.invitationPending || false,
                    profileUsername: resultData.profileUsername || null,
                    method: 'extension_instruction',
                    instructionId: instruction._id
                };
            }

            if (updatedInstruction.status === 'failed') {
                throw new Error(updatedInstruction.error || 'Connection check failed');
            }
        }

        throw new Error('Connection check instruction timed out after 60 seconds. Please ensure the LinkedIn extension is active.');

    } catch (error) {
        console.error('❌ [Extension Check] Connection check failed:', error);
        throw error;
    }
};

// Check LinkedIn replies via extension using instruction system
exports.checkLinkedInRepliesViaExtension = async (profileUrl, userId, conversationUrn, campaignId = null, prospectId = null, executionId = null) => {
    console.log('🎯 [Extension Check] Creating reply check instruction for:', profileUrl);
    console.log('🔗 [Extension Check] Using conversation URN:', conversationUrn);

    const LinkedInInstruction = require('../models/LinkedInInstruction');
    const mongoose = require('mongoose');

    const instruction = new LinkedInInstruction({
        userId: userId,
        campaignId: campaignId || new mongoose.Types.ObjectId(),
        prospectId: prospectId || new mongoose.Types.ObjectId(),
        executionId: executionId || new mongoose.Types.ObjectId(),
        action: 'check_replies',
        profileUrl: profileUrl,
        conversationUrn: conversationUrn,  // ← Add this
        scheduledFor: new Date(), // Execute immediately
        status: 'pending'
    });

    await instruction.save();
    console.log('📝 [Extension Check] Reply check instruction created:', instruction._id);

    // Wait for instruction to be completed
    const maxWaitTime = 60000; // Increase to 60 seconds (was 30)
    const pollInterval = 500; // Check every 0.5 seconds (was 1 second)
    let waitedTime = 0;

    while (waitedTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waitedTime += pollInterval;

        const updatedInstruction = await LinkedInInstruction.findById(instruction._id);

        if (updatedInstruction.status === 'completed') {
            console.log('✅ [Extension Check] Reply check completed:', updatedInstruction.result);

            const resultData = updatedInstruction.result || {};

            return {
                success: resultData.success || false,
                hasReplies: resultData.hasReplies || false,
                replyCount: resultData.replyCount || 0,
                lastReplyDate: resultData.lastReplyDate || null,
                method: 'extension_instruction',
                instructionId: instruction._id
            };
        }

        if (updatedInstruction.status === 'failed') {
            throw new Error(updatedInstruction.error || 'Reply check failed');
        }
    }

    throw new Error('Reply check timed out - extension may not be active');
};
const axios = require('axios');
const openaiService = require('./openaiService');
const crypto = require('crypto');

// Rate limiting per account to avoid LinkedIn detection
const actionRateLimits = new Map(); // accountId -> { lastAction: timestamp, actionCount: number }

// Helper function to convert cookies array to cookie string
function formatCookieString(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

// Helper function to extract CSRF token from cookies
function extractCSRFToken(cookies) {
  const jsessionCookie = cookies.find(c => c.name === 'JSESSIONID');
  return jsessionCookie ? jsessionCookie.value.replace(/"/g, '') : null;
}

// Predefined tracking IDs for LinkedIn API
const predefinedTrackingIds = [
  "íh«J½Ù\u001cçÐp",
  "õj¬C¿Ú\u001bëÏn",
  "ëm©F¾Û\u001fæÐs",
  "òk­H¼Þ\u001eïËo",
  "çgªB¿Ù\u001dåÉq",
  "ôi«E¾Ü\u001cçÏr",
  "ÿh©G½Û\u001fêÐm",
  "îl¬C¾Ù\u001bèÎn",
  "çj­I¼Þ\u001dëÏo",
  "ôg«E¿Ú\u001cæÐq",
  "ïk¬F¾Ù\u001eéËp",
  "ñm©H½Û\u001bêÏr",
  "åj«C¿×\u001cäÎm",
  "úh­D¾Ù\u001fçÏn",
  "ëg¬E¿Ú\u001dèÐq",
  "òk¨F¾Û\u001bêÏo",
  "ýiªG¼Þ\u001cïËr",
  "çm­H¿Ù\u001eåÉp",
  "ôh©C¾Û\u001dçÏm",
  "ïj«F½Ü\u001bëÐq"
];

let trackingIdIndex = 0;

// Generate trackingId using predefined list
function generateTrackingId() {
  const trackingId = predefinedTrackingIds[trackingIdIndex];
  trackingIdIndex = (trackingIdIndex + 1) % predefinedTrackingIds.length;
  return trackingId;
}

// Helper function to extract CSRF token from cookies
function extractCSRFToken(cookies) {
  const jsessionCookie = cookies.find(c => c.name === 'JSESSIONID');
  return jsessionCookie ? jsessionCookie.value.replace(/"/g, '') : null;
}

// Basic data helpers kept for compatibility
exports.extractDataFromUrl = async (url) => {
  try {
    const profileData = { name: '', title: '', company: '', location: '' };
    const enhancedData = await openaiService.extractProfileDataFromUrl(url);
    return { ...profileData, ...enhancedData };
  } catch (error) {
    console.error('Error extracting data from LinkedIn URL:', error);
    throw error;
  }
};

exports.checkStatus = async () => {
  try {
    return true;
  } catch (error) {
    console.error('Error checking LinkedIn status:', error);
    return false;
  }
};

exports.visitProfile = async (account, profileUrl, campaignId) => {
  console.log('🔍 [Extension] Starting visitProfile function');
  console.log('🔍 [Extension] Account ID:', account._id || account.id);
  console.log('🔍 [Extension] Profile URL:', profileUrl);
  console.log('🎯 [Extension] Target Profile:', profileUrl.match(/\/in\/([^\/]+)/)?.[1] || 'Unknown');

  const startTime = Date.now();

  // Check rate limit before proceeding
  try {
    checkRateLimit(account._id || account.id);
    console.log('✅ [Extension] Rate limit check passed');
  } catch (rateLimitError) {
    console.error('❌ [Extension] Rate limit exceeded:', rateLimitError.message);
    throw rateLimitError;
  }

  // EXTENSION APPROACH: Queue profile visit for extension to handle in real browser
  console.log('🚀 [Extension] Using real browser tabs via extension');

  try {
    // Get LinkedIn session for the user
    const LinkedInSession = require('../models/LinkedInSession');
    const extensionSession = await LinkedInSession.findValidSession(account.userId);

    if (!extensionSession) {
      throw new Error('No valid LinkedIn session found. Please refresh your LinkedIn session in the extension first.');
    }

    console.log('✅ [Extension] Found LinkedIn session');

    // Add profile visit to pending queue
    const profileUsername = profileUrl.match(/\/in\/([^\/]+)/)?.[1] || 'Unknown';
    const visitRequest = {
      profileUrl: profileUrl,
      profileUsername: profileUsername,
      campaignId: campaignId,
      queuedAt: new Date(),
      visitId: `visit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'queued',
      method: 'background_tab'
    };

    // Add to pending visits array
    if (!extensionSession.pendingVisits) {
      extensionSession.pendingVisits = [];
    }

    // Check if visit is already queued
    const existingVisit = extensionSession.pendingVisits.find(visit => visit.profileUrl === profileUrl);
    if (existingVisit) {
      console.log('⚠️ [Extension] Visit already queued, updating timestamp');
      existingVisit.queuedAt = new Date();
      existingVisit.campaignId = campaignId;
    } else {
      extensionSession.pendingVisits.push(visitRequest);
      console.log('✅ [Extension] Profile visit queued for extension processing');
    }

    console.log('🔍 [Extension] Queue position:', extensionSession.pendingVisits.length);

    await extensionSession.save();

    // Return immediately - extension will process asynchronously
    return {
      success: true,
      method: 'extension_background_tab',
      status: 'queued',
      message: 'Profile visit queued for background tab processing by extension',
      profileUrl,
      queuedAt: new Date().toISOString(),
      visitType: 'background_tab_queued',
      visitId: visitRequest.visitId
    };

  } catch (error) {
    console.error('❌ [Extension] Error in extension-based profile visit:', error.message);
    throw new Error(`Profile visit failed: ${error.message}`);
  }
};

exports.sendInvitation = async (account, profileUrl, campaignId, options = {}) => {
  console.log('🤝 [Queue] Starting sendInvitation function');
  console.log('🤝 [Queue] Account ID:', account._id || account.id);
  console.log('🤝 [Queue] Profile URL:', profileUrl);
  console.log('🎯 [Queue] Target Profile:', profileUrl.match(/\/in\/([^\/]+)/)?.[1] || 'Unknown');

  const startTime = Date.now();

  try {
    // Use Redis queue for LinkedIn invitations
    const { addInvitationJob } = require('./linkedinInvitationQueue');

    const jobData = {
      userId: account.userId || account._id,
      profileUrl: profileUrl,
      message: options.message || '',
      campaignId: campaignId,
      prospectId: options.prospectId,
    };

    console.log('🤝 [Queue] Adding invitation to Redis queue');

    const queueResult = await addInvitationJob(jobData);

    console.log('✅ [Queue] Invitation queued successfully');
    console.log('📊 [Queue] Queue details:', {
      jobId: queueResult.jobId,
      delay: Math.round(queueResult.delay / 1000) + 's',
      scheduledAt: queueResult.scheduledAt
    });

    // Return queue result instead of immediate execution
    return {
      success: true,
      method: 'redis_queue',
      status: 'queued',
      message: `LinkedIn invitation queued successfully. Will be sent in ${Math.round(queueResult.delay / 1000)} seconds.`,
      profileUrl,
      queuedAt: new Date().toISOString(),
      invitationType: 'connection_request_queued',
      jobId: queueResult.jobId,
      delay: queueResult.delay,
      scheduledAt: queueResult.scheduledAt,
      rateLimits: queueResult.rateLimits
    };

  } catch (error) {
    console.error('❌ [Queue] Error in Redis queue invitation:', error.message);
    throw new Error(`Invitation queueing failed: ${error.message}`);
  }
};

exports.sendMessage = async (account, profileUrl, message, campaignId, options = {}) => {
  console.log('💬 [Extension] Starting sendMessage function');
  console.log('💬 [Extension] Account ID:', account._id || account.id);
  console.log('💬 [Extension] Profile URL:', profileUrl);
  console.log('💬 [Extension] Message length:', message?.length || 0);
  console.log('🎯 [Extension] Target Profile:', profileUrl.match(/\/in\/([^\/]+)/)?.[1] || 'Unknown');

  const startTime = Date.now();

  // Check rate limit before proceeding
  try {
    checkRateLimit(account._id || account.id);
    console.log('✅ [Extension] Rate limit check passed');
  } catch (rateLimitError) {
    console.error('❌ [Extension] Rate limit exceeded:', rateLimitError.message);
    throw rateLimitError;
  }

  try {
    const LinkedInSession = require('../models/LinkedInSession');

    // Find or create LinkedIn session for this user
    let extensionSession = await LinkedInSession.findOne({
      userId: account.userId || account._id
    });

    if (!extensionSession) {
      extensionSession = new LinkedInSession({
        userId: account.userId || account._id,
        sessionData: {},
        isAuthenticated: false,
        pendingMessages: [],
        completedMessages: []
      });
    }

    // Create message request
    const messageRequest = {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      profileUrl: profileUrl,
      message: message,
      campaignId: campaignId,
      prospectId: options.prospectId,
      requestedAt: new Date(),
      status: 'pending'
    };

    console.log('💬 [Extension] Created message request:', messageRequest.messageId);

    // Add to pending messages queue
    extensionSession.pendingMessages = extensionSession.pendingMessages || [];
    extensionSession.pendingMessages.push(messageRequest);

    // Save session with new message request
    await extensionSession.save();

    console.log('✅ [Extension] Message queued for extension processing');
    console.log('📊 [Extension] Queue status:', {
      pending: extensionSession.pendingMessages.length,
      completed: extensionSession.completedMessages?.length || 0
    });

    // Return immediately - extension will process asynchronously
    return {
      success: true,
      method: 'extension_background_tab',
      status: 'queued',
      message: 'LinkedIn message queued for background tab processing by extension',
      profileUrl,
      queuedAt: new Date().toISOString(),
      messageType: 'direct_message_queued',
      messageId: messageRequest.messageId
    };

  } catch (error) {
    console.error('❌ [Extension] Error in extension-based message sending:', error.message);
    throw new Error(`Message sending failed: ${error.message}`);
  }
};

async function getCurrentUserProfileUrn(session) {
  try {
    const cookieString = formatCookieString(session.cookies);
    const csrfToken = extractCSRFToken(session.cookies);

    if (!csrfToken) {
      throw new Error('No CSRF token found in session cookies');
    }

    if (!session.userLinkedInUrl) {
      throw new Error('User LinkedIn URL not found in session. Please save your LinkedIn profile URL first.');
    }

    // Check if we already have the user's profile URN
    if (session.userProfileUrn) {
      console.log('📋 User profile URN already exists:', session.userProfileUrn);
      return {
        success: true,
        userProfileUrn: session.userProfileUrn,
        cached: true
      };
    }

    // Fetch current user's profile URN
    const userProfileUrn = await getCurrentUserProfileUrn(session);

    // Store in session
    session.userProfileUrn = userProfileUrn;
    await session.save();

    console.log('✅ User profile URN stored successfully:', userProfileUrn);

    return {
      success: true,
      userProfileUrn: userProfileUrn,
      cached: false
    };

  } catch (error) {
    console.error('❌ Failed to fetch and store user profile URN:', error.message);
    throw error;
  }
};

// Get target profile URN from LinkedIn profile URL
async function getTargetProfileUrn(session, targetProfileUrl) {
  const cookieString = formatCookieString(session.cookies);
  const csrfToken = extractCSRFToken(session.cookies);

  if (!csrfToken) {
    throw new Error('No CSRF token found in session cookies');
  }

  // Extract profile username from LinkedIn URL
  const profileUsername = targetProfileUrl.match(/\/in\/([^\/\?]+)/)?.[1];
  if (!profileUsername) {
    throw new Error('Invalid LinkedIn profile URL format');
  }

  // METHOD 1: Try the original profileView API first
  try {
    console.log('🔍 [Primary] Fetching target profile URN via profileView API for:', profileUsername);

    const response = await axios.get(`https://www.linkedin.com/voyager/api/identity/profiles/${profileUsername}/profileView`, {
      headers: {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'user-agent': session.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'cookie': cookieString,
        'csrf-token': csrfToken,
        'x-restli-protocol-version': '2.0.0'
      },
      timeout: 10000
    });

    console.log('✅ [Primary] ProfileView API successful');

    // Extract profile URN from response - looking for "*profile" key
    const profileUrn = response.data?.data?.['*profile'];
    if (profileUrn) {
      // Extract just the ID part: urn:li:fs_profile:ACoAAEHgE3IBWIoq-Mc6ki-arHEg2E5DAT1EeEY -> ACoAAEHgE3IBWIoq-Mc6ki-arHEg2E5DAT1EeEY
      const profileId = profileUrn.split(':').pop();
      console.log('📋 [Primary] Extracted target profile URN:', profileId);

      return profileId;
    } else {
      throw new Error('No profile URN found in profileView API response');
    }

  } catch (primaryError) {
    console.warn('⚠️ [Primary] ProfileView API failed:', primaryError.response?.status, primaryError.message);

    // Check if it's a 410 error or other API blocking - try GraphQL fallback
    if (primaryError.response?.status === 410 ||
      primaryError.response?.status === 500 ||
      primaryError.message.includes('410') ||
      primaryError.message.includes('Gone') ||
      primaryError.message.includes('redirect')) {

      console.log('🔄 [Fallback] ProfileView blocked, trying GraphQL fallback...');

      // METHOD 2: Fallback to GraphQL API
      try {
        console.log('🔍 [Fallback] Fetching URN via GraphQL for:', profileUsername);

        const graphqlResponse = await axios.get(`https://www.linkedin.com/voyager/api/graphql?variables=(vanityName:${profileUsername})&queryId=voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a`, {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'user-agent': session.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'x-restli-protocol-version': '2.0.0',
            'x-li-lang': 'en_US',
            'origin': 'https://www.linkedin.com',
            'referer': targetProfileUrl,
            'cookie': cookieString,
            'csrf-token': csrfToken
          },
          timeout: 15000
        });

        console.log('✅ [Fallback] GraphQL API successful');

        // Extract profile URN from GraphQL response
        let profileUrn = null;

        // Method 1: Extract URN from elements array (primary method based on Postman response)
        if (graphqlResponse.data?.data?.data?.identityDashProfilesByMemberIdentity?.['*elements']) {
          const elements = graphqlResponse.data.data.data.identityDashProfilesByMemberIdentity['*elements'];
          if (elements.length > 0) {
            profileUrn = elements[0]; // First element should be the profile URN
            console.log('📋 [Fallback] Found URN in elements array:', profileUrn);
          }
        }

        // Method 2: Extract URN from included array (fallback method - verify publicIdentifier matches)
        if (!profileUrn && graphqlResponse.data?.included) {
          for (const item of graphqlResponse.data.included) {
            if (item.entityUrn &&
              item.entityUrn.includes('fsd_profile:') &&
              item.publicIdentifier === profileUsername) {
              profileUrn = item.entityUrn;
              console.log('📋 [Fallback] Found URN in included array:', profileUrn);
              console.log('👤 [Fallback] Profile:', `${item.firstName} ${item.lastName}`);
              break;
            }
          }
        }

        if (profileUrn) {
          // Extract just the ID part: urn:li:fsd_profile:ACoAAAFYgYwBPEoXhO8tKlwf4QnNb9ZWG8KtF7I -> ACoAAAFYgYwBPEoXhO8tKlwf4QnNb9ZWG8KtF7I
          const profileId = profileUrn.split(':').pop();
          console.log('📋 [Fallback] Extracted target profile URN via GraphQL:', profileId);

          return profileId;
        } else {
          console.error('❌ [Fallback] No profile URN found in GraphQL response');
          console.error('🔍 [Fallback] GraphQL Response structure:', JSON.stringify({
            hasData: !!graphqlResponse.data?.data,
            hasIdentityDash: !!graphqlResponse.data?.data?.data?.identityDashProfilesByMemberIdentity,
            hasElements: !!graphqlResponse.data?.data?.data?.identityDashProfilesByMemberIdentity?.['*elements'],
            elementsLength: graphqlResponse.data?.data?.data?.identityDashProfilesByMemberIdentity?.['*elements']?.length || 0,
            elements: graphqlResponse.data?.data?.data?.identityDashProfilesByMemberIdentity?.['*elements'] || [],
            hasIncluded: !!graphqlResponse.data?.included,
            includedLength: graphqlResponse.data?.included?.length || 0,
            includedProfiles: graphqlResponse.data?.included?.filter(item =>
              item.entityUrn && item.entityUrn.includes('fsd_profile:')
            ).map(item => ({
              entityUrn: item.entityUrn,
              publicIdentifier: item.publicIdentifier,
              firstName: item.firstName,
              lastName: item.lastName
            })) || []
          }, null, 2));

          throw new Error('No profile URN found in GraphQL response - profile may not be accessible via API');
        }

      } catch (fallbackError) {
        console.error('❌ [Fallback] GraphQL fallback also failed:', fallbackError.response?.status, fallbackError.message);

        if (fallbackError.response) {
          console.error('🔍 [Fallback] GraphQL Response status:', fallbackError.response.status);
          console.error('🔍 [Fallback] GraphQL Response headers:', JSON.stringify(fallbackError.response.headers, null, 2));

          // Only log response data if it's not too large
          const responseData = fallbackError.response.data;
          if (typeof responseData === 'object' && JSON.stringify(responseData).length < 1000) {
            console.error('🔍 [Fallback] GraphQL Response data:', JSON.stringify(responseData, null, 2));
          } else {
            console.error('🔍 [Fallback] GraphQL Response data (truncated):', JSON.stringify(responseData).substring(0, 500) + '...');
          }
        }

        // Both methods failed - throw comprehensive error
        throw new Error(`All URN fetching methods failed for ${profileUsername}. Primary: ${primaryError.message}, Fallback: ${fallbackError.message}`);
      }

    } else {
      // For non-410 errors (session issues, network problems), don't try fallback
      console.error('❌ [Primary] ProfileView API failed with non-recoverable error:', primaryError.message);

      if (primaryError.response) {
        console.error('Response status:', primaryError.response.status);
        console.error('Response data:', JSON.stringify(primaryError.response.data, null, 2));
      }

      throw new Error(`Failed to get target profile URN: ${primaryError.message}`);
    }
  }
}

// Send LinkedIn invitation using Voyager API
async function sendLinkedInInvitation(session, targetProfileUrn, targetProfileUrl, customMessage = '') {
  try {
    const cookieString = formatCookieString(session.cookies);
    const csrfToken = extractCSRFToken(session.cookies);

    if (!csrfToken) {
      throw new Error('No CSRF token found in session cookies');
    }

    console.log('🔍 Sending LinkedIn invitation to URN:', targetProfileUrn);
    console.log({ customMessage })

    // Use the correct LinkedIn invitation payload format
    const payload = {
      invitee: {
        inviteeUnion: {
          memberProfile: `urn:li:fsd_profile:${targetProfileUrn}`
        }
      }
    };

    // Add custom message if provided (optional)
    if (customMessage && customMessage.trim()) {
      payload.customMessage = customMessage.trim();
    }

    console.log('📤 Invitation payload:', JSON.stringify(payload, null, 2));

    console.log('💬 Message payload:', JSON.stringify(payload, null, 2));
    console.log('🔍 Request details:');
    console.log('- URL:', 'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2');
    console.log('- Method: POST');
    console.log('- Content-Type:', 'application/json');
    console.log('- CSRF Token:', csrfToken);
    console.log('- Cookie length:', cookieString.length);
    console.log('- Payload string:', JSON.stringify(payload));

    const response = await axios.post(
      'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2',
      JSON.stringify(payload) + '\n', // Add trailing newline to match working cURL
      {
        headers: {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
          'content-type': 'application/json',
          'user-agent': session.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
          'cookie': cookieString,
          'csrf-token': csrfToken,
          'origin': 'https://www.linkedin.com',
          'referer': targetProfileUrl,
          'x-li-lang': 'en_US',
          'x-restli-protocol-version': '2.0.0',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        },
        timeout: 15000
      }
    );

    console.log('✅ LinkedIn invitation sent successfully');
    console.log('Response status:', response.status);

    return {
      success: true,
      invitationId: response.data?.data?.entityUrn || `invitation_${Date.now()}`,
      targetProfileUrn: targetProfileUrn,
      message: customMessage || 'No message',
      sentAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ LinkedIn invitation API failed:', error.message);

    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }

    throw new Error(`Failed to send LinkedIn invitation: ${error.message}`);
  }
}

// Connection check rate limiting constants
const CONNECTION_CHECK_DELAY = {
  MIN: 15 * 1000,   // 15 seconds between connection checks
  MAX: 30 * 1000,   // 30 seconds between connection checks
};

// Add connection check rate limiting to prevent LinkedIn 410 errors
async function addConnectionCheckDelay(userId) {
  const Redis = require('ioredis');
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });

  const connectionDelayKey = `connection_check_delay:${userId}`;
  const lastConnectionCheck = await redis.get(connectionDelayKey);

  if (lastConnectionCheck) {
    const timeSinceLastCheck = Date.now() - parseInt(lastConnectionCheck);
    const minInterval = CONNECTION_CHECK_DELAY.MIN + Math.random() * (CONNECTION_CHECK_DELAY.MAX - CONNECTION_CHECK_DELAY.MIN);

    if (timeSinceLastCheck < minInterval) {
      const waitTime = minInterval - timeSinceLastCheck;
      console.log(`⏱️ [Connection Check Rate Limit] User ${userId} - Waiting ${Math.round(waitTime / 1000)}s before next connection check to avoid LinkedIn 410 errors`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  // Update last connection check time
  await redis.set(connectionDelayKey, Date.now(), 'EX', 3600); // Expire after 1 hour
  console.log(`✅ [Connection Check Rate Limit] User ${userId} - Connection check delay applied`);

  redis.disconnect();
}

// Send LinkedIn message using Voyager API
async function sendLinkedInMessage(session, targetProfileUrn, targetProfileUrl, messageText) {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const cookieString = formatCookieString(session.cookies);
      const csrfToken = extractCSRFToken(session.cookies);

      if (!csrfToken) {
        throw new Error('No CSRF token found in session cookies');
      }

      if (!session.userProfileUrn) {
        throw new Error('User profile URN not found in session. Please setup your profile first using /setup-user-profile');
      }

      console.log('💬 Sending LinkedIn message to URN:', targetProfileUrn);
      console.log('📝 Message text:', messageText);

      // Generate proper tokens - UUID for originToken, crypto for trackingId
      const { v4: uuidv4 } = require('uuid');
      const originToken = uuidv4();
      const trackingId = generateTrackingId();

      // Create message payload
      const payload = {
        message: {
          body: {
            attributes: [],
            text: messageText
          },
          originToken: originToken,
          renderContentUnions: []
        },
        mailboxUrn: `urn:li:fsd_profile:${session.userProfileUrn}`,
        trackingId: trackingId,
        dedupeByClientGeneratedToken: false,
        hostRecipientUrns: [`urn:li:fsd_profile:${targetProfileUrn}`]
      };

      console.log('📤 Message payload:', JSON.stringify(payload, null, 2));
      console.log('🔍 Request details:');
      console.log('- URL:', 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage');
      console.log('- Method: POST');
      console.log('- Content-Type:', 'text/plain;charset=UTF-8');
      console.log('- CSRF Token:', csrfToken);
      console.log('- Cookie length:', cookieString.length);
      console.log('- Payload string:', JSON.stringify(payload));

      const response = await axios.post(
        'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage',
        JSON.stringify(payload) + '\n', // Add trailing newline to match working cURL
        {
          headers: {
            'accept': 'application/json',
            'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'content-type': 'text/plain;charset=UTF-8',
            'user-agent': session.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
            'cookie': cookieString,
            'csrf-token': csrfToken,
            'origin': 'https://www.linkedin.com',
            'referer': targetProfileUrl,
            'x-li-lang': 'en_US',
            'x-restli-protocol-version': '2.0.0',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
          },
          timeout: 15000
        }
      );

      console.log('✅ LinkedIn message sent successfully');
      console.log('Response status:', response.status);

      return {
        success: true,
        messageId: response.data?.data?.entityUrn || `message_${Date.now()}`,
        targetProfileUrn: targetProfileUrn,
        messageText: messageText,
        originToken: originToken,
        sentAt: new Date().toISOString()
      };

    } catch (error) {
      console.error(`❌ LinkedIn message API failed (attempt ${attempt + 1}/${maxRetries}):`, error.message);

      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data, null, 2));

        // If 400 error and we have retries left, regenerate trackingId and try again
        if (error.response.status === 400 && attempt < maxRetries - 1) {
          console.log('🔄 Regenerating trackingId and retrying...');
          attempt++;
          continue;
        }
      }

      // If we've exhausted retries or it's not a 400 error, throw the error
      throw new Error(`Failed to send LinkedIn message: ${error.message}`);
    }
  }
}

// Fetch and store current user's profile URN
async function fetchAndStoreUserProfileUrn(userId) {
  try {
    console.log('🔍 Fetching user profile URN for userId:', userId);

    const LinkedInSession = require('../models/LinkedInSession');
    const session = await LinkedInSession.findValidSession(userId);

    if (!session) {
      throw new Error('No valid LinkedIn session found');
    }

    if (!session.userLinkedInUrl) {
      throw new Error('User LinkedIn URL not found in session');
    }

    // Extract username from LinkedIn URL
    const profileUsername = session.userLinkedInUrl.match(/\/in\/([^\/\?]+)/)?.[1];
    if (!profileUsername) {
      throw new Error('Invalid LinkedIn profile URL format');
    }

    console.log('🔍 Extracting URN for profile username:', profileUsername);

    const cookieString = formatCookieString(session.cookies);
    const csrfToken = extractCSRFToken(session.cookies);

    if (!csrfToken) {
      throw new Error('No CSRF token found in session cookies');
    }

    // Use the same GraphQL endpoint as connection check to get profile data
    const requestUrl = `https://www.linkedin.com/voyager/api/graphql?variables=(vanityName:${profileUsername})&queryId=voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a`;

    const response = await axios.get(requestUrl, {
      headers: {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'user-agent': session.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        'cookie': cookieString,
        'csrf-token': csrfToken,
        'x-restli-protocol-version': '2.0.0'
      },
      timeout: 10000
    });

    // Extract profile URN from response
    let userProfileUrn = null;

    if (response.data?.included) {
      for (const item of response.data.included) {
        if (item.entityUrn && item.entityUrn.includes('fsd_profile:')) {
          userProfileUrn = item.entityUrn;
          break;
        }
        // Also check for profile data in other formats
        if (item['*profile'] && typeof item['*profile'] === 'string') {
          userProfileUrn = item['*profile'];
          break;
        }
      }
    }

    if (!userProfileUrn) {
      throw new Error('Could not extract profile URN from LinkedIn response');
    }

    console.log('✅ Profile URN extracted:', userProfileUrn);

    // Extract only the profile ID from the full URN
    // Convert "urn:li:fsd_profile:ACoAAF6ceqABNpxd9ohfzEm1XLMsY1nRR8FW5Kw" to "ACoAAF6ceqABNpxd9ohfzEm1XLMsY1nRR8FW5Kw"
    const profileId = userProfileUrn.split(':').pop();

    console.log('✅ Profile ID extracted:', profileId);

    // Store only the profile ID in the session
    session.userProfileUrn = profileId;
    await session.save();

    console.log('✅ User profile ID stored successfully');

    return {
      success: true,
      userProfileUrn: profileId,
      profileUsername: profileUsername
    };

  } catch (error) {
    console.error('❌ Error fetching user profile URN:', error.message);
    throw error;
  }
}

// Export all functions
exports.getTargetProfileUrn = getTargetProfileUrn;
exports.sendLinkedInInvitation = sendLinkedInInvitation;
exports.sendLinkedInMessage = sendLinkedInMessage;
exports.fetchAndStoreUserProfileUrn = fetchAndStoreUserProfileUrn;
exports.formatCookieString = formatCookieString;
exports.extractCSRFToken = extractCSRFToken;
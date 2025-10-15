const Bull = require('bull');
const Redis = require('ioredis');

// Mutex to prevent race conditions when adding jobs
const jobCreationMutex = new Map();

const { sendLinkedInInvitation, getTargetProfileUrn } = require('./linkedinService');

// Create Redis client for rate limiting with TLS support for Upstash
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
    tls: {
      rejectUnauthorized: false  // Required for Upstash
    },
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  })
  : new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });

// Handle connection events
redis.on('error', (err) => {
  console.error('❌ [Invitation Queue] Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('✅ [Invitation Queue] Redis connected successfully');
});

// Create LinkedIn invitation queue with TLS support
const redisConfig = process.env.REDIS_URL
  ? process.env.REDIS_URL
  : {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
  };

const linkedinInvitationQueue = new Bull('linkedin invitations', {
  redis: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 50,      // Keep last 50 failed jobs
    attempts: 3,           // Retry failed jobs 3 times
    backoff: {
      type: 'exponential',
      delay: 60000,        // Start with 1 minute delay
    },
  },
});

// Rate limiting constants
const RATE_LIMITS = {
  HOURLY: 25,    // Max 25 invitations per hour
  DAILY: 100,    // Max 100 invitations per day  
  WEEKLY: 500,   // Max 500 invitations per week
};

// Working hours (9 AM to 6 PM)
const WORKING_HOURS = {
  START: 9,  // 9 AM
  END: 18,   // 6 PM
};

// Delay between invitations (2-3 minutes)
const INVITATION_DELAY = {
  MIN: 2 * 60 * 1000,  // 2 minutes in milliseconds
  MAX: 3 * 60 * 1000,  // 3 minutes in milliseconds
};

// URN fetching rate limiting (separate from invitations)
const URN_FETCH_DELAY = {
  MIN: 60 * 1000,   // 1 minute between URN fetches
  MAX: 120 * 1000,  // 2 minutes between URN fetches
};

// Generate random delay between min and max
function getRandomDelay() {
  return Math.floor(Math.random() * (INVITATION_DELAY.MAX - INVITATION_DELAY.MIN + 1)) + INVITATION_DELAY.MIN;
}

// Check if current time is within working hours (timezone-aware)
function isWorkingHours(userSettings = null) {
  // Use user's timezone settings or fallback to UTC
  const timezone = userSettings?.workingHours?.timezone || 'UTC';
  const enabled = userSettings?.workingHours?.enabled !== false;
  const start = userSettings?.workingHours?.start || WORKING_HOURS.START;
  const end = userSettings?.workingHours?.end || WORKING_HOURS.END;
  const weekendsEnabled = userSettings?.workingHours?.weekendsEnabled || false;

  // If working hours are disabled, always return true
  if (!enabled) {
    return true;
  }

  try {
    // Robust timezone conversion using Intl.DateTimeFormat
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find(part => part.type === 'hour').value);

    // Get day of week using proper timezone - FIXED VERSION
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long'
    });
    const dayName = dayFormatter.format(now);
    const dayMap = {
      'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
      'Thursday': 4, 'Friday': 5, 'Saturday': 6
    };
    const day = dayMap[dayName];

    console.log(`🕐 [Working Hours] ${timezone}: ${hour}:XX (${dayName}), Hours: ${start}-${end}`);

    // Skip weekends if not enabled
    if (!weekendsEnabled && (day === 0 || day === 6)) {
      console.log(`⏸️ [Working Hours] Weekend detected (${dayName}), skipping`);
      return false;
    }

    // Check if within working hours
    const isWithin = hour >= start && hour < end;
    console.log(`${isWithin ? '✅' : '❌'} [Working Hours] ${isWithin ? 'Within' : 'Outside'} working hours`);
    return isWithin;

  } catch (error) {
    console.error('Error checking working hours with timezone:', error);
    // Fallback to UTC if timezone parsing fails
    const now = new Date();
    const hour = now.getUTCHours();
    const day = now.getUTCDay();

    if (!weekendsEnabled && (day === 0 || day === 6)) {
      return false;
    }

    return hour >= start && hour < end;
  }
}

// Get next working hour if outside working hours (timezone-aware)
function getNextWorkingHour(userSettings = null) {
  const timezone = userSettings?.workingHours?.timezone || 'UTC';
  const enabled = userSettings?.workingHours?.enabled !== false;
  const start = userSettings?.workingHours?.start || WORKING_HOURS.START;
  const end = userSettings?.workingHours?.end || WORKING_HOURS.END;
  const weekendsEnabled = userSettings?.workingHours?.weekendsEnabled || false;

  // If working hours are disabled, return current time
  if (!enabled) {
    return new Date();
  }

  try {
    const now = new Date();

    // Get current time in user's timezone using robust conversion
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(now);
    const year = parseInt(parts.find(p => p.type === 'year').value);
    const month = parseInt(parts.find(p => p.type === 'month').value) - 1;
    const day = parseInt(parts.find(p => p.type === 'day').value);
    const hour = parseInt(parts.find(p => p.type === 'hour').value);
    const minute = parseInt(parts.find(p => p.type === 'minute').value);
    const second = parseInt(parts.find(p => p.type === 'second').value);

    // Create target working hour in user's timezone
    let targetYear = year;
    let targetMonth = month;
    let targetDay = day;
    let targetHour = start;

    // If current hour >= end hour, move to next day
    if (hour >= end) {
      const nextDayDate = new Date(year, month, day + 1);
      targetYear = nextDayDate.getFullYear();
      targetMonth = nextDayDate.getMonth();
      targetDay = nextDayDate.getDate();

      // Skip weekends if not enabled
      if (!weekendsEnabled) {
        const testDate = new Date(targetYear, targetMonth, targetDay);
        while (testDate.getDay() === 0 || testDate.getDay() === 6) {
          testDate.setDate(testDate.getDate() + 1);
          targetYear = testDate.getFullYear();
          targetMonth = testDate.getMonth();
          targetDay = testDate.getDate();
        }
      }
    } else {
      // Check if today is a weekend and weekends are not enabled
      const todayDate = new Date(year, month, day);
      if (!weekendsEnabled && (todayDate.getDay() === 0 || todayDate.getDay() === 6)) {
        // Move to next Monday
        const daysUntilMonday = todayDate.getDay() === 0 ? 1 : (8 - todayDate.getDay());
        const nextWorkingDate = new Date(year, month, day + daysUntilMonday);
        targetYear = nextWorkingDate.getFullYear();
        targetMonth = nextWorkingDate.getMonth();
        targetDay = nextWorkingDate.getDate();
      }
    }

    // Create the target datetime string in ISO format for the user's timezone
    const targetDateStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}T${String(targetHour).padStart(2, '0')}:00:00`;

    // Convert to UTC using the inverse of Intl.DateTimeFormat
    // Create a temporary date in the target timezone and find the UTC equivalent
    const tempDate = new Date(`${targetDateStr}.000Z`); // Assume UTC first
    const tempFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Calculate the offset between what we want and what we get
    const tempParts = tempFormatter.formatToParts(tempDate);
    const tempHour = parseInt(tempParts.find(p => p.type === 'hour').value);
    const tempDay = parseInt(tempParts.find(p => p.type === 'day').value);

    // Adjust for timezone offset
    const hourOffset = targetHour - tempHour;
    const dayOffset = targetDay - tempDay;

    const finalDate = new Date(tempDate);
    finalDate.setUTCHours(finalDate.getUTCHours() + hourOffset);
    finalDate.setUTCDate(finalDate.getUTCDate() + dayOffset);

    console.log(`📅 [Next Working] Calculated for ${timezone}: ${finalDate.toISOString()} (${targetHour}:00 local time)`);
    return finalDate;

  } catch (error) {
    console.error('Error calculating next working hour with timezone:', error);

    // Fallback: use current UTC time + offset to start hour
    const now = new Date();
    const currentHour = now.getUTCHours();

    if (currentHour >= end) {
      // Move to next day at start hour
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(start, 0, 0, 0);
      return tomorrow;
    } else if (currentHour < start) {
      // Move to start hour today
      const today = new Date(now);
      today.setUTCHours(start, 0, 0, 0);
      return today;
    } else {
      // Currently within hours, return current time
      return now;
    }
  }
}

// Check rate limits for a user
async function checkRateLimits(userId) {
  const now = Date.now();
  const hourKey = `rate_limit:${userId}:hour:${Math.floor(now / (60 * 60 * 1000))}`;
  const dayKey = `rate_limit:${userId}:day:${Math.floor(now / (24 * 60 * 60 * 1000))}`;
  const weekKey = `rate_limit:${userId}:week:${Math.floor(now / (7 * 24 * 60 * 60 * 1000))}`;

  const [hourCount, dayCount, weekCount] = await Promise.all([
    redis.get(hourKey),
    redis.get(dayKey),
    redis.get(weekKey),
  ]);

  const limits = {
    hourly: {
      current: parseInt(hourCount) || 0,
      limit: RATE_LIMITS.HOURLY,
      exceeded: (parseInt(hourCount) || 0) >= RATE_LIMITS.HOURLY,
    },
    daily: {
      current: parseInt(dayCount) || 0,
      limit: RATE_LIMITS.DAILY,
      exceeded: (parseInt(dayCount) || 0) >= RATE_LIMITS.DAILY,
    },
    weekly: {
      current: parseInt(weekCount) || 0,
      limit: RATE_LIMITS.WEEKLY,
      exceeded: (parseInt(weekCount) || 0) >= RATE_LIMITS.WEEKLY,
    },
  };

  return limits;
}

// Increment rate limit counters
async function incrementRateLimits(userId) {
  const now = Date.now();
  const hourKey = `rate_limit:${userId}:hour:${Math.floor(now / (60 * 60 * 1000))}`;
  const dayKey = `rate_limit:${userId}:day:${Math.floor(now / (24 * 60 * 60 * 1000))}`;
  const weekKey = `rate_limit:${userId}:week:${Math.floor(now / (7 * 24 * 60 * 60 * 1000))}`;

  const pipeline = redis.pipeline();
  pipeline.incr(hourKey);
  pipeline.expire(hourKey, 3600); // 1 hour TTL
  pipeline.incr(dayKey);
  pipeline.expire(dayKey, 86400); // 24 hours TTL
  pipeline.incr(weekKey);
  pipeline.expire(weekKey, 604800); // 7 days TTL

  await pipeline.exec();
}

// Add URN fetch delay to prevent LinkedIn 410 errors
async function addUrnFetchDelay(userId) {
  const urnDelayKey = `urn_fetch_delay:${userId}`;
  const lastUrnFetch = await redis.get(urnDelayKey);

  if (lastUrnFetch) {
    const timeSinceLastFetch = Date.now() - parseInt(lastUrnFetch);
    const minInterval = URN_FETCH_DELAY.MIN + Math.random() * (URN_FETCH_DELAY.MAX - URN_FETCH_DELAY.MIN);

    if (timeSinceLastFetch < minInterval) {
      const waitTime = minInterval - timeSinceLastFetch;
      console.log(`⏱️ [URN Rate Limit] User ${userId} - Waiting ${Math.round(waitTime / 1000)}s before next URN fetch to avoid LinkedIn 410 errors`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  // Update last URN fetch time
  await redis.set(urnDelayKey, Date.now(), 'EX', 7200); // Expire after 2 hours
  console.log(`✅ [URN Rate Limit] User ${userId} - URN fetch delay applied`);
}

// Add invitation job to queue with proper sequencing
async function addInvitationJob(jobData) {
  const { userId, profileUrl, message, campaignId, prospectId, customDelays } = jobData;

  // Use Redis-based distributed lock instead of in-memory mutex
  const lockKey = `job_creation_lock:${userId}`;
  const lockValue = `${Date.now()}_${Math.random()}`;
  const lockTTL = 30; // 30 seconds TTL

  console.log(`🔒 [Lock] Attempting to acquire Redis lock for user ${userId}`);

  // Try to acquire Redis lock with retry logic
  let lockAcquired = false;
  let attempts = 0;
  const maxAttempts = 100; // 10 seconds max wait

  while (!lockAcquired && attempts < maxAttempts) {
    const result = await redis.set(lockKey, lockValue, 'PX', lockTTL * 1000, 'NX');
    if (result === 'OK') {
      lockAcquired = true;
      console.log(`✅ [Lock] Acquired Redis lock for user ${userId}`);
    } else {
      console.log(`⏳ [Lock] Waiting for Redis lock for user ${userId} (attempt ${attempts + 1})`);
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
      attempts++;
    }
  }

  if (!lockAcquired) {
    throw new Error(`Failed to acquire lock for user ${userId} after ${maxAttempts} attempts`);
  }

  try {
    // Check rate limits first
    const rateLimits = await checkRateLimits(userId);

    if (rateLimits.hourly.exceeded || rateLimits.daily.exceeded || rateLimits.weekly.exceeded) {
      throw new Error(`Rate limit exceeded. Hourly: ${rateLimits.hourly.current}/${rateLimits.hourly.limit}, Daily: ${rateLimits.daily.current}/${rateLimits.daily.limit}, Weekly: ${rateLimits.weekly.current}/${rateLimits.weekly.limit}`);
    }

    // Get campaign settings (required - no fallback to global)
    let delaySettings;
    let workingHoursSettings;

    if (campaignId) {
      try {
        const Campaign = require('../models/Campaign');
        const campaign = await Campaign.findById(campaignId).select('linkedinSettings');

        if (campaign?.linkedinSettings) {
          // Use campaign-specific settings
          delaySettings = {
            minDelay: campaign.linkedinSettings.delaySettings?.invitations?.minDelay || INVITATION_DELAY.MIN,
            maxDelay: campaign.linkedinSettings.delaySettings?.invitations?.maxDelay || INVITATION_DELAY.MAX
          };
          workingHoursSettings = campaign.linkedinSettings.workingHours;
          console.log('📋 [Invitations] Using campaign-specific settings');
        } else {
          throw new Error(`Campaign ${campaignId} has no LinkedIn settings configured. Please configure campaign settings first.`);
        }
      } catch (error) {
        console.error('Error fetching campaign settings:', error);
        throw error;
      }
    } else {
      // Use custom delays or defaults if no campaign (for backward compatibility)
      delaySettings = customDelays || {
        minDelay: INVITATION_DELAY.MIN,
        maxDelay: INVITATION_DELAY.MAX
      };
      workingHoursSettings = null;
      console.log('⚙️ [Invitations] Using system defaults (no campaign ID provided)');
    }

    console.log(`⏰ [Invitations] Using delays: ${delaySettings.minDelay}ms - ${delaySettings.maxDelay}ms`);

    // Use Redis to track the next available slot for this user
    const nextSlotKey = `next_slot:${userId}`;
    const currentTime = Date.now();

    // Get the next available slot time (atomic operation)
    const nextSlotTime = await redis.eval(`
      local key = KEYS[1]
      local currentTime = tonumber(ARGV[1])
      local minDelay = tonumber(ARGV[2])
      local maxDelay = tonumber(ARGV[3])
      
      -- Get current next slot time
      local nextSlot = redis.call('GET', key)
      if not nextSlot then
        nextSlot = currentTime
      else
        nextSlot = tonumber(nextSlot)
      end
      
      -- Ensure next slot is at least current time + min delay
      if nextSlot < currentTime + minDelay then
        nextSlot = currentTime + minDelay
      end
      
      -- Add random delay (2-3 minutes)
      local randomDelay = math.random(minDelay, maxDelay)
      local scheduledTime = nextSlot
      
      -- Set next slot for subsequent jobs
      local newNextSlot = scheduledTime + randomDelay
      redis.call('SET', key, newNextSlot, 'EX', 3600) -- Expire in 1 hour
      
      return scheduledTime
    `, 1, nextSlotKey, currentTime, delaySettings.minDelay, delaySettings.maxDelay);

    const scheduledTime = parseInt(nextSlotTime);
    const delay = Math.max(0, scheduledTime - currentTime);

    console.log(`📅 [Sequencing] Scheduled job at: ${new Date(scheduledTime).toISOString()}`);
    console.log(`📅 [Sequencing] Delay from now: ${Math.round(delay / 1000)}s (${Math.round(delay / 60000 * 10) / 10} minutes)`);

    // Note: Global settings have been removed - all settings are now campaign-specific

    // If outside working hours, adjust scheduling
    let finalScheduledTime = scheduledTime;
    let finalDelay = delay;

    // Use campaign working hours settings (no global fallback)
    const settingsForWorkingHours = workingHoursSettings ? { workingHours: workingHoursSettings } : null;

    if (!isWorkingHours(settingsForWorkingHours)) {
      const nextWorking = getNextWorkingHour(settingsForWorkingHours);
      const workingHoursStart = nextWorking.getTime();

      // If our calculated time is before working hours start, move it to working hours
      if (scheduledTime < workingHoursStart) {
        finalScheduledTime = workingHoursStart;
        finalDelay = finalScheduledTime - currentTime;

        // Update Redis next slot to account for working hours adjustment
        await redis.set(nextSlotKey, finalScheduledTime + getRandomDelay(), 'EX', 3600);
      }
    }

    // Get current job count for sequence position
    const [waiting, active, delayed] = await Promise.all([
      linkedinInvitationQueue.getWaiting(),
      linkedinInvitationQueue.getActive(),
      linkedinInvitationQueue.getDelayed(),
    ]);

    const userJobs = [...waiting, ...active, ...delayed].filter(job => job.data.userId === userId);
    const sequencePosition = userJobs.length + 1;

    // Create job with calculated delay
    const job = await linkedinInvitationQueue.add('send_invitation', {
      userId,
      profileUrl,
      message,
      campaignId,
      prospectId,
      scheduledAt: new Date(finalScheduledTime).toISOString(),
      sequencePosition: sequencePosition,
    }, {
      delay: finalDelay,
      jobId: `invitation_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    });

    console.log(`📅 LinkedIn invitation job scheduled with ${Math.round(finalDelay / 1000)}s delay (position ${sequencePosition} in sequence)`);

    return {
      jobId: job.id,
      delay: finalDelay,
      scheduledAt: new Date(finalScheduledTime).toISOString(),
      sequencePosition: sequencePosition,
      rateLimits,
    };
  } finally {
    // Release Redis lock
    const lockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(lockScript, 1, lockKey, lockValue);
    console.log(`🔓 [Lock] Released Redis lock for user ${userId}`);
  }
}

// Process invitation jobs
linkedinInvitationQueue.process('send_invitation', async (job) => {
  const { userId, profileUrl, message, campaignId, prospectId } = job.data;

  console.log(`🚀 Processing LinkedIn invitation job ${job.id}`);
  console.log(`👤 User: ${userId}, Profile: ${profileUrl}`);

  try {
    // Double-check rate limits before processing
    const rateLimits = await checkRateLimits(userId);

    if (rateLimits.hourly.exceeded || rateLimits.daily.exceeded || rateLimits.weekly.exceeded) {
      throw new Error(`Rate limit exceeded during processing. Hourly: ${rateLimits.hourly.current}/${rateLimits.hourly.limit}, Daily: ${rateLimits.daily.current}/${rateLimits.daily.limit}, Weekly: ${rateLimits.weekly.current}/${rateLimits.weekly.limit}`);
    }

    // Get campaign settings for working hours (required if campaign ID provided)
    let workingHoursSettings;

    if (campaignId) {
      try {
        const Campaign = require('../models/Campaign');
        const campaign = await Campaign.findById(campaignId).select('linkedinSettings');

        if (campaign?.linkedinSettings?.workingHours) {
          workingHoursSettings = { workingHours: campaign.linkedinSettings.workingHours };
          console.log('📋 [Invitations] Using campaign working hours for execution');
        } else {
          console.warn(`⚠️ [Invitations] Campaign ${campaignId} has no working hours configured, using system defaults`);
          workingHoursSettings = null;
        }
      } catch (error) {
        console.error('Error fetching campaign settings for execution:', error);
        workingHoursSettings = null;
      }
    } else {
      // No campaign ID, use system defaults
      console.log('⚙️ [Invitations] No campaign ID, using system defaults for working hours');
      workingHoursSettings = null;
    }

    // Check if still within working hours
    if (!isWorkingHours(workingHoursSettings)) {
      const nextWorking = getNextWorkingHour(workingHoursSettings);
      const workingHoursStart = nextWorking.getTime();

      // If our calculated time is before working hours start, move it to working hours
      if (job.timestamp < workingHoursStart) {
        const delayUntilWorking = workingHoursStart - Date.now();

        // Reschedule for next working hour
        await linkedinInvitationQueue.add('send_invitation', job.data, {
          delay: delayUntilWorking,
          jobId: `rescheduled_${job.id}`,
        });

        throw new Error(`Outside working hours. Rescheduled for ${nextWorking.toISOString()}`);
      }
    }

    // Get LinkedIn session
    const LinkedInSession = require('../models/LinkedInSession');
    let session = await LinkedInSession.findValidSession(userId);

    if (!session) {
      throw new Error('No valid LinkedIn session found. Please refresh your session via the browser extension.');
    }

    // VALIDATE SESSION ACTUALLY WORKS
    console.log('🔍 Validating LinkedIn session before processing...');
    try {
      // Test with a simple API call that doesn't affect anything
      const axios = require('axios');
      const { formatCookieString, extractCSRFToken } = require('./linkedinService');

      const cookieString = formatCookieString(session.cookies);
      const csrfToken = extractCSRFToken(session.cookies);

      // Simple test call to LinkedIn API
      await axios.get('https://www.linkedin.com/voyager/api/me', {
        headers: {
          'cookie': cookieString,
          'csrf-token': csrfToken,
          'user-agent': session.userAgent
        },
        timeout: 5000
      });

      console.log('✅ LinkedIn session validation successful');

    } catch (error) {
      console.error('❌ LinkedIn session validation failed:', error.response?.status, error.message);

      if (error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 410) {
        // Mark session as unhealthy
        await LinkedInSession.findByIdAndUpdate(session._id, {
          isHealthy: false,
          healthCheckErrors: [...(session.healthCheckErrors || []), {
            error: `Session validation failed: ${error.response?.status} ${error.message}`,
            timestamp: new Date()
          }]
        });

        throw new Error('LinkedIn session expired or invalid. Please refresh your session via the browser extension.');
      }

      // For other errors, continue but log warning
      console.warn('⚠️ Session validation inconclusive, proceeding with caution');
    }

    // Add URN fetch delay to prevent LinkedIn 410 errors
    await addUrnFetchDelay(userId);

    // Get target profile URN with enhanced error handling
    console.log(`🔍 [URN Fetch] User ${userId} - Fetching URN for ${profileUrl}`);
    let targetProfileUrn;
    try {
      targetProfileUrn = await getTargetProfileUrn(session, profileUrl);
      console.log(`✅ [URN Fetch] User ${userId} - Successfully fetched URN`);
    } catch (error) {
      if (error.message.includes('410') || error.message.includes('Gone')) {
        console.error(`🚫 [URN Fetch] User ${userId} - LinkedIn returned 410 (Gone) for ${profileUrl}`);
        throw new Error(`LinkedIn profile no longer accessible (410 Gone): ${profileUrl}`);
      }
      console.error(`❌ [URN Fetch] User ${userId} - URN fetch failed:`, error.message);
      throw error;
    }

    // FINAL SAFETY CHECK: Check connection status before sending invitation
    console.log('🔍 [Queue] Final connection check before sending invitation...');
    const { checkLinkedInConnectionStatus } = require('./linkedinService');

    try {
      const connectionResult = await checkLinkedInConnectionStatus(session, profileUrl);
      const isConnected = connectionResult.status === 'connected' || connectionResult.isConnected === true;
      const isPending = connectionResult.status === 'invitation_pending' || connectionResult.invitationPending === true;

      console.log('🔗 [Queue] Connection check result:', {
        status: connectionResult.status,
        isConnected,
        isPending,
        profileUrl
      });

      if (isConnected) {
        console.log('✅ [Queue] Already connected - skipping invitation send');
        return {
          success: true,
          jobId: job.id,
          skipped: true,
          reason: 'Already connected',
          connectionStatus: connectionResult.status,
          targetProfileUrn,
          sentAt: new Date(),
        };
      }

      if (isPending) {
        console.log('📤 [Queue] Invitation already pending - skipping duplicate');
        return {
          success: true,
          jobId: job.id,
          skipped: true,
          reason: 'Invitation already pending',
          connectionStatus: connectionResult.status,
          targetProfileUrn,
          sentAt: new Date(),
        };
      }

      console.log('📤 [Queue] No connection found - proceeding with invitation');
    } catch (connectionCheckError) {
      console.warn('⚠️ [Queue] Connection check failed, proceeding with invitation:', connectionCheckError.message);
      // Continue with invitation if connection check fails (fail-safe approach)
    }

    // Send invitation
    const result = await sendLinkedInInvitation(session, targetProfileUrn, profileUrl, message);

    // Increment rate limit counters
    await incrementRateLimits(userId);

    console.log(`✅ LinkedIn invitation sent successfully: ${job.id}`);

    return {
      success: true,
      jobId: job.id,
      invitationId: result.invitationId,
      targetProfileUrn,
      sentAt: result.sentAt,
    };

  } catch (error) {
    console.error(`❌ LinkedIn invitation job failed: ${job.id}`, error.message);
    throw error;
  }
});

// Queue event handlers
linkedinInvitationQueue.on('completed', async (job, result) => {
  console.log(`✅ Job ${job.id} completed successfully`);

  // Notify campaign service about job completion
  try {
    const campaignService = require('./campaignService');
    await campaignService.handleQueueJobCompletion(job.id, true, result);
  } catch (error) {
    console.error('Error notifying campaign service of job completion:', error);
  }
});

linkedinInvitationQueue.on('failed', async (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);

  // Notify campaign service about job failure
  try {
    const campaignService = require('./campaignService');
    await campaignService.handleQueueJobCompletion(job.id, false, { error: err.message });
  } catch (error) {
    console.error('Error notifying campaign service of job failure:', error);
  }
});

linkedinInvitationQueue.on('stalled', (job) => {
  console.warn(`⚠️ Job ${job.id} stalled`);
});

// Get queue statistics
async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    linkedinInvitationQueue.getWaiting(),
    linkedinInvitationQueue.getActive(),
    linkedinInvitationQueue.getCompleted(),
    linkedinInvitationQueue.getFailed(),
    linkedinInvitationQueue.getDelayed(),
  ]);

  return {
    waiting: waiting.length,
    active: active.length,
    completed: completed.length,
    failed: failed.length,
    delayed: delayed.length,
    total: waiting.length + active.length + completed.length + failed.length + delayed.length,
  };
}

// Get detailed queue information
async function getQueueDetails() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    linkedinInvitationQueue.getWaiting(),
    linkedinInvitationQueue.getActive(),
    linkedinInvitationQueue.getCompleted(),
    linkedinInvitationQueue.getFailed(),
    linkedinInvitationQueue.getDelayed(),
  ]);

  const formatJob = (job) => ({
    id: job.id,
    data: job.data,
    createdAt: new Date(job.timestamp).toISOString(),
    processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    delay: job.opts?.delay || 0,
    delayMinutes: Math.round((job.opts?.delay || 0) / 60000 * 10) / 10, // Round to 1 decimal
    remainingTime: job.opts?.delay ? Math.max(0, (job.timestamp + job.opts.delay) - Date.now()) : 0,
    remainingMinutes: job.opts?.delay ? Math.round(Math.max(0, (job.timestamp + job.opts.delay) - Date.now()) / 60000 * 10) / 10 : 0,
    attempts: job.attemptsMade || 0,
    maxAttempts: job.opts?.attempts || 1,
  });

  return {
    waiting: waiting.map(formatJob),
    active: active.map(formatJob),
    completed: completed.map(formatJob), // Last 100 completed
    failed: failed.slice(-10).map(formatJob),       // Last 10 failed
    delayed: delayed.map(formatJob),
    stats: await getQueueStats(),
  };
}

// Clear all jobs from queue
async function clearQueue() {
  // Clear all job types from the queue
  await Promise.all([
    linkedinInvitationQueue.empty(), // Removes waiting jobs
    linkedinInvitationQueue.clean(0, 'completed'),
    linkedinInvitationQueue.clean(0, 'failed'),
    linkedinInvitationQueue.clean(0, 'active'),
    linkedinInvitationQueue.clean(0, 'delayed'),
  ]);
  console.log('🧹 LinkedIn invitation queue cleared completely');
  return { success: true, message: 'Queue cleared successfully' };
}

// Get user rate limit status
async function getUserRateLimits(userId) {
  return await checkRateLimits(userId);
}

module.exports = {
  linkedinInvitationQueue,
  addInvitationJob,
  getQueueStats,
  getQueueDetails,
  clearQueue,
  getUserRateLimits,
  checkRateLimits,
  isWorkingHours,
  getNextWorkingHour,
  RATE_LIMITS,
  WORKING_HOURS,
};

const Bull = require('bull');
const Redis = require('ioredis');

// Mutex to prevent race conditions when adding jobs
const jobCreationMutex = new Map();

const { sendLinkedInMessage, getTargetProfileUrn } = require('./linkedinService');

// Create Redis client for rate limiting
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
});

// Create LinkedIn message queue
const linkedinMessageQueue = new Bull('linkedin messages', {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
    },
    defaultJobOptions: {
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 50,      // Keep last 50 failed jobs
        attempts: 3,           // Retry failed jobs 3 times
        backoff: {
            type: 'exponential',
            delay: 30000,        // Start with 30 second delay
        },
    },
});

// Rate limiting constants for messages (more lenient than invitations)
const RATE_LIMITS = {
    HOURLY: 50,    // Max 50 messages per hour
    DAILY: 200,    // Max 200 messages per day  
    WEEKLY: 1000,  // Max 1000 messages per week
};

// Working hours (9 AM to 6 PM) - same as invitations
const WORKING_HOURS = {
    START: 9,  // 9 AM
    END: 18,   // 6 PM
};

// Delay between messages (30 seconds to 2 minutes - shorter than invitations)
const MESSAGE_DELAY = {
    MIN: 30 * 1000,      // 30 seconds in milliseconds
    MAX: 2 * 60 * 1000,  // 2 minutes in milliseconds
};

// Generate random delay between min and max
function getRandomDelay() {
    return Math.floor(Math.random() * (MESSAGE_DELAY.MAX - MESSAGE_DELAY.MIN + 1)) + MESSAGE_DELAY.MIN;
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

// Check rate limits for a user (separate from invitation limits)
async function checkRateLimits(userId) {
    const now = Date.now();
    const hourKey = `message_rate_limit:${userId}:hour:${Math.floor(now / (60 * 60 * 1000))}`;
    const dayKey = `message_rate_limit:${userId}:day:${Math.floor(now / (24 * 60 * 60 * 1000))}`;
    const weekKey = `message_rate_limit:${userId}:week:${Math.floor(now / (7 * 24 * 60 * 60 * 1000))}`;

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

// Increment rate limit counters for messages
async function incrementRateLimits(userId) {
    const now = Date.now();
    const hourKey = `message_rate_limit:${userId}:hour:${Math.floor(now / (60 * 60 * 1000))}`;
    const dayKey = `message_rate_limit:${userId}:day:${Math.floor(now / (24 * 60 * 60 * 1000))}`;
    const weekKey = `message_rate_limit:${userId}:week:${Math.floor(now / (7 * 24 * 60 * 60 * 1000))}`;

    const pipeline = redis.pipeline();
    pipeline.incr(hourKey);
    pipeline.expire(hourKey, 3600); // 1 hour TTL
    pipeline.incr(dayKey);
    pipeline.expire(dayKey, 86400); // 24 hours TTL
    pipeline.incr(weekKey);
    pipeline.expire(weekKey, 604800); // 7 days TTL

    await pipeline.exec();
}

// Add message job to queue with proper sequencing
async function addMessageJob(jobData) {
    const { userId, targetProfileUrn, profileUrl, message, campaignId, prospectId, customDelays } = jobData;

    // Use Redis-based distributed lock instead of in-memory mutex
    const lockKey = `message_job_creation_lock:${userId}`;
    const lockValue = `${Date.now()}_${Math.random()}`;
    const lockTTL = 30; // 30 seconds TTL

    console.log(`🔒 [Message Lock] Attempting to acquire Redis lock for user ${userId}`);

    // Try to acquire Redis lock with retry logic
    let lockAcquired = false;
    let attempts = 0;
    const maxAttempts = 100; // 10 seconds max wait

    while (!lockAcquired && attempts < maxAttempts) {
        const result = await redis.set(lockKey, lockValue, 'PX', lockTTL * 1000, 'NX');
        if (result === 'OK') {
            lockAcquired = true;
            console.log(`✅ [Message Lock] Acquired Redis lock for user ${userId}`);
        } else {
            console.log(`⏳ [Message Lock] Waiting for Redis lock for user ${userId} (attempt ${attempts + 1})`);
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
            attempts++;
        }
    }

    if (!lockAcquired) {
        throw new Error(`Failed to acquire message lock for user ${userId} after ${maxAttempts} attempts`);
    }

    try {
        // Check rate limits first
        const rateLimits = await checkRateLimits(userId);

        if (rateLimits.hourly.exceeded || rateLimits.daily.exceeded || rateLimits.weekly.exceeded) {
            throw new Error(`Message rate limit exceeded. Hourly: ${rateLimits.hourly.current}/${rateLimits.hourly.limit}, Daily: ${rateLimits.daily.current}/${rateLimits.daily.limit}, Weekly: ${rateLimits.weekly.current}/${rateLimits.weekly.limit}`);
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
                        minDelay: campaign.linkedinSettings.delaySettings?.messages?.minDelay || MESSAGE_DELAY.MIN,
                        maxDelay: campaign.linkedinSettings.delaySettings?.messages?.maxDelay || MESSAGE_DELAY.MAX
                    };
                    workingHoursSettings = campaign.linkedinSettings.workingHours;
                    console.log('📋 [Messages] Using campaign-specific settings');
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
                minDelay: MESSAGE_DELAY.MIN,
                maxDelay: MESSAGE_DELAY.MAX
            };
            workingHoursSettings = null;
            console.log('⚙️ [Messages] Using system defaults (no campaign ID provided)');
        }

        console.log(`⏰ [Messages] Using delays: ${delaySettings.minDelay}ms - ${delaySettings.maxDelay}ms`);

        // Use Redis to track the next available slot for this user (separate from invitations)
        const nextSlotKey = `message_next_slot:${userId}`;
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
      
      -- Add random delay (30s - 2min)
      local randomDelay = math.random(minDelay, maxDelay)
      local scheduledTime = nextSlot
      
      -- Set next slot for subsequent jobs
      local newNextSlot = scheduledTime + randomDelay
      redis.call('SET', key, newNextSlot, 'EX', 3600) -- Expire in 1 hour
      
      return scheduledTime
    `, 1, nextSlotKey, currentTime, delaySettings.minDelay, delaySettings.maxDelay);

        const scheduledTime = parseInt(nextSlotTime);
        const delay = Math.max(0, scheduledTime - currentTime);

        console.log(`📅 [Message Sequencing] Scheduled job at: ${new Date(scheduledTime).toISOString()}`);
        console.log(`📅 [Message Sequencing] Delay from now: ${Math.round(delay / 1000)}s (${Math.round(delay / 60000 * 10) / 10} minutes)`);

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
            linkedinMessageQueue.getWaiting(),
            linkedinMessageQueue.getActive(),
            linkedinMessageQueue.getDelayed(),
        ]);

        const userJobs = [...waiting, ...active, ...delayed].filter(job => job.data.userId === userId);
        const sequencePosition = userJobs.length + 1;

        // Create job with calculated delay
        const job = await linkedinMessageQueue.add('send_message', {
            userId,
            targetProfileUrn,
            profileUrl,
            message,
            campaignId,
            prospectId,
            scheduledAt: new Date(finalScheduledTime).toISOString(),
            sequencePosition: sequencePosition,
        }, {
            delay: finalDelay,
            jobId: `message_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        });

        console.log(`📅 LinkedIn message job scheduled with ${Math.round(finalDelay / 1000)}s delay (position ${sequencePosition} in sequence)`);

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
        console.log(`🔓 [Message Lock] Released Redis lock for user ${userId}`);
    }
}

// Process message jobs
linkedinMessageQueue.process('send_message', async (job) => {
    const { userId, targetProfileUrn, profileUrl, message, campaignId, prospectId } = job.data;

    console.log(`🚀 Processing LinkedIn message job ${job.id}`);
    console.log(`👤 User: ${userId}, Profile: ${profileUrl}`);
    console.log(`💬 Message preview: ${message.substring(0, 100)}...`);

    try {
        // Double-check rate limits before processing
        const rateLimits = await checkRateLimits(userId);

        if (rateLimits.hourly.exceeded || rateLimits.daily.exceeded || rateLimits.weekly.exceeded) {
            throw new Error(`Message rate limit exceeded during processing. Hourly: ${rateLimits.hourly.current}/${rateLimits.hourly.limit}, Daily: ${rateLimits.daily.current}/${rateLimits.daily.limit}, Weekly: ${rateLimits.weekly.current}/${rateLimits.weekly.limit}`);
        }

        // Get campaign settings for working hours (required if campaign ID provided)
        let workingHoursSettings;

        if (campaignId) {
            try {
                const Campaign = require('../models/Campaign');
                const campaign = await Campaign.findById(campaignId).select('linkedinSettings');

                if (campaign?.linkedinSettings?.workingHours) {
                    workingHoursSettings = { workingHours: campaign.linkedinSettings.workingHours };
                    console.log('📋 [Messages] Using campaign working hours for execution');
                } else {
                    console.warn(`⚠️ [Messages] Campaign ${campaignId} has no working hours configured, using system defaults`);
                    workingHoursSettings = null;
                }
            } catch (error) {
                console.error('Error fetching campaign settings for execution:', error);
                workingHoursSettings = null;
            }
        } else {
            // No campaign ID, use system defaults
            console.log('⚙️ [Messages] No campaign ID, using system defaults for working hours');
            workingHoursSettings = null;
        }

        // Check if still within working hours
        if (!isWorkingHours(workingHoursSettings)) {
            const nextWorking = getNextWorkingHour(workingHoursSettings);
            const workingHoursStart = nextWorking.getTime();

            // If our calculated time is before working hours start, reschedule
            if (job.timestamp < workingHoursStart) {
                const delayUntilWorking = workingHoursStart - Date.now();

                // Reschedule for next working hour
                await linkedinMessageQueue.add('send_message', job.data, {
                    delay: delayUntilWorking,
                    jobId: `rescheduled_message_${job.id}`,
                });

                throw new Error(`Outside working hours. Message rescheduled for ${nextWorking.toISOString()}`);
            }
        }

        // Get LinkedIn session
        const LinkedInSession = require('../models/LinkedInSession');
        const session = await LinkedInSession.findValidSession(userId);

        if (!session) {
            throw new Error('No valid LinkedIn session found');
        }

        // FINAL SAFETY CHECK: Verify connection status before sending message
        console.log('🔍 [Queue] Checking connection status before sending message...');
        const { checkLinkedInConnectionStatus } = require('./linkedinService');

        try {
            const connectionResult = await checkLinkedInConnectionStatus(session, profileUrl);
            const isConnected = connectionResult.status === 'connected' || connectionResult.isConnected === true;

            console.log('🔗 [Queue] Message connection check result:', {
                status: connectionResult.status,
                isConnected,
                profileUrl
            });

            if (!isConnected) {
                console.log('⚠️ [Queue] Not connected - cannot send message');
                throw new Error('Cannot send message: Not connected to this LinkedIn profile');
            }

            console.log('✅ [Queue] Connected - proceeding with message');
        } catch (connectionCheckError) {
            if (connectionCheckError.message.includes('Not connected')) {
                throw connectionCheckError; // Re-throw connection errors
            }
            console.warn('⚠️ [Queue] Connection check failed, proceeding with message:', connectionCheckError.message);
            // Continue with message if connection check fails (fail-safe approach)
        }

        // Send message using existing LinkedIn service
        const result = await sendLinkedInMessage(session, targetProfileUrn, profileUrl, message);

        // Update campaign and prospect status
        const Campaign = require('../models/Campaign');
        const campaign = await Campaign.findById(campaignId);

        if (campaign) {
            // Update campaign stats
            await Campaign.findByIdAndUpdate(campaignId, {
                $inc: { 'stats.linkedinMessagesSent': 1 }
            });

            // Update prospect status
            const prospect = campaign.prospects.id(prospectId);
            if (prospect) {
                prospect.status = 'linkedin_message_sent';
                prospect.lastContacted = new Date();
                prospect.lastActivity = new Date();
                await campaign.save();
            }
        }

        // Increment rate limit counters
        await incrementRateLimits(userId);

        console.log(`✅ LinkedIn message sent successfully: ${job.id}`);

        return {
            success: true,
            jobId: job.id,
            messageId: result.messageId,
            targetProfileUrn,
            sentAt: result.sentAt,
        };

    } catch (error) {
        console.error(`❌ LinkedIn message job failed: ${job.id}`, error.message);

        // Update prospect status to failed if possible
        try {
            const Campaign = require('../models/Campaign');
            const campaign = await Campaign.findById(campaignId);

            if (campaign) {
                const prospect = campaign.prospects.id(prospectId);
                if (prospect) {
                    prospect.status = 'linkedin_message_failed';
                    prospect.lastActivity = new Date();
                    await campaign.save();
                }
            }
        } catch (updateError) {
            console.error('Failed to update prospect status after message failure:', updateError.message);
        }

        throw error;
    }
});

// Queue event handlers
linkedinMessageQueue.on('completed', async (job, result) => {
    console.log(`✅ Message Job ${job.id} completed successfully`);

    // Notify campaign service about job completion
    try {
        const campaignService = require('./campaignService');
        await campaignService.handleQueueJobCompletion(job.id, true, result);
    } catch (error) {
        console.error('Error notifying campaign service of job completion:', error);
    }
});

linkedinMessageQueue.on('failed', async (job, err) => {
    console.error(`❌ Message Job ${job.id} failed:`, err.message);

    // Notify campaign service about job failure
    try {
        const campaignService = require('./campaignService');
        await campaignService.handleQueueJobCompletion(job.id, false, { error: err.message });
    } catch (error) {
        console.error('Error notifying campaign service of job failure:', error);
    }
});

linkedinMessageQueue.on('stalled', (job) => {
    console.warn(`⚠️ Message Job ${job.id} stalled`);
});

// Get queue statistics
async function getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
        linkedinMessageQueue.getWaiting(),
        linkedinMessageQueue.getActive(),
        linkedinMessageQueue.getCompleted(),
        linkedinMessageQueue.getFailed(),
        linkedinMessageQueue.getDelayed(),
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
        linkedinMessageQueue.getWaiting(),
        linkedinMessageQueue.getActive(),
        linkedinMessageQueue.getCompleted(),
        linkedinMessageQueue.getFailed(),
        linkedinMessageQueue.getDelayed(),
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
        completed: completed.slice(-10).map(formatJob), // Last 10 completed
        failed: failed.slice(-10).map(formatJob),       // Last 10 failed
        delayed: delayed.map(formatJob),
        stats: await getQueueStats(),
    };
}

// Clear all jobs from queue
async function clearQueue() {
    // Clear all job types from the queue
    await Promise.all([
        linkedinMessageQueue.empty(), // Removes waiting jobs
        linkedinMessageQueue.clean(0, 'completed'),
        linkedinMessageQueue.clean(0, 'failed'),
        linkedinMessageQueue.clean(0, 'active'),
        linkedinMessageQueue.clean(0, 'delayed'),
    ]);
    console.log('🧹 LinkedIn message queue cleared completely');
    return { success: true, message: 'Message queue cleared successfully' };
}

// Get user rate limit status
async function getUserRateLimits(userId) {
    return await checkRateLimits(userId);
}

module.exports = {
    linkedinMessageQueue,
    addMessageJob,
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

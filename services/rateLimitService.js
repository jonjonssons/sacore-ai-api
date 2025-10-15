const Redis = require('ioredis');
const LinkedInInstruction = require('../models/LinkedInInstruction');

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
    console.error('❌ [Rate Limit] Redis connection error:', err.message);
});

redis.on('connect', () => {
    console.log('✅ [Rate Limit] Redis connected successfully');
});

// Rate limiting constants (conservative defaults - fallback if User model not set)
const RATE_LIMITS = {
    invitation: {
        HOURLY: 10,    // Max 10 invitations per hour
        DAILY: 20,     // Max 20 invitations per day  
        WEEKLY: 80,    // Max 80 invitations per week
    },
    message: {
        HOURLY: 20,    // Max 20 messages per hour
        DAILY: 50,     // Max 50 messages per day  
        WEEKLY: 200,   // Max 200 messages per week
    },
    visit: {
        HOURLY: 30,    // Max 30 profile visits per hour
        DAILY: 100,    // Max 100 profile visits per day
        WEEKLY: 400,   // Max 400 profile visits per week
    },
    check: {
        HOURLY: 50,    // Max 50 connection checks per hour
        DAILY: 200,    // Max 200 connection checks per day
        WEEKLY: 800,   // Max 800 connection checks per week
    }
};

// Delay constants (preserve existing timing)
const ACTION_DELAYS = {
    invitation: {
        MIN: 2 * 60 * 1000,  // 2 minutes
        MAX: 3 * 60 * 1000,  // 3 minutes
    },
    message: {
        MIN: 30 * 1000,      // 30 seconds
        MAX: 2 * 60 * 1000,  // 2 minutes
    },
    visit: {
        MIN: 10 * 1000,      // 10 seconds
        MAX: 30 * 1000,      // 30 seconds
    },
    check: {
        MIN: 5 * 1000,       // 5 seconds
        MAX: 15 * 1000,      // 15 seconds
    }
};

class RateLimitService {
    constructor() {
        this.redis = redis;
    }

    // Get rate limits from User model or use defaults
    async getUserRateLimits(userId, actionType) {
        try {
            const User = require('../models/User');
            const user = await User.findById(userId).select('linkedinRateLimits');

            if (user?.linkedinRateLimits?.[actionType]) {
                const userLimits = user.linkedinRateLimits[actionType];
                console.log(`📊 [Rate Limits] Using user settings for ${actionType}:`, {
                    hourly: userLimits.hourly,
                    daily: userLimits.daily,
                    weekly: userLimits.weekly
                });
                return {
                    HOURLY: userLimits.hourly,
                    DAILY: userLimits.daily,
                    WEEKLY: userLimits.weekly
                };
            }

            // Fallback to system defaults
            console.log(`📊 [Rate Limits] Using system defaults for ${actionType}`);
            return RATE_LIMITS[actionType];

        } catch (error) {
            console.error('❌ Error fetching user rate limits:', error);
            return RATE_LIMITS[actionType];
        }
    }

    // Check rate limits for a user and action (now uses user settings)
    async checkRateLimits(userId, action) {
        const actionType = this.getActionType(action);
        const limits = await this.getUserRateLimits(userId, actionType);

        if (!limits) {
            throw new Error(`Unknown action type: ${action}`);
        }

        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const currentWeek = this.getWeekKey(now);

        // Redis keys (same format as existing queues)
        const hourKey = `linkedin_${actionType}:${userId}:hour:${currentDay}:${currentHour}`;
        const dayKey = `linkedin_${actionType}:${userId}:day:${currentDay}`;
        const weekKey = `linkedin_${actionType}:${userId}:week:${currentWeek}`;

        // Get current counts
        const [hourCount, dayCount, weekCount] = await Promise.all([
            this.redis.get(hourKey),
            this.redis.get(dayKey),
            this.redis.get(weekKey),
        ]);

        const hourlyCount = parseInt(hourCount) || 0;
        const dailyCount = parseInt(dayCount) || 0;
        const weeklyCount = parseInt(weekCount) || 0;

        return {
            hourly: {
                current: hourlyCount,
                limit: limits.HOURLY,
                exceeded: hourlyCount >= limits.HOURLY
            },
            daily: {
                current: dailyCount,
                limit: limits.DAILY,
                exceeded: dailyCount >= limits.DAILY
            },
            weekly: {
                current: weeklyCount,
                limit: limits.WEEKLY,
                exceeded: weeklyCount >= limits.WEEKLY
            },
            canSend: hourlyCount < limits.HOURLY &&
                dailyCount < limits.DAILY &&
                weeklyCount < limits.WEEKLY
        };
    }

    // Record an action (preserve existing logic)
    async recordAction(userId, action) {
        const actionType = this.getActionType(action);
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.toISOString().split('T')[0];
        const currentWeek = this.getWeekKey(now);

        const hourKey = `linkedin_${actionType}:${userId}:hour:${currentDay}:${currentHour}`;
        const dayKey = `linkedin_${actionType}:${userId}:day:${currentDay}`;
        const weekKey = `linkedin_${actionType}:${userId}:week:${currentWeek}`;

        // Increment counters with expiration (same as existing queues)
        const pipeline = this.redis.pipeline();
        pipeline.incr(hourKey);
        pipeline.expire(hourKey, 3600); // 1 hour TTL
        pipeline.incr(dayKey);
        pipeline.expire(dayKey, 86400); // 24 hours TTL
        pipeline.incr(weekKey);
        pipeline.expire(weekKey, 604800); // 7 days TTL

        await pipeline.exec();
    }

    // Get next available slot for user (preserve existing Redis logic)
    async getNextAvailableSlot(userId, action, baseDelay = 0) {
        const actionType = this.getActionType(action);
        const nextSlotKey = `${actionType}_next_slot:${userId}`;
        const currentTime = Date.now();
        const minDelay = ACTION_DELAYS[actionType].MIN;
        const maxDelay = ACTION_DELAYS[actionType].MAX;

        // Use Redis Lua script for atomic slot calculation (same as existing queues)
        const nextSlotTime = await this.redis.eval(`
            local key = KEYS[1]
            local currentTime = tonumber(ARGV[1])
            local baseDelay = tonumber(ARGV[2])
            local minDelay = tonumber(ARGV[3])
            local maxDelay = tonumber(ARGV[4])
            
            -- Get current next slot time
            local nextSlot = redis.call('GET', key)
            if not nextSlot then
                nextSlot = currentTime
            else
                nextSlot = tonumber(nextSlot)
            end
            
            -- Calculate scheduled time (max of current time + base delay, or next available slot)
            local scheduledTime = math.max(currentTime + baseDelay, nextSlot)
            
            -- Add random delay between min and max
            local randomDelay = math.random(minDelay, maxDelay)
            local newNextSlot = scheduledTime + randomDelay
            
            -- Update next slot with expiration
            redis.call('SET', key, newNextSlot, 'EX', 3600) -- Expire in 1 hour
            
            return scheduledTime
        `, 1, nextSlotKey, currentTime, baseDelay, minDelay, maxDelay);

        return parseInt(nextSlotTime);
    }

    // Check if within working hours (preserve existing logic)
    isWorkingHours(workingHours = null) {
        if (!workingHours || !workingHours.enabled) {
            return true; // No working hours restriction
        }

        const timezone = workingHours.timezone || 'UTC';
        const now = new Date();

        // Convert to user's timezone
        const userTime = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
        const currentHour = userTime.getHours();
        const currentDay = userTime.getDay(); // 0 = Sunday, 6 = Saturday

        // Check weekend restriction
        if (!workingHours.weekendsEnabled && (currentDay === 0 || currentDay === 6)) {
            return false;
        }

        // Check hour restriction
        return currentHour >= workingHours.start && currentHour < workingHours.end;
    }

    // Get next working hour (preserve existing logic)
    getNextWorkingHour(workingHours) {
        if (!workingHours || !workingHours.enabled) {
            return Date.now(); // No restriction
        }

        const timezone = workingHours.timezone || 'UTC';
        let nextTime = new Date();

        // Convert to user's timezone for calculation
        const userTimeString = nextTime.toLocaleString("en-US", { timeZone: timezone });
        let userTime = new Date(userTimeString);

        while (!this.isWorkingHours(workingHours)) {
            userTime.setHours(userTime.getHours() + 1);

            // If past end of day, move to next day start
            if (userTime.getHours() >= workingHours.end) {
                userTime.setDate(userTime.getDate() + 1);
                userTime.setHours(workingHours.start, 0, 0, 0);
            }

            // Skip weekends if not enabled
            if (!workingHours.weekendsEnabled) {
                const day = userTime.getDay();
                if (day === 0) { // Sunday -> Monday
                    userTime.setDate(userTime.getDate() + 1);
                    userTime.setHours(workingHours.start, 0, 0, 0);
                } else if (day === 6) { // Saturday -> Monday
                    userTime.setDate(userTime.getDate() + 2);
                    userTime.setHours(workingHours.start, 0, 0, 0);
                }
            }
        }

        // Convert back to UTC
        return new Date(userTime.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    }

    // Distributed locking (preserve existing logic)
    async acquireLock(lockKey, lockValue, ttlSeconds = 30) {
        const result = await this.redis.set(lockKey, lockValue, 'PX', ttlSeconds * 1000, 'NX');
        return result === 'OK';
    }

    async releaseLock(lockKey, lockValue) {
        const lockScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        return await this.redis.eval(lockScript, 1, lockKey, lockValue);
    }

    // Helper methods
    getActionType(action) {
        const actionMap = {
            'send_invitation': 'invitation',
            'send_message': 'message',
            'visit_profile': 'visit',
            'check_connection': 'check',
            'check_replies': 'check'
        };
        return actionMap[action] || 'check';
    }

    getWeekKey(date) {
        const year = date.getFullYear();
        const week = this.getWeekNumber(date);
        return `${year}-W${week.toString().padStart(2, '0')}`;
    }

    getWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    // Connection check delay (preserve existing logic)
    async addConnectionCheckDelay(userId) {
        const connectionDelayKey = `connection_check_delay:${userId}`;
        const lastConnectionCheck = await this.redis.get(connectionDelayKey);

        if (lastConnectionCheck) {
            const timeSinceLastCheck = Date.now() - parseInt(lastConnectionCheck);
            const minDelay = 60 * 1000; // 1 minute minimum between connection checks

            if (timeSinceLastCheck < minDelay) {
                const remainingDelay = minDelay - timeSinceLastCheck;
                await new Promise(resolve => setTimeout(resolve, remainingDelay));
            }
        }

        // Update last connection check time
        await this.redis.set(connectionDelayKey, Date.now(), 'EX', 3600); // Expire after 1 hour
    }

    // Cleanup method
    async disconnect() {
        await this.redis.disconnect();
    }
}

module.exports = new RateLimitService();

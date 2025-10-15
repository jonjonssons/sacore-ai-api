const mongoose = require('mongoose');

const linkedInSessionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    cookies: [{
        name: {
            type: String,
            required: true
        },
        value: {
            type: String,
            required: true
        },
        domain: {
            type: String,
            required: true
        },
        path: {
            type: String,
            default: '/'
        },
        expires: {
            type: Number
        },
        httpOnly: {
            type: Boolean,
            default: false
        },
        secure: {
            type: Boolean,
            default: false
        },
        sameSite: {
            type: String,
            enum: ['Strict', 'Lax', 'None', 'unspecified', 'no_restriction'],
            default: 'Lax'
        }
    }],
    userAgent: {
        type: String,
        required: true
    },
    lastSync: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    },
    sessionMetadata: {
        url: String,
        timestamp: Number,
        isLinkedInPage: Boolean,
        cookieCount: Number,
        sessionId: String,
        csrfToken: String
    },

    // Current user's own profile URN (for messaging API)
    userProfileUrn: {
        type: String,
        default: null,
        index: true
    },

    // Current user's LinkedIn profile URL
    userLinkedInUrl: {
        type: String,
        default: null,
        index: true
    },

    // Track session health
    lastHealthCheck: {
        type: Date
    },
    isHealthy: {
        type: Boolean,
        default: true
    },
    healthCheckErrors: [{
        error: String,
        timestamp: {
            type: Date,
            default: Date.now
        }
    }],

    // Usage statistics
    stats: {
        messagesSent: {
            type: Number,
            default: 0
        },
        invitationsSent: {
            type: Number,
            default: 0
        },
        profilesVisited: {
            type: Number,
            default: 0
        },
        totalActions: {
            type: Number,
            default: 0
        }
    },

    // Rate limiting data
    rateLimiting: {
        lastActionTime: Date,
        actionsToday: {
            type: Number,
            default: 0
        },
        actionsThisHour: {
            type: Number,
            default: 0
        },
        dailyResetTime: Date,
        hourlyResetTime: Date
    },

    // Background tab profile visit queues
    pendingVisits: [{
        profileUrl: {
            type: String,
            required: true
        },
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        visitId: {
            type: String,
            required: true
        },
        queuedAt: {
            type: Date,
            default: Date.now
        },
        status: {
            type: String,
            enum: ['queued', 'processing', 'completed', 'failed'],
            default: 'queued'
        },
        method: {
            type: String,
            default: 'background_tab'
        },
        priority: {
            type: Number,
            default: 1
        },
        retryCount: {
            type: Number,
            default: 0
        },
        maxRetries: {
            type: Number,
            default: 3
        }
    }],

    // Background tab invitation queues
    pendingInvitations: [{
        invitationId: {
            type: String,
            required: true
        },
        profileUrl: {
            type: String,
            required: true
        },
        message: {
            type: String,
            default: ''
        },
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        prospectId: {
            type: mongoose.Schema.Types.ObjectId
        },
        requestedAt: {
            type: Date,
            default: Date.now
        },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed'],
            default: 'pending'
        },
        priority: {
            type: Number,
            default: 1
        },
        retryCount: {
            type: Number,
            default: 0
        },
        maxRetries: {
            type: Number,
            default: 3
        }
    }],

    // Background tab message queues
    pendingMessages: [{
        messageId: {
            type: String,
            required: true
        },
        profileUrl: {
            type: String,
            required: true
        },
        message: {
            type: String,
            required: true
        },
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        prospectId: {
            type: mongoose.Schema.Types.ObjectId
        },
        requestedAt: {
            type: Date,
            default: Date.now
        },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed'],
            default: 'pending'
        },
        priority: {
            type: Number,
            default: 1
        },
        retryCount: {
            type: Number,
            default: 0
        },
        maxRetries: {
            type: Number,
            default: 3
        }
    }],

    completedMessages: [{
        messageId: String,
        profileUrl: {
            type: String,
            required: true
        },
        profileName: String,
        message: String,
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        prospectId: {
            type: mongoose.Schema.Types.ObjectId
        },
        completedAt: {
            type: Date,
            default: Date.now
        },
        success: {
            type: Boolean,
            default: true
        },
        method: {
            type: String,
            enum: ['background_tab_message', 'manual_message'],
            default: 'background_tab_message'
        },
        tabId: Number,
        userAgent: String,
        error: String
    }],

    completedInvitations: [{
        invitationId: String,
        profileUrl: {
            type: String,
            required: true
        },
        profileName: String,
        message: String,
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        prospectId: {
            type: mongoose.Schema.Types.ObjectId
        },
        completedAt: {
            type: Date,
            default: Date.now
        },
        success: {
            type: Boolean,
            default: true
        },
        method: {
            type: String,
            enum: ['background_tab_invitation', 'manual_invitation', 'dropdown'],
            default: 'background_tab_invitation'
        },
        tabId: Number,
        userAgent: String,
        error: String
    }],

    completedVisits: [{
        profileUrl: {
            type: String,
            required: true
        },
        profileName: String,
        visitId: String,
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        completedAt: {
            type: Date,
            default: Date.now
        },
        visitDuration: Number, // in milliseconds
        method: {
            type: String,
            enum: ['background_tab_visit', 'http_visit', 'manual_visit'],
            default: 'background_tab_visit'
        },
        success: {
            type: Boolean,
            default: true
        },
        profileData: {
            name: String,
            title: String,
            company: String,
            location: String,
            profileId: String,
            isValidProfile: Boolean,
            indicators: [String],
            extractedAt: Date
        },
        tabId: Number,
        userAgent: String
    }],

    failedVisits: [{
        profileUrl: {
            type: String,
            required: true
        },
        visitId: String,
        campaignId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Campaign'
        },
        failedAt: {
            type: Date,
            default: Date.now
        },
        error: String,
        method: String,
        retryCount: {
            type: Number,
            default: 0
        },
        tabId: Number
    }]
}, {
    timestamps: true
});

// Indexes for performance
linkedInSessionSchema.index({ userId: 1 });
linkedInSessionSchema.index({ isActive: 1 });
linkedInSessionSchema.index({ lastSync: 1 });
linkedInSessionSchema.index({ 'rateLimiting.dailyResetTime': 1 });
linkedInSessionSchema.index({ userProfileUrn: 1 });
linkedInSessionSchema.index({ userLinkedInUrl: 1 });

// Virtual for session age
linkedInSessionSchema.virtual('sessionAge').get(function () {
    return Date.now() - this.lastSync.getTime();
});

// Virtual for session validity (24 hours)
linkedInSessionSchema.virtual('isValid').get(function () {
    const twentyFourHours = 24 * 60 * 60 * 1000;
    return this.sessionAge < twentyFourHours;
});

// Method to update session health
linkedInSessionSchema.methods.updateHealth = function (isHealthy, error = null) {
    this.isHealthy = isHealthy;
    this.lastHealthCheck = new Date();

    if (!isHealthy && error) {
        this.healthCheckErrors.push({
            error: error,
            timestamp: new Date()
        });

        // Keep only last 10 errors
        if (this.healthCheckErrors.length > 10) {
            this.healthCheckErrors = this.healthCheckErrors.slice(-10);
        }
    }

    return this.save();
};

// Method to increment action counters
linkedInSessionSchema.methods.incrementAction = function (actionType) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());

    // Reset daily counter if it's a new day
    if (!this.rateLimiting.dailyResetTime || this.rateLimiting.dailyResetTime < today) {
        this.rateLimiting.actionsToday = 0;
        this.rateLimiting.dailyResetTime = today;
    }

    // Reset hourly counter if it's a new hour
    if (!this.rateLimiting.hourlyResetTime || this.rateLimiting.hourlyResetTime < thisHour) {
        this.rateLimiting.actionsThisHour = 0;
        this.rateLimiting.hourlyResetTime = thisHour;
    }

    // Increment counters
    this.rateLimiting.actionsToday++;
    this.rateLimiting.actionsThisHour++;
    this.rateLimiting.lastActionTime = now;
    this.stats.totalActions++;

    // Increment specific action type
    if (actionType === 'message') {
        this.stats.messagesSent++;
    } else if (actionType === 'invitation') {
        this.stats.invitationsSent++;
    } else if (actionType === 'profile_visit') {
        this.stats.profilesVisited++;
    }

    return this.save();
};

// Method to check rate limits
linkedInSessionSchema.methods.canPerformAction = function () {
    const now = new Date();

    // Check if session is still valid
    if (!this.isValid) {
        return { allowed: false, reason: 'Session expired' };
    }

    // Check if session is healthy
    if (!this.isHealthy) {
        return { allowed: false, reason: 'Session unhealthy' };
    }

    // Check daily limits (conservative limits to avoid LinkedIn restrictions)
    const dailyLimit = 100; // Conservative daily limit
    if (this.rateLimiting.actionsToday >= dailyLimit) {
        return { allowed: false, reason: 'Daily limit reached' };
    }

    // Check hourly limits
    const hourlyLimit = 10; // Conservative hourly limit
    if (this.rateLimiting.actionsThisHour >= hourlyLimit) {
        return { allowed: false, reason: 'Hourly limit reached' };
    }

    // Check minimum delay between actions (30 seconds)
    if (this.rateLimiting.lastActionTime) {
        const timeSinceLastAction = now - this.rateLimiting.lastActionTime;
        const minimumDelay = 30 * 1000; // 30 seconds

        if (timeSinceLastAction < minimumDelay) {
            const waitTime = minimumDelay - timeSinceLastAction;
            return {
                allowed: false,
                reason: 'Rate limited',
                waitTime: Math.ceil(waitTime / 1000)
            };
        }
    }

    return { allowed: true };
};

// Static method to find valid session for user
linkedInSessionSchema.statics.findValidSession = function (userId) {
    return this.findOne({
        userId: userId,
        isActive: true,
        isHealthy: true,
        lastSync: {
            $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Within last 24 hours
        }
    });
};

// Static method to cleanup old sessions
linkedInSessionSchema.statics.cleanupOldSessions = function () {
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);

    return this.updateMany(
        {
            lastSync: { $lt: seventyTwoHoursAgo },
            isActive: true
        },
        {
            $set: { isActive: false }
        }
    );
};

// Pre-save middleware to update session metadata
linkedInSessionSchema.pre('save', function (next) {
    if (this.isModified('cookies')) {
        this.sessionMetadata.cookieCount = this.cookies.length;

        // Extract session ID from li_at cookie
        const liAtCookie = this.cookies.find(c => c.name === 'li_at');
        if (liAtCookie) {
            this.sessionMetadata.sessionId = liAtCookie.value.substring(0, 10) + '...';
        }
    }

    next();
});

module.exports = mongoose.model('LinkedInSession', linkedInSessionSchema); 
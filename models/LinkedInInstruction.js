const mongoose = require('mongoose');

const linkedInInstructionSchema = new mongoose.Schema({
    // User and campaign context
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Campaign',
        required: true,
        index: true
    },
    prospectId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    executionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CampaignExecution',
        required: true,
        index: true
    },

    // Instruction details
    action: {
        type: String,
        enum: ['send_invitation', 'send_message', 'check_replies', 'visit_profile', 'check_connection'],
        required: true,
        index: true
    },

    // Target information (NO sensitive data)
    profileUrl: {
        type: String,
        required: true
    },
    profileId: String, // LinkedIn profile ID if available
    conversationId: String, // For messages
    conversationUrn: String, // LinkedIn conversation URN from message response

    // Instruction content
    message: String,
    customNote: String, // For invitations

    // Scheduling and timing (preserve all existing logic)
    scheduledFor: {
        type: Date,
        required: true,
        index: true
    },
    timezone: {
        type: String,
        default: 'UTC'
    },
    workingHoursOnly: {
        type: Boolean,
        default: true
    },
    weekendsEnabled: {
        type: Boolean,
        default: false
    },

    // Rate limiting context
    rateLimitContext: {
        hourlyLimit: { type: Number, default: 25 },
        dailyLimit: { type: Number, default: 100 },
        weeklyLimit: { type: Number, default: 500 },
        actionType: { type: String, enum: ['invitation', 'message', 'visit', 'check'] }
    },

    // Status tracking
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'throttled'],
        default: 'pending',
        index: true
    },

    // Execution tracking
    sentToExtensionAt: Date,
    processingStartedAt: Date,
    completedAt: Date,

    // Results (NO sensitive data from LinkedIn)
    result: {
        success: Boolean,
        error: String,
        linkedinStatus: Number, // HTTP status code
        throttled: Boolean,
        retryAfter: Date,
        executionDuration: Number, // milliseconds
        // Connection check specific fields
        connectionStatus: String,
        status: String,
        isConnected: Boolean,
        invitationAccepted: Boolean,
        invitationPending: Boolean,
        profileUsername: String,
        method: String,
        // Message sending fields
        conversationUrn: String,  // ← Add this
        messageId: String,        // ← Add this
        // Reply check fields
        hasReplies: Boolean,
        replyCount: Number,
        lastReplyDate: Date
    },

    // Retry logic
    attempts: {
        type: Number,
        default: 0
    },
    maxAttempts: {
        type: Number,
        default: 3
    },
    lastAttemptAt: Date,
    nextRetryAt: Date,

    // Campaign flow context
    nodeId: String, // Campaign sequence node ID
    nextNodeId: String, // Next step in sequence

    // Working hours settings (from campaign)
    workingHours: {
        enabled: { type: Boolean, default: true },
        start: { type: Number, default: 9 },
        end: { type: Number, default: 18 },
        timezone: { type: String, default: 'UTC' },
        weekendsEnabled: { type: Boolean, default: false }
    }
}, {
    timestamps: true
});

// Indexes for efficient querying
linkedInInstructionSchema.index({ userId: 1, status: 1, scheduledFor: 1 });
linkedInInstructionSchema.index({ campaignId: 1, status: 1 });
linkedInInstructionSchema.index({ status: 1, scheduledFor: 1 });
linkedInInstructionSchema.index({ userId: 1, action: 1, completedAt: 1 }); // For rate limiting

// Static methods
linkedInInstructionSchema.statics.getPendingInstructions = function (userId, limit = 10) {
    const now = new Date();

    return this.find({
        userId: userId,
        status: 'pending',
        scheduledFor: { $lte: now }
    })
        .sort({ scheduledFor: 1, createdAt: 1 })
        .limit(limit);
};

linkedInInstructionSchema.statics.getUserRateLimitCounts = function (userId, action, timeframe = 'hour') {
    const now = new Date();
    let startTime;

    switch (timeframe) {
        case 'hour':
            startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
            break;
        case 'day':
            startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
        case 'week':
            const dayOfWeek = now.getDay();
            startTime = new Date(now.getTime() - (dayOfWeek * 24 * 60 * 60 * 1000));
            startTime.setHours(0, 0, 0, 0);
            break;
        default:
            startTime = new Date(now.getTime() - (60 * 60 * 1000)); // 1 hour ago
    }

    return this.countDocuments({
        userId: userId,
        action: action,
        status: 'completed',
        completedAt: { $gte: startTime, $lte: now }
    });
};

// Instance methods
linkedInInstructionSchema.methods.markAsProcessing = function () {
    this.status = 'processing';
    this.processingStartedAt = new Date();
    this.sentToExtensionAt = new Date();
    return this.save();
};

linkedInInstructionSchema.methods.markAsCompleted = function (result) {
    this.status = result.success ? 'completed' : 'failed';
    this.completedAt = new Date();
    this.result = result;

    if (result.executionDuration) {
        this.result.executionDuration = result.executionDuration;
    }

    return this.save();
};

linkedInInstructionSchema.methods.markAsThrottled = function (retryAfter) {
    this.status = 'throttled';
    this.result = {
        success: false,
        error: 'LinkedIn throttling detected',
        throttled: true,
        retryAfter: retryAfter
    };
    this.nextRetryAt = retryAfter;
    return this.save();
};

linkedInInstructionSchema.methods.scheduleRetry = function (delayMinutes = 30) {
    this.attempts += 1;
    this.lastAttemptAt = new Date();
    this.nextRetryAt = new Date(Date.now() + (delayMinutes * 60 * 1000));
    this.status = 'pending';
    this.scheduledFor = this.nextRetryAt;
    return this.save();
};

linkedInInstructionSchema.methods.canRetry = function () {
    return this.attempts < this.maxAttempts &&
        ['failed', 'throttled'].includes(this.status);
};

module.exports = mongoose.model('LinkedInInstruction', linkedInInstructionSchema);

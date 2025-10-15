const mongoose = require('mongoose');

// Prospect sub-schema
const prospectSchema = new mongoose.Schema({
    name: String,
    email: String,
    company: String,
    position: String,
    linkedin: String,
    phone: String,
    customFields: mongoose.Schema.Types.Mixed,
    status: {
        type: String,
        enum: [
            'pending', 'contacted', 'visited', 'replied', 'bounced', 'unsubscribed', 'manual_action_required',
            'linkedin_invitation_sent', 'linkedin_invitation_failed', 'linkedin_invitation_queued', 'linkedin_connected', 'active',
            'linkedin_message_sent', 'linkedin_message_failed', 'linkedin_message_queued'
        ],
        default: 'pending'
    },
    lastContacted: Date
}, {
    timestamps: true
});

// Flow Node sub-schema
const flowNodeSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true
    },
    stepType: {
        type: String,
        enum: [
            'email', 'linkedin-message', 'linkedin-invitation',
            'linkedin-visit', 'manual-task', 'linkedin-accepted',
            'linkedin-opened', 'email-opened', 'email-clicked',
            'email-unsubscribed', 'email-reply', 'has-email',
            'has-linkedin', 'has-phone', 'linkedin-connection-check', 'linkedin-reply-check', 'custom-condition'
        ],
        required: true
    },
    x: Number,
    y: Number,
    parentId: String,
    parentBranch: {
        type: String,
        enum: ['main', 'yes', 'no']
    },
    content: {
        subject: String,
        message: String,
        emailAddresses: [String],
        linkedinAccount: String,
        taskDescription: String,
        taskTitle: String,        // For manual tasks
        priority: {               // For manual tasks
            type: String,
            enum: ['low', 'medium', 'high'],
            default: 'medium'
        },
        dueDate: Date,           // For manual tasks - specific date
        dueDays: Number,         // For manual tasks - relative days
        delay: Number,
        delayUnit: {
            type: String,
            enum: ['minutes', 'hours', 'days'],
            default: 'days'
        },
        attachments: [{
            name: String,
            size: Number,
            type: String,
            category: {
                type: String,
                enum: ['image', 'document']
            },
            url: String
        }],
        variables: [String]
    }
});

// Main Campaign schema
const campaignSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    name: {
        type: String,
        required: [true, 'Campaign name is required'],
        maxlength: 100
    },
    description: {
        type: String,
        maxlength: 500
    },
    status: {
        type: String,
        enum: ['draft', 'active', 'paused', 'completed'],
        default: 'draft'
    },
    prospects: [prospectSchema],
    sequence: [flowNodeSchema],
    emailAccountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ConnectedAccount',
        default: null
    },
    stats: {
        totalProspects: { type: Number, default: 0 },
        emailsSent: { type: Number, default: 0 },
        openRate: { type: Number, default: 0 },
        replyRate: { type: Number, default: 0 },
        clickRate: { type: Number, default: 0 },
        // LinkedIn-specific stats
        linkedinInvitationsQueued: { type: Number, default: 0 },
        linkedinInvitationsSent: { type: Number, default: 0 },
        linkedinInvitationsSkipped: { type: Number, default: 0 },
        linkedinMessagesSent: { type: Number, default: 0 },
        linkedinProfilesVisited: { type: Number, default: 0 }
    },
    // Campaign-specific LinkedIn settings (overrides global settings if provided)
    linkedinSettings: {
        delaySettings: {
            invitations: {
                minDelay: { type: Number, default: 900000 }, // 15 minutes in milliseconds
                maxDelay: { type: Number, default: 1800000 }, // 30 minutes in milliseconds
                unit: { type: String, enum: ['seconds', 'minutes'], default: 'minutes' }
            },
            messages: {
                minDelay: { type: Number, default: 120000 }, // 2 minutes in milliseconds
                maxDelay: { type: Number, default: 300000 }, // 5 minutes in milliseconds
                unit: { type: String, enum: ['seconds', 'minutes'], default: 'minutes' }
            }
        },
        workingHours: {
            enabled: { type: Boolean, default: true },
            start: { type: Number, default: 9 },    // 9 AM
            end: { type: Number, default: 18 },     // 6 PM
            timezone: {
                type: String,
                default: 'UTC',
                validate: {
                    validator: function (v) {
                        const timezones = require('../config/timezones');
                        return timezones.isValidTimezone(v);
                    },
                    message: props => `${props.value} is not a valid IANA timezone!`
                }
            },
            weekendsEnabled: { type: Boolean, default: false }
        },
        safetyPreset: {
            type: String,
            enum: ['conservative', 'balanced', 'aggressive', 'custom'],
            default: 'balanced'
        }
    },
    // Campaign editing tracking
    pausedAt: Date,
    lastResumed: Date,
    lastEdited: Date,
    editHistory: [{
        timestamp: { type: Date, default: Date.now },
        userId: String,
        changes: [String],
        sequenceChanged: Boolean,
        prospectsChanged: Boolean,
        originalProspectCount: Number,
        originalSequenceLength: Number,
        sequenceChangeResult: mongoose.Schema.Types.Mixed,
        prospectChangeResult: mongoose.Schema.Types.Mixed
    }],
    // Auto-pause/resume tracking
    pauseReason: {
        type: String,
        enum: ['manual', 'extension_offline', 'rate_limit', 'error'],
        default: 'manual'
    },
    autoresumeWhenOnline: {
        type: Boolean,
        default: false
    },
    resumedAt: Date
}, {
    timestamps: true
});

// Update stats before saving
campaignSchema.pre('save', function () {
    this.stats.totalProspects = this.prospects.length;
    this.updatedAt = new Date();
});

module.exports = mongoose.model('Campaign', campaignSchema);
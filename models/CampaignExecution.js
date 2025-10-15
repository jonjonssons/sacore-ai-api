const mongoose = require('mongoose');

// Track individual prospect journey through campaign
const campaignExecutionSchema = new mongoose.Schema({
    campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Campaign',
        required: true
    },
    prospectId: {
        type: String, // This is the prospect's _id within the campaign's prospects array
        required: true
    },
    currentNodeId: String,
    status: {
        type: String,
        enum: ['running', 'paused', 'completed', 'failed', 'waiting', 'paused_for_manual_task'],
        default: 'running'
    },
    executionHistory: [{
        nodeId: String,
        action: String, // System action: 'paused', 'resumed', 'resumed_with_retry', etc.
        executedAt: {
            type: Date,
            default: Date.now
        },
        timestamp: Date, // Alternative timestamp field for system events
        status: {
            type: String,
            enum: ['success', 'failed', 'pending', 'skipped', 'completed', 'paused', 'running']
        },
        result: mongoose.Schema.Types.Mixed,
        reason: String, // Reason for pause/resume/action
        nextNodeId: String,
        errorMessage: String,
        completedAt: Date // Used for duration calculation
    }],
    scheduledActions: [{
        nodeId: String,
        scheduledFor: Date,
        actionType: String,
        processed: {
            type: Boolean,
            default: false
        }
    }],
    waitingFor: {
        type: String,
        enum: [
            'email-open', 'email-click', 'linkedin-accept', 'linkedin-reply',
            'manual-task', 'linkedin-invitation-completion', 'linkedin-message-completion',
            'linkedin-visit-completion', 'custom-action-completion'
        ]
    },
    waitingJobId: {
        type: String,
        default: null
    },
    lastActivity: Date,
    // Pause/Resume tracking
    pausedAt: Date,
    pauseReason: String, // Reason for pause: 'manual', 'extension_offline', etc.
    pausedFromManualTask: { type: Boolean, default: false }
}, {
    timestamps: true
});

// Compound index for efficient querying
campaignExecutionSchema.index({ campaignId: 1, prospectId: 1 }, { unique: true });
campaignExecutionSchema.index({ 'scheduledActions.scheduledFor': 1 });
campaignExecutionSchema.index({ waitingFor: 1, waitingJobId: 1 }); // New index for job completion queries

module.exports = mongoose.model('CampaignExecution', campaignExecutionSchema);
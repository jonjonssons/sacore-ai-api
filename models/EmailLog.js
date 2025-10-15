const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema({
    prospectId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    gmailMessageId: {
        type: String,
        required: true,
        index: true
    },
    gmailThreadId: {
        type: String,
        required: true,
        index: true
    },
    customMessageId: {
        type: String,
        required: true
    },
    subject: String,
    isFirstInSequence: {
        type: Boolean,
        default: false,
        index: true
    },
    sentAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    openCount: { type: Number, default: 0, index: true },
    lastOpenedAt: { type: Date },
    openToken: { type: String, index: true },
    // Reply tracking fields
    replyCount: { type: Number, default: 0, index: true },
    lastReplyAt: { type: Date },
    replyMessageIds: [{ type: String }],
    hasReply: { type: Boolean, default: false, index: true }
}, {
    timestamps: true
});

// Compound indexes for efficient queries
emailLogSchema.index({ prospectId: 1, campaignId: 1, sentAt: 1 });
emailLogSchema.index({ prospectId: 1, campaignId: 1, isFirstInSequence: 1 });
emailLogSchema.index({ openToken: 1 });
emailLogSchema.index({ prospectId: 1, campaignId: 1, hasReply: 1 });

module.exports = mongoose.model('EmailLog', emailLogSchema); 
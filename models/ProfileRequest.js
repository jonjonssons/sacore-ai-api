// models/ProfileRequest.js
const mongoose = require('mongoose');

const ProfileRequestSchema = new mongoose.Schema({
    requestId: { type: String, required: true },
    profileId: { type: String },
    linkedinUrl: { type: String },
    status: { type: String, default: 'pending' },  // pending, success, failed
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Add a compound index on requestId and linkedinUrl

ProfileRequestSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

ProfileRequestSchema.pre('save', function (next) {
    if (this.linkedinUrl) {
        const parsed = new URL(this.linkedinUrl);
        const pathname = parsed.pathname.replace(/\/+$/, '');
        this.linkedinUrl = `https://www.linkedin.com${pathname}`;
    }
    next();
});


module.exports = mongoose.model('ProfileRequest', ProfileRequestSchema);

const mongoose = require('mongoose');

const SavedProfileSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    linkedinUrl: { 
        type: String, 
        required: true 
    },
    profileData: { 
        type: mongoose.Schema.Types.Mixed, 
        required: true 
    },
    notes: { 
        type: String, 
        default: '' 
    },
    tags: [{ 
        type: String 
    }],
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Update the updatedAt field on save
SavedProfileSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

// Normalize LinkedIn URL on save
SavedProfileSchema.pre('save', function (next) {
    if (this.linkedinUrl) {
        try {
            const parsed = new URL(this.linkedinUrl);
            const pathname = parsed.pathname.replace(/\/+$/, '');
            this.linkedinUrl = `https://www.linkedin.com${pathname}`;
        } catch (error) {
            // If URL parsing fails, keep the original URL
        }
    }
    next();
});

module.exports = mongoose.model('SavedProfile', SavedProfileSchema);
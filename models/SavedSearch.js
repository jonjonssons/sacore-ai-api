const mongoose = require('mongoose');

const savedSearchSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    searchQuery: {
        type: String,
        required: true
    },
    searchCriteria: {
        title: String,
        location: String,
        industry: String,
        experience: String,
        companySize: String,
        specificRequirements: [String]
    },
    sourceInclusions: {
        includeSignalHire: { type: Boolean, default: false },
        includeBrave: { type: Boolean, default: false },
        includeGoogle: { type: Boolean, default: false },
        includeContactOut: { type: Boolean, default: false },
        includeIcypeas: { type: Boolean, default: false },
        includeCsvImport: { type: Boolean, default: false }
    },
    totalProfilesFound: {
        type: Number,
        default: 0
    },
    csvFileInfo: {
        filename: String,
        originalName: String,
        size: Number,
        profilesImported: Number
    },
    searchMetadata: {
        duration: Number, // in milliseconds
        creditsUsed: Number,
        apiCallsCount: Number,
        errorCount: Number
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: { expireAfterSeconds: 86400 } // Auto-delete after 24 hours
    }
}, {
    timestamps: true
});

// Additional indexes for performance
savedSearchSchema.index({ userId: 1, createdAt: -1 });
savedSearchSchema.index({ searchQuery: 1 });

module.exports = mongoose.model('SavedSearch', savedSearchSchema);
const mongoose = require('mongoose');

const searchProfileSchema = new mongoose.Schema({
    searchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SavedSearch',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // 🚀 ULTRA-SIMPLE: Store entire profile data as-is from finalResults
    rawProfileData: {
        type: mongoose.Schema.Types.Mixed,  // Accepts any JSON structure
        required: true  // This is the main storage - everything else is optional
    },

    // Basic Profile Information (extracted for indexing/searching)
    firstName: String,
    lastName: String,
    fullName: {
        type: String,
        required: false,  // Made optional since we have rawProfileData
        default: 'Unknown'
    },
    title: {
        type: String,
        required: false,  // Made optional since we have rawProfileData
        default: 'Unknown Title'
    },
    company: {
        type: String,
        required: false,  // Made optional since we have rawProfileData
        default: 'Unknown Company'
    },
    location: {
        type: String,
        required: false,  // Made optional since we have rawProfileData
        default: 'Unknown Location'
    },

    // LinkedIn Information
    linkedinUrl: String,
    linkedinUrlStatus: {
        type: String,
        enum: ['success', 'no_url_found', 'failed', 'pending'],
        default: 'pending'
    },
    linkedinUrlFetchedAt: Date,
    linkedinUrlCreditsUsed: Number,

    // Email Information
    emailAddress: String,
    emailFetchStatus: {
        type: String,
        enum: ['success', 'failed', 'pending', 'not_attempted'],
        default: 'not_attempted'
    },
    emailFetchedAt: Date,
    emailCreditsUsed: Number,

    // Extracted Data from Search
    extractedTitle: String,
    extractedCompany: String,
    extractedLocation: String,
    extractedIndustry: String,

    // Relevance and Matching
    relevanceScore: mongoose.Schema.Types.Mixed, // Can be number or string like "3/3"
    originalRelevanceScore: Number,
    matchedCategories: {
        type: Map,
        of: [String]
    },
    matchedCategoriesValue: {
        matched: Number,
        total: Number,
        details: {
            type: Map,
            of: [String]
        }
    },

    // Source Information
    source: {
        type: String,
        enum: ['google', 'brave', 'signalhire', 'contactout', 'icypeas', 'csv', 'csv_import', 'csv_processing'],
        required: true
    },
    sourceBoost: {
        type: Number,
        default: 0
    },

    // Raw API Response Data
    originalApiResponse: {
        title: String,
        link: String,
        snippet: String,
        formattedUrl: String,
        pagemap: Object,
        query: String,
        page: Number
    },

    // SignalHire Data
    signalHireData: {
        uid: String,
        fullName: String,
        location: String,
        experience: [{
            company: String,
            title: String,
            startDate: String,
            endDate: String,
            description: String
        }],
        skills: [String],
        contactsFetched: Object,
        profileUrl: String,
        imageUrl: String
    },

    // ContactOut Data
    contactOutData: Object,

    // IcyPeas Data
    icypeasData: Object,

    // CSV Data
    csvData: Object,

    // Enriched Data (Additional enrichment information)
    enrichedData: {
        type: Object,
        default: {}
    },

    // Deep Analysis Data
    analysisScore: mongoose.Schema.Types.Mixed, // Can be number or string like "2/3"
    analysisDescription: String,
    analysisBreakdown: [{
        criterion: String,
        met: Boolean,
        score: Number,
        explanation: String
    }],
    analysisCreditsUsed: Number,
    analyzedAt: Date,

    // Profile Evaluation Status
    profileEvaluation: {
        status: {
            type: String,
            enum: ['pending', 'analyzed', 'enriched', 'completed', 'failed'],
            default: 'pending'
        },
        lastUpdated: Date
    },

    // Additional Profile Data
    experienceLevel: {
        type: String,
        enum: ['entry', 'junior', 'mid', 'senior', 'executive']
    },
    companySize: {
        type: String,
        enum: ['startup', 'smallBusiness', 'midMarket', 'enterprise', 'fortune500']
    },
    industry: String,

    // Enrichment History
    enrichmentHistory: [{
        action: {
            type: String,
            enum: ['email_fetch', 'linkedin_url_fetch', 'deep_analysis', 'profile_enrichment']
        },
        status: {
            type: String,
            enum: ['success', 'failed', 'pending']
        },
        creditsUsed: Number,
        timestamp: Date,
        requestId: String,
        errorMessage: String,
        responseData: Object
    }],

    // User Actions
    isSaved: {
        type: Boolean,
        default: false
    },
    savedAt: Date,
    savedToProjectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project'
    },

    createdAt: {
        type: Date,
        default: Date.now,
        index: { expireAfterSeconds: 86400 } // Auto-delete after 24 hours
    }
}, {
    timestamps: true
});

// Indexes for performance
searchProfileSchema.index({ userId: 1, createdAt: -1 });
searchProfileSchema.index({ searchId: 1 });
searchProfileSchema.index({ linkedinUrl: 1 });
searchProfileSchema.index({ emailAddress: 1 });
searchProfileSchema.index({ fullName: 1, company: 1 });
searchProfileSchema.index({ source: 1 });

// Normalize LinkedIn URL on save
searchProfileSchema.pre('save', function (next) {
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

module.exports = mongoose.model('SearchProfile', searchProfileSchema);
const mongoose = require('mongoose');

const ProfilesSchema = new mongoose.Schema({
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Projects', required: true },
    name: { type: String },
    title: { type: String },
    company: { type: String },
    location: { type: String },
    linkedinUrl: { type: String },
    uid: { type: String },
    signalhireData: { type: mongoose.Schema.Types.Mixed },
    email: { type: String },
    relevanceScore: { type: String },
    analysis: { type: mongoose.Schema.Types.Mixed },
    matchedCategories: { type: mongoose.Schema.Types.Mixed },
    matchedCategoriesValue: { type: mongoose.Schema.Types.Mixed }
}, {
    timestamps: true
});

// Compound unique index to prevent duplicate profiles in the same project
ProfilesSchema.index({ projectId: 1, linkedinUrl: 1 }, { unique: true });

module.exports = mongoose.model('Profiles', ProfilesSchema);

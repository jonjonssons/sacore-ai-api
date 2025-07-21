const mongoose = require('mongoose');

const ProfilesSchema = new mongoose.Schema({
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Projects', required: true },
    name: { type: String },
    title: { type: String },
    company: { type: String },
    location: { type: String },
    linkedinUrl: { type: String },
    email: { type: String },
    relevanceScore: { type: String },
    analysis: { type: mongoose.Schema.Types.Mixed },
    matchedCategories: { type: mongoose.Schema.Types.Mixed },
    matchedCategoriesValue: { type: mongoose.Schema.Types.Mixed }
}, {
    timestamps: true
});

module.exports = mongoose.model('Profiles', ProfilesSchema);

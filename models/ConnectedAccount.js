const mongoose = require('mongoose');
const timezones = require('../config/timezones');

const connectedAccountSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: ['email', 'linkedin'],
        required: true
    },
    provider: {
        type: String,
        enum: ['gmail', 'outlook', 'yahoo', 'linkedin'],
        required: true
    },
    email: String,
    displayName: String,
    profileUrl: String,
    profilePicture: String,
    isDefault: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true
    },

    // OAuth tokens (should be encrypted in production)
    accessToken: String,
    refreshToken: String,
    tokenExpires: Date,

    lastSync: Date,

    // LinkedIn cookie-based session support
    cookies: mongoose.Schema.Types.Mixed, // Array of cookie objects
    userAgent: String,
    viewport: mongoose.Schema.Types.Mixed, // { width, height, deviceScaleFactor, isMobile }
    timezone: {
        type: String,
        validate: {
            validator: function (v) {
                // Allow null/undefined values, but validate if provided
                return !v || timezones.isValidTimezone(v);
            },
            message: props => `${props.value} is not a valid IANA timezone!`
        }
    },
    locale: String,
    proxy: mongoose.Schema.Types.Mixed, // { host, port, username, password }
    cookieUpdatedAt: Date,
    deviceId: String
}, {
    timestamps: true
});

// Ensure only one default account per type per user
connectedAccountSchema.pre('save', async function () {
    if (this.isDefault && this.isModified('isDefault')) {
        await this.constructor.updateMany(
            {
                userId: this.userId,
                type: this.type,
                _id: { $ne: this._id }
            },
            { isDefault: false }
        );
    }
});

module.exports = mongoose.model('ConnectedAccount', connectedAccountSchema);
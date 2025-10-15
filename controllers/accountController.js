const ConnectedAccount = require('../models/ConnectedAccount');
const { BadRequestError, NotFoundError } = require('../errors');
const { google } = require('googleapis');

// Gmail OAuth configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
);

// Token refresh handler
oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) {
        console.log('📧 New refresh token received');
    }
    if (tokens.access_token) {
        console.log('📧 New access token received');
    }
});

// Function to refresh Gmail access token
async function refreshGmailToken(account) {
    try {
        if (!account.refreshToken) {
            throw new Error('No refresh token available');
        }

        // Set credentials with refresh token
        oauth2Client.setCredentials({
            refresh_token: account.refreshToken
        });

        // Refresh the access token
        const { credentials } = await oauth2Client.refreshAccessToken();

        // Update account with new tokens
        account.accessToken = credentials.access_token;
        if (credentials.refresh_token) {
            account.refreshToken = credentials.refresh_token;
        }
        const expiresIn = credentials.expires_in || 3600;
        account.tokenExpires = new Date(Date.now() + (expiresIn * 1000));
        account.lastTokenRefresh = new Date();

        await account.save();

        console.log('📧 Successfully refreshed Gmail token for:', account.email);
        return true;
    } catch (error) {
        console.error('📧 Failed to refresh Gmail token for:', account.email, error.message);
        return false;
    }
}

// Function to check if token needs refresh
function isTokenExpired(account) {
    if (!account.tokenExpires) return true;

    // Refresh token 5 minutes before expiration
    const refreshThreshold = new Date(account.tokenExpires.getTime() - (5 * 60 * 1000));
    return new Date() >= refreshThreshold;
}

// Function to ensure valid Gmail token
async function ensureValidGmailToken(account) {
    if (isTokenExpired(account)) {
        console.log('📧 Gmail token expired, attempting refresh for:', account.email);
        const refreshed = await refreshGmailToken(account);
        if (!refreshed) {
            throw new Error('Failed to refresh Gmail token');
        }
    }
    return account;
}

// Get connected accounts
exports.getAccounts = async (req, res) => {
    try {
        const userId = req.user.userId;
        const accounts = await ConnectedAccount.find({ userId, isActive: true })
            .sort({ createdAt: -1 });
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Get Gmail OAuth URL
exports.getGmailAuthUrl = async (req, res) => {
    try {
        const scopes = [
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ];

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent',          // Force consent screen
            include_granted_scopes: false, // Don't include previously granted scopes
            state: Date.now().toString()
        });
        console.log('✅ Generated Gmail OAuth URL with scopes:', scopes);
        console.log('🔗 Redirect URI:', process.env.GMAIL_REDIRECT_URI);


        res.json({ authUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Handle Gmail OAuth callback
exports.handleGmailCallback = async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.user.userId;

        console.log('📧 Processing Gmail OAuth callback for user:', userId);
        console.log('📧 OAuth code received:', code ? 'Yes' : 'No');

        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        console.log('📧 Tokens received:', !!tokens.access_token);

        // Get user info
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        console.log('📧 User info retrieved:', userInfo.data.email);

        // Check if account already exists
        const existingAccount = await ConnectedAccount.findOne({
            userId,
            email: userInfo.data.email,
            type: 'email'
        });

        if (existingAccount) {
            // Update existing account
            existingAccount.accessToken = tokens.access_token;
            existingAccount.refreshToken = tokens.refresh_token;
            existingAccount.tokenExpires = new Date(tokens.expiry_date);
            existingAccount.isActive = true;
            await existingAccount.save();

            console.log('📧 Updated existing Gmail account:', userInfo.data.email);

            return res.json({
                message: 'Gmail account updated successfully',
                account: {
                    _id: existingAccount._id,
                    email: existingAccount.email,
                    displayName: existingAccount.displayName,
                    provider: existingAccount.provider,
                    isDefault: existingAccount.isDefault
                }
            });
        }

        // Create new account
        const account = new ConnectedAccount({
            userId,
            type: 'email',
            provider: 'gmail',
            email: userInfo.data.email,
            displayName: userInfo.data.name,
            profilePicture: userInfo.data.picture,
            isDefault: true, // Set as default if it's the first email account
            isActive: true,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpires: new Date(tokens.expiry_date),
            lastSync: new Date()
        });

        await account.save();

        console.log('📧 Created new Gmail account:', userInfo.data.email);

        res.json({
            message: 'Gmail account connected successfully',
            account: {
                _id: account._id,
                email: account.email,
                displayName: account.displayName,
                provider: account.provider,
                isDefault: account.isDefault
            }
        });
    } catch (error) {
        console.error('📧 Gmail OAuth error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get LinkedIn OAuth URL
exports.getLinkedInAuthUrl = async (req, res) => {
    try {
        const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${process.env.LINKEDIN_REDIRECT_URI}&scope=r_liteprofile%20r_emailaddress%20w_member_social`;
        res.json({ authUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Handle LinkedIn OAuth callback
exports.handleLinkedInCallback = async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.user.userId;

        // Exchange code for tokens and get profile info
        const tokens = await exchangeLinkedInCode(code);

        const account = new ConnectedAccount({
            userId,
            type: 'linkedin',
            provider: 'linkedin',
            profileUrl: tokens.profileUrl,
            displayName: tokens.name,
            profilePicture: tokens.picture,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpires: new Date(Date.now() + tokens.expires_in * 1000)
        });

        await account.save();
        res.json({ message: 'LinkedIn account connected successfully', account });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Upload LinkedIn cookies for cookie-based sessions
exports.uploadLinkedInCookies = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { accountId } = req.params;
        const { cookies, userAgent, viewport, timezone, locale, proxy, deviceId } = req.body;

        if (!Array.isArray(cookies) || cookies.length === 0) {
            throw new BadRequestError('Valid cookies array is required');
        }

        const account = await ConnectedAccount.findOne({ _id: accountId, userId, type: 'linkedin' });
        if (!account) {
            throw new NotFoundError('LinkedIn account not found');
        }

        account.cookies = cookies;
        if (userAgent) account.userAgent = userAgent;
        if (viewport) account.viewport = viewport;
        if (timezone) account.timezone = timezone;
        if (locale) account.locale = locale;
        if (proxy) account.proxy = proxy;
        if (deviceId) account.deviceId = deviceId;
        account.cookieUpdatedAt = new Date();

        await account.save();
        res.json({ message: 'LinkedIn cookies updated', accountId: account._id });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Validate LinkedIn cookies by doing a lightweight check (stub - real validation via puppeteer)
exports.validateLinkedInCookies = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { accountId } = req.params;
        const account = await ConnectedAccount.findOne({ _id: accountId, userId, type: 'linkedin' });
        if (!account) throw new NotFoundError('LinkedIn account not found');
        if (!Array.isArray(account.cookies) || account.cookies.length === 0) {
            throw new BadRequestError('No cookies stored for this account');
        }
        // In a follow-up edit, we will attempt a puppeteer feed visit here
        res.json({ valid: true, message: 'Cookies present. Full validation will occur on first use.' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Set default email account
exports.setDefaultEmail = async (req, res) => {
    try {
        const userId = req.user.userId;
        const accountId = req.params.id;

        const account = await ConnectedAccount.findOne({ _id: accountId, userId, type: 'email' });

        if (!account) {
            throw new NotFoundError('Email account not found');
        }

        account.isDefault = true;
        await account.save();

        res.json({ message: 'Default email account updated successfully' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Disconnect account
exports.disconnectAccount = async (req, res) => {
    try {
        const userId = req.user.userId;
        const account = await ConnectedAccount.findOneAndUpdate(
            { _id: req.params.id, userId },
            { isActive: false }
        );

        if (!account) {
            throw new NotFoundError('Account not found');
        }

        res.json({ message: 'Account disconnected successfully' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Get a valid Gmail account with automatic token refresh
exports.getValidGmailAccount = async (userId, accountId = null) => {
    try {
        let account;

        if (accountId) {
            account = await ConnectedAccount.findOne({
                _id: accountId,
                userId,
                type: 'email',
                provider: 'gmail',
                isActive: true
            });
        } else {
            account = await ConnectedAccount.findOne({
                userId,
                type: 'email',
                provider: 'gmail',
                isActive: true
            });
        }

        if (!account) {
            throw new NotFoundError('Gmail account not found');
        }

        // Ensure token is valid
        return await ensureValidGmailToken(account);
    } catch (error) {
        throw error;
    }
};

// Test account connection
exports.testConnection = async (req, res) => {
    try {
        const userId = req.user.userId;
        const account = await ConnectedAccount.findOne({ _id: req.params.id, userId });

        if (!account) {
            throw new NotFoundError('Account not found');
        }

        // Test connection based on account type
        let testResult;
        if (account.type === 'email') {
            // Ensure token is valid before testing
            const validAccount = await ensureValidGmailToken(account);
            testResult = await testEmailConnection(validAccount);
        } else if (account.type === 'linkedin') {
            testResult = await testLinkedInConnection(account);
        }

        res.json({ status: 'success', result: testResult });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

// Background function to refresh all expired Gmail tokens
exports.refreshAllExpiredGmailTokens = async () => {
    try {
        const expiredAccounts = await ConnectedAccount.find({
            type: 'email',
            provider: 'gmail',
            isActive: true,
            $or: [
                { tokenExpires: { $exists: false } },
                { tokenExpires: { $lte: new Date() } }
            ]
        });

        console.log(`📧 Found ${expiredAccounts.length} expired Gmail accounts to refresh`);

        for (const account of expiredAccounts) {
            try {
                await refreshGmailToken(account);
            } catch (error) {
                console.error(`📧 Failed to refresh token for account ${account.email}:`, error.message);
            }
        }

        return { refreshed: expiredAccounts.length };
    } catch (error) {
        console.error('📧 Error refreshing expired Gmail tokens:', error);
        throw error;
    }
};

// Helper functions (implement these based on your OAuth setup)
async function exchangeCodeForTokens(code) {
    // Implement Gmail OAuth token exchange
    return {
        access_token: 'sample_token',
        refresh_token: 'sample_refresh',
        expires_in: 3600,
        email: 'user@gmail.com',
        name: 'User Name'
    };
}

async function exchangeLinkedInCode(code) {
    // Implement LinkedIn OAuth token exchange
    return {
        access_token: 'sample_token',
        refresh_token: 'sample_refresh',
        expires_in: 3600,
        profileUrl: 'https://linkedin.com/in/user',
        name: 'User Name',
        picture: 'https://example.com/picture.jpg'
    };
}

async function testEmailConnection(account) {
    // Test email connection
    return { message: 'Email connection successful' };
}

async function testLinkedInConnection(account) {
    // Test LinkedIn connection
    return { message: 'LinkedIn connection successful' };
}

// Get user's LinkedIn rate limits
exports.getLinkedInRateLimits = async (req, res) => {
    try {
        const userId = req.user.userId;
        const User = require('../models/User');
        const user = await User.findById(userId).select('linkedinRateLimits');

        // Return user's limits or defaults
        const rateLimits = user.linkedinRateLimits || {
            invitations: { hourly: 10, daily: 20, weekly: 80 },
            messages: { hourly: 20, daily: 50, weekly: 200 },
            visits: { hourly: 30, daily: 100, weekly: 400 },
            checks: { hourly: 50, daily: 200, weekly: 800 }
        };

        res.json({
            success: true,
            rateLimits: rateLimits
        });
    } catch (error) {
        console.error('Error fetching LinkedIn rate limits:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Update user's LinkedIn rate limits
exports.updateLinkedInRateLimits = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { rateLimits } = req.body;

        if (!rateLimits) {
            return res.status(400).json({
                success: false,
                error: 'Rate limits data is required'
            });
        }

        // Validate rate limits
        validateRateLimits(rateLimits);

        // Update user
        const User = require('../models/User');
        await User.findByIdAndUpdate(userId, {
            linkedinRateLimits: rateLimits
        });

        res.json({
            success: true,
            message: 'LinkedIn rate limits updated successfully',
            rateLimits: rateLimits
        });

    } catch (error) {
        console.error('Error updating LinkedIn rate limits:', error);
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
};

// Validate rate limits structure and values
function validateRateLimits(rateLimits) {
    const actions = ['invitations', 'messages', 'visits', 'checks'];

    for (const action of actions) {
        if (!rateLimits[action]) {
            continue; // Optional - only validate if provided
        }

        const limits = rateLimits[action];

        // Validate required fields
        if (typeof limits.hourly !== 'number' ||
            typeof limits.daily !== 'number' ||
            typeof limits.weekly !== 'number') {
            throw new Error(`${action}: hourly, daily, and weekly limits must be numbers`);
        }

        // Validate hierarchy: hourly <= daily <= weekly
        if (limits.hourly > limits.daily) {
            throw new Error(`${action}: hourly limit (${limits.hourly}) cannot exceed daily limit (${limits.daily})`);
        }
        if (limits.daily > limits.weekly) {
            throw new Error(`${action}: daily limit (${limits.daily}) cannot exceed weekly limit (${limits.weekly})`);
        }

        // Validate minimum values
        if (limits.hourly < 1 || limits.daily < 1 || limits.weekly < 1) {
            throw new Error(`${action}: all limits must be at least 1`);
        }

        // Validate ranges based on action type
        const ranges = {
            invitations: { hourly: { min: 5, max: 15 }, daily: { min: 10, max: 20 }, weekly: { min: 50, max: 80 } },
            messages: { hourly: { min: 10, max: 30 }, daily: { min: 30, max: 80 }, weekly: { min: 100, max: 300 } },
            visits: { hourly: { min: 20, max: 50 }, daily: { min: 50, max: 150 }, weekly: { min: 200, max: 500 } },
            checks: { hourly: { min: 30, max: 100 }, daily: { min: 100, max: 300 }, weekly: { min: 500, max: 1000 } }
        };

        const range = ranges[action];
        if (range) {
            if (limits.hourly < range.hourly.min || limits.hourly > range.hourly.max) {
                throw new Error(`${action}: hourly limit must be between ${range.hourly.min}-${range.hourly.max}`);
            }
            if (limits.daily < range.daily.min || limits.daily > range.daily.max) {
                throw new Error(`${action}: daily limit must be between ${range.daily.min}-${range.daily.max}`);
            }
            if (limits.weekly < range.weekly.min || limits.weekly > range.weekly.max) {
                throw new Error(`${action}: weekly limit must be between ${range.weekly.min}-${range.weekly.max}`);
            }
        }
    }
}

module.exports = {
    getAccounts: exports.getAccounts,
    getGmailAuthUrl: exports.getGmailAuthUrl,
    handleGmailCallback: exports.handleGmailCallback,
    getLinkedInAuthUrl: exports.getLinkedInAuthUrl,
    handleLinkedInCallback: exports.handleLinkedInCallback,
    uploadLinkedInCookies: exports.uploadLinkedInCookies,
    validateLinkedInCookies: exports.validateLinkedInCookies,
    setDefaultEmail: exports.setDefaultEmail,
    disconnectAccount: exports.disconnectAccount,
    testConnection: exports.testConnection,
    getValidGmailAccount: exports.getValidGmailAccount,
    refreshAllExpiredGmailTokens: exports.refreshAllExpiredGmailTokens,
    getLinkedInRateLimits: exports.getLinkedInRateLimits,
    updateLinkedInRateLimits: exports.updateLinkedInRateLimits
};
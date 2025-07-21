const SavedProfile = require('../models/SavedProfile');
const ProfileRequest = require('../models/ProfileRequest');
const creditService = require('../services/creditService');

const { StatusCodes } = require('http-status-codes');

const normalizeLinkedInUrl = (url) => {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `https://www.linkedin.com${pathname}`;
  } catch (err) {
    return url;
  }
};

// Save a profile from ProfileRequest to SavedProfile
exports.saveProfile = async (req, res) => {
  try {
    // Check if we're saving a single profile or multiple profiles
    const isBulkSave = Array.isArray(req.body.profiles);
    const userId = req.user.userId; // Assuming authentication middleware sets this

    // Handle single profile save
    if (!isBulkSave) {
      let { linkedinUrl } = req.body;

      if (!linkedinUrl) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'LinkedIn URL is required'
        });
      }

      linkedinUrl = normalizeLinkedInUrl(linkedinUrl);

      // Check if profile already exists for this user
      const existingProfile = await SavedProfile.findOne({
        user: userId,
        linkedinUrl
      });

      if (existingProfile) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Profile already saved'
        });
      }

      // Fetch the profile data from ProfileRequest
      const profileRequest = await ProfileRequest.findOne({ linkedinUrl });

      if (!profileRequest || profileRequest.status !== 'success') {
        return res.status(StatusCodes.NOT_FOUND).json({
          error: 'Profile not enriched yet'
        });
      }

      // Create a new saved profile
      const savedProfile = await SavedProfile.create({
        user: userId,
        linkedinUrl,
        profileData: profileRequest.data,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return res.status(StatusCodes.CREATED).json({
        success: true,
        savedProfile
      });
    }

    // Handle multiple profiles save
    const { profiles } = req.body;

    if (!profiles || profiles.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'No profiles provided for bulk save'
      });
    }

    // Normalize URLs and filter invalid ones
    const normalizedProfiles = profiles.map(profile => ({
      ...profile,
      linkedinUrl: normalizeLinkedInUrl(profile.linkedinUrl)
    }));

    const linkedinUrls = normalizedProfiles.map(profile => profile.linkedinUrl);
    if (linkedinUrls.some(url => !url)) {
      return res.status(StatusCodes.BAD_REQUEST).json({ error: 'All profiles must have a valid LinkedIn URL' });
    }

    // Check already saved
    const existingProfiles = await SavedProfile.find({
      user: userId,
      linkedinUrl: { $in: linkedinUrls }
    });
    const existingUrls = existingProfiles.map(profile => profile.linkedinUrl);

    // Filter new URLs
    const newUrls = linkedinUrls.filter(url => !existingUrls.includes(url));

    // Get enriched profile data
    const profileRequests = await ProfileRequest.find({
      linkedinUrl: { $in: newUrls },
      status: 'success'
    });

    const profileDataMap = {};
    profileRequests.forEach(req => {
      profileDataMap[req.linkedinUrl] = req.data;
    });

    // Create new profiles
    const profilesToCreate = newUrls
      .filter(url => profileDataMap[url]) // Only include URLs with available profile data
      .map(url => ({
        user: userId,
        linkedinUrl: url,
        profileData: profileDataMap[url],
        createdAt: new Date(),
        updatedAt: new Date()
      }));

    let savedProfiles = [];
    if (profilesToCreate.length > 0) {
      savedProfiles = await SavedProfile.insertMany(profilesToCreate);
    }

    // Return results
    res.status(StatusCodes.OK).json({
      success: true,
      savedCount: savedProfiles.length,
      alreadySavedCount: existingUrls.length,
      notFoundCount: newUrls.filter(url => !profileDataMap[url]).length,
      savedProfiles
    });
  } catch (error) {
    console.error('Error saving profile(s):', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to save profile(s)',
      details: error.message
    });
  }
};

// Get all saved profiles for a user
exports.getSavedProfiles = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20 } = req.query;

    // Get profiles with pagination
    const savedProfiles = await SavedProfile.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // Get total count for pagination
    const totalProfiles = await SavedProfile.countDocuments({ user: userId });

    res.status(StatusCodes.OK).json({
      savedProfiles,
      totalProfiles,
      totalPages: Math.ceil(totalProfiles / limit),
      currentPage: parseInt(page)
    });
  } catch (error) {
    console.error('Error getting saved profiles:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get saved profiles',
      details: error.message
    });
  }
};

// Delete a saved profile
exports.deleteSavedProfile = async (req, res) => {
  try {
    const { profileId } = req.params;
    const userId = req.user.userId;

    const deletedProfile = await SavedProfile.findOneAndDelete({
      _id: profileId,
      user: userId
    });

    if (!deletedProfile) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: 'Saved profile not found'
      });
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: 'Profile deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting saved profile:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to delete saved profile',
      details: error.message
    });
  }
};

// Update saved profile (add notes or tags)
exports.updateSavedProfile = async (req, res) => {
  try {
    const { profileId } = req.params;
    const { notes, tags } = req.body;
    const userId = req.user.userId;

    const savedProfile = await SavedProfile.findOne({
      _id: profileId,
      user: userId
    });

    if (!savedProfile) {
      return res.status(StatusCodes.NOT_FOUND).json({
        error: 'Saved profile not found'
      });
    }

    // Update fields if provided
    if (notes !== undefined) savedProfile.notes = notes;
    if (tags !== undefined) savedProfile.tags = tags;
    savedProfile.updatedAt = new Date();

    await savedProfile.save();

    res.status(StatusCodes.OK).json({
      success: true,
      savedProfile
    });
  } catch (error) {
    console.error('Error updating saved profile:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to update saved profile',
      details: error.message
    });
  }
};
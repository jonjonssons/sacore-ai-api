const SavedSearch = require('../models/SavedSearch');
const SearchProfile = require('../models/SearchProfile');
const { StatusCodes } = require('http-status-codes');
const { BadRequestError } = require('../errors');

// Save search results (called after profile processing)
const saveSearchResults = async (req, res) => {
    const userId = req.user.userId;
    const {
        searchQuery,
        searchCriteria,
        sourceInclusions,
        profiles,
        searchMetadata,
        csvFileInfo
    } = req.body;

    try {
        // Create the saved search record
        const savedSearch = await SavedSearch.create({
            userId,
            searchQuery,
            searchCriteria,
            sourceInclusions,
            totalProfilesFound: profiles.length,
            csvFileInfo,
            searchMetadata
        });

        console.log(`💾 Created SavedSearch with ID: ${savedSearch._id}`);

        // Save all profiles
        const profilePromises = profiles.map(profileData => {
            // Extract names from fullName if firstName/lastName not provided
            let firstName = profileData.firstName;
            let lastName = profileData.lastName;
            if (!firstName && !lastName && profileData.fullName) {
                const nameParts = profileData.fullName.split(' ');
                firstName = nameParts[0] || '';
                lastName = nameParts.slice(1).join(' ') || '';
            }

            return SearchProfile.create({
                searchId: savedSearch._id,
                userId,
                fullName: profileData.fullName,
                title: profileData.title,
                company: profileData.company,
                location: profileData.location,
                firstName,
                lastName,
                linkedinUrl: profileData.linkedinUrl || profileData.link,
                emailAddress: profileData.emailAddress || profileData.email,
                extractedTitle: profileData.extractedTitle,
                extractedCompany: profileData.extractedCompany,
                extractedLocation: profileData.extractedLocation,
                extractedIndustry: profileData.extractedIndustry,
                relevanceScore: profileData.relevanceScore,
                originalRelevanceScore: profileData.originalRelevanceScore,
                matchedCategories: profileData.matchedCategories,
                matchedCategoriesValue: profileData.matchedCategoriesValue,
                source: profileData.source,
                sourceBoost: profileData.sourceBoost,
                originalApiResponse: profileData.originalApiResponse,
                signalHireData: profileData.signalHireData,
                contactOutData: profileData.contactOutData,
                icypeasData: profileData.icypeasData,
                csvData: profileData.csvData,
                enrichedData: profileData.enrichedData || {}, // Initialize as empty object
                analysisScore: profileData.analysisScore,
                analysisDescription: profileData.analysisDescription,
                analysisBreakdown: profileData.analysisBreakdown,
                analysisCreditsUsed: profileData.analysisCreditsUsed,
                analyzedAt: profileData.analyzedAt,
                profileEvaluation: profileData.profileEvaluation,
                experienceLevel: profileData.experienceLevel,
                companySize: profileData.companySize,
                industry: profileData.industry,
                enrichmentHistory: profileData.enrichmentHistory || [],
                emailFetchStatus: profileData.emailAddress || profileData.email ? 'success' : 'not_attempted',
                linkedinUrlStatus: profileData.linkedinUrl || profileData.link ? 'success' : 'no_url_found',
                emailFetchedAt: profileData.emailAddress || profileData.email ? new Date() : undefined,
                linkedinUrlFetchedAt: profileData.linkedinUrl || profileData.link ? new Date() : undefined
            });
        });

        const savedProfiles = await Promise.allSettled(profilePromises);
        const successfulSaves = savedProfiles.filter(result => result.status === 'fulfilled').length;
        const failedSaves = savedProfiles.filter(result => result.status === 'rejected');

        if (failedSaves.length > 0) {
            console.error(`⚠️ Failed to save ${failedSaves.length} profiles:`, failedSaves.map(f => f.reason?.message || f.reason));
        }

        console.log(`💾 Saved ${successfulSaves}/${profiles.length} profiles to search ${savedSearch._id}`);

        res.status(StatusCodes.CREATED).json({
            success: true,
            message: `Search results saved successfully`,
            data: {
                searchId: savedSearch._id,
                totalProfiles: profiles.length,
                savedProfiles: successfulSaves,
                failedSaves: failedSaves.length
            }
        });

    } catch (error) {
        console.error('Error saving search results:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to save search results',
            error: error.message
        });
    }
};

// Get past 24 hours searches
const getRecentSearches = async (req, res) => {
    const userId = req.user.userId;
    const { limit = 10, offset = 0 } = req.query;

    try {
        const searches = await SavedSearch.find({ userId })
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(offset))
            .lean();

        const totalCount = await SavedSearch.countDocuments({ userId });

        res.status(StatusCodes.OK).json({
            success: true,
            data: {
                searches,
                pagination: {
                    total: totalCount,
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: (parseInt(offset) + parseInt(limit)) < totalCount
                }
            }
        });

    } catch (error) {
        console.error('Error fetching recent searches:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to fetch recent searches',
            error: error.message
        });
    }
};

// Get profiles from a specific search
const getSearchProfiles = async (req, res) => {
    const userId = req.user.userId;
    const { searchId } = req.params;
    const { source, hasEmail } = req.query;

    try {
        // Verify the search belongs to the user
        const search = await SavedSearch.findOne({ _id: searchId, userId });
        if (!search) {
            throw new BadRequestError('Search not found or access denied');
        }

        // Build filter
        const filter = { searchId, userId };
        if (source) {
            filter.source = source;
        }
        if (hasEmail === 'true') {
            filter.emailAddress = { $exists: true, $ne: null, $ne: '' };
        } else if (hasEmail === 'false') {
            filter.$or = [
                { emailAddress: { $exists: false } },
                { emailAddress: null },
                { emailAddress: '' }
            ];
        }

        const profiles = await SearchProfile.find(filter)
            .sort({ originalRelevanceScore: -1, createdAt: -1 })
            .lean();

        const totalCount = profiles.length;

        res.status(StatusCodes.OK).json({
            success: true,
            data: {
                search,
                profiles,
                pagination: {
                    total: totalCount,
                    showing: totalCount,
                    hasMore: false
                }
            }
        });

    } catch (error) {
        console.error('Error fetching search profiles:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to fetch search profiles',
            error: error.message
        });
    }
};

// Update profile with enrichment data
const updateProfile = async (req, res) => {
    const userId = req.user.userId;
    const { profileId } = req.params;
    const updateData = req.body;

    try {
        // Verify the profile belongs to the user
        const profile = await SearchProfile.findOne({ _id: profileId, userId });
        if (!profile) {
            throw new BadRequestError('Profile not found or access denied');
        }

        console.log(`🔄 Updating profile ${profileId} with data:`, updateData);

        // Prepare update object
        const update = {};

        // 👤 BASIC PROFILE INFORMATION
        if (updateData.firstName !== undefined) update.firstName = updateData.firstName;
        if (updateData.lastName !== undefined) update.lastName = updateData.lastName;
        if (updateData.fullName !== undefined) update.fullName = updateData.fullName;

        if (updateData.title !== undefined) {
            update.title = updateData.title;
            // 🔄 Auto-sync: Update extractedTitle when title is updated
            update.extractedTitle = updateData.title;
        }

        if (updateData.company !== undefined) {
            update.company = updateData.company;
            // 🔄 Auto-sync: Update extractedCompany when company is updated
            update.extractedCompany = updateData.company;
        }

        if (updateData.location !== undefined) {
            update.location = updateData.location;
            // 🔄 Auto-sync: Update extractedLocation when location is updated
            update.extractedLocation = updateData.location;
        }

        // 📧 EMAIL INFORMATION
        if (updateData.emailAddress !== undefined) {
            update.emailAddress = updateData.emailAddress;
            update.emailFetchStatus = updateData.emailAddress ? 'success' : 'failed';
            update.emailFetchedAt = new Date();
            if (updateData.emailCreditsUsed) {
                update.emailCreditsUsed = updateData.emailCreditsUsed;
            }
        }

        // 🔗 LINKEDIN INFORMATION
        if (updateData.linkedinUrl !== undefined) {
            update.linkedinUrl = updateData.linkedinUrl;
            update.linkedinUrlStatus = updateData.linkedinUrl ? 'success' : 'failed';
            update.linkedinUrlFetchedAt = new Date();
            if (updateData.linkedinUrlCreditsUsed) {
                update.linkedinUrlCreditsUsed = updateData.linkedinUrlCreditsUsed;
            }
        }

        // 📊 EXTRACTED DATA (Manual Override)
        if (updateData.extractedTitle !== undefined) update.extractedTitle = updateData.extractedTitle;
        if (updateData.extractedCompany !== undefined) update.extractedCompany = updateData.extractedCompany;
        if (updateData.extractedLocation !== undefined) update.extractedLocation = updateData.extractedLocation;
        if (updateData.extractedIndustry !== undefined) update.extractedIndustry = updateData.extractedIndustry;

        // 🏢 INDUSTRY UPDATES
        if (updateData.industry !== undefined) {
            update.industry = updateData.industry;
            // 🔄 Auto-sync: Update extractedIndustry when industry is updated
            update.extractedIndustry = updateData.industry;
        }

        // 🎯 RELEVANCE AND MATCHING
        if (updateData.relevanceScore !== undefined) update.relevanceScore = updateData.relevanceScore;
        if (updateData.originalRelevanceScore !== undefined) update.originalRelevanceScore = updateData.originalRelevanceScore;
        if (updateData.matchedCategories !== undefined) update.matchedCategories = updateData.matchedCategories;
        if (updateData.matchedCategoriesValue !== undefined) update.matchedCategoriesValue = updateData.matchedCategoriesValue;

        // 🔍 ANALYSIS DATA
        if (updateData.analysisData) {
            update.analysisScore = updateData.analysisData.score;
            update.analysisDescription = updateData.analysisData.description;
            update.analysisBreakdown = updateData.analysisData.breakdown;
            update.analyzedAt = new Date();
            if (updateData.analysisData.creditsUsed) {
                update.analysisCreditsUsed = updateData.analysisData.creditsUsed;
            }
        }

        // Direct analysis field updates
        if (updateData.analysisScore !== undefined) update.analysisScore = updateData.analysisScore;
        if (updateData.analysisDescription !== undefined) update.analysisDescription = updateData.analysisDescription;
        if (updateData.analysisBreakdown !== undefined) update.analysisBreakdown = updateData.analysisBreakdown;

        // 🏢 ADDITIONAL PROFILE DATA
        if (updateData.experienceLevel !== undefined) update.experienceLevel = updateData.experienceLevel;
        if (updateData.companySize !== undefined) update.companySize = updateData.companySize;

        // 🔄 ENRICHMENT DATA
        if (updateData.signalHireData !== undefined) update.signalHireData = updateData.signalHireData;
        if (updateData.contactOutData !== undefined) update.contactOutData = updateData.contactOutData;
        if (updateData.icypeasData !== undefined) update.icypeasData = updateData.icypeasData;
        if (updateData.csvData !== undefined) update.csvData = updateData.csvData;

        // 🌟 ENRICHED DATA (Additional enrichment information)
        if (updateData.enrichedData !== undefined) update.enrichedData = updateData.enrichedData;

        // 📚 ENRICHMENT HISTORY
        if (updateData.enrichmentHistory && Array.isArray(updateData.enrichmentHistory)) {
            update.$push = { enrichmentHistory: { $each: updateData.enrichmentHistory } };
        }

        // ✅ PROFILE EVALUATION
        if (updateData.profileEvaluation) {
            update.profileEvaluation = {
                ...profile.profileEvaluation,
                ...updateData.profileEvaluation,
                lastUpdated: new Date()
            };
        }

        // 💾 USER ACTIONS
        if (updateData.isSaved !== undefined) {
            update.isSaved = updateData.isSaved;
            if (updateData.isSaved) {
                update.savedAt = new Date();
                if (updateData.savedToProjectId) {
                    update.savedToProjectId = updateData.savedToProjectId;
                }
            }
        }

        console.log(`📝 Update object:`, update);

        const updatedProfile = await SearchProfile.findByIdAndUpdate(
            profileId,
            update,
            { new: true, runValidators: true }
        );

        console.log(`✅ Profile updated successfully. Company: ${updatedProfile.company}, ExtractedCompany: ${updatedProfile.extractedCompany}`);

        res.status(StatusCodes.OK).json({
            success: true,
            message: 'Profile updated successfully',
            data: updatedProfile
        });

    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to update profile',
            error: error.message
        });
    }
};

// Batch update multiple profiles with enrichment data
const batchUpdateProfiles = async (req, res) => {
    const userId = req.user.userId;
    const { updates } = req.body; // Array of profile updates

    try {
        // Validate input
        if (!Array.isArray(updates) || updates.length === 0) {
            throw new BadRequestError('Updates array is required and must not be empty');
        }

        console.log(`🔄 Batch updating ${updates.length} profiles for user ${userId}`);

        const results = {
            successful: [],
            failed: [],
            totalProcessed: 0
        };

        // Process each update
        const updatePromises = updates.map(async (updateData, index) => {
            try {
                const { profileId, ...data } = updateData;

                if (!profileId) {
                    throw new Error('profileId is required for each update');
                }

                // Verify the profile belongs to the user
                const profile = await SearchProfile.findOne({ _id: profileId, userId });
                if (!profile) {
                    throw new Error('Profile not found or access denied');
                }

                // Prepare update object (similar to single update logic)
                const update = {};

                // 👤 BASIC PROFILE INFORMATION
                if (data.firstName !== undefined) update.firstName = data.firstName;
                if (data.lastName !== undefined) update.lastName = data.lastName;
                if (data.fullName !== undefined) update.fullName = data.fullName;

                if (data.title !== undefined) {
                    update.title = data.title;
                    update.extractedTitle = data.title;
                }

                if (data.company !== undefined) {
                    update.company = data.company;
                    update.extractedCompany = data.company;
                }

                if (data.location !== undefined) {
                    update.location = data.location;
                    update.extractedLocation = data.location;
                }

                // 📧 EMAIL INFORMATION
                if (data.emailAddress !== undefined) {
                    update.emailAddress = data.emailAddress;
                    update.emailFetchStatus = data.emailAddress ? 'success' : 'failed';
                    update.emailFetchedAt = new Date();
                    if (data.emailCreditsUsed) {
                        update.emailCreditsUsed = data.emailCreditsUsed;
                    }
                }

                // 🔗 LINKEDIN INFORMATION
                if (data.linkedinUrl !== undefined) {
                    update.linkedinUrl = data.linkedinUrl;
                    update.linkedinUrlStatus = data.linkedinUrl ? 'success' : 'failed';
                    update.linkedinUrlFetchedAt = new Date();
                    if (data.linkedinUrlCreditsUsed) {
                        update.linkedinUrlCreditsUsed = data.linkedinUrlCreditsUsed;
                    }
                }

                // 📊 EXTRACTED DATA
                if (data.extractedTitle !== undefined) update.extractedTitle = data.extractedTitle;
                if (data.extractedCompany !== undefined) update.extractedCompany = data.extractedCompany;
                if (data.extractedLocation !== undefined) update.extractedLocation = data.extractedLocation;
                if (data.extractedIndustry !== undefined) update.extractedIndustry = data.extractedIndustry;

                // 🏢 INDUSTRY UPDATES
                if (data.industry !== undefined) {
                    update.industry = data.industry;
                    update.extractedIndustry = data.industry;
                }

                // 🎯 RELEVANCE AND MATCHING
                if (data.relevanceScore !== undefined) update.relevanceScore = data.relevanceScore;
                if (data.originalRelevanceScore !== undefined) update.originalRelevanceScore = data.originalRelevanceScore;
                if (data.matchedCategories !== undefined) update.matchedCategories = data.matchedCategories;
                if (data.matchedCategoriesValue !== undefined) update.matchedCategoriesValue = data.matchedCategoriesValue;

                // 🔍 ANALYSIS DATA
                if (data.analysisData) {
                    update.analysisScore = data.analysisData.score;
                    update.analysisDescription = data.analysisData.description;
                    update.analysisBreakdown = data.analysisData.breakdown;
                    update.analyzedAt = new Date();
                    if (data.analysisData.creditsUsed) {
                        update.analysisCreditsUsed = data.analysisData.creditsUsed;
                    }
                }

                // Direct analysis field updates
                if (data.analysisScore !== undefined) update.analysisScore = data.analysisScore;
                if (data.analysisDescription !== undefined) update.analysisDescription = data.analysisDescription;
                if (data.analysisBreakdown !== undefined) update.analysisBreakdown = data.analysisBreakdown;

                // 🏢 ADDITIONAL PROFILE DATA
                if (data.experienceLevel !== undefined) update.experienceLevel = data.experienceLevel;
                if (data.companySize !== undefined) update.companySize = data.companySize;

                // 🔄 ENRICHMENT DATA
                if (data.signalHireData !== undefined) update.signalHireData = data.signalHireData;
                if (data.contactOutData !== undefined) update.contactOutData = data.contactOutData;
                if (data.icypeasData !== undefined) update.icypeasData = data.icypeasData;
                if (data.csvData !== undefined) update.csvData = data.csvData;
                if (data.enrichedData !== undefined) update.enrichedData = data.enrichedData;

                // 📚 ENRICHMENT HISTORY
                if (data.enrichmentHistory && Array.isArray(data.enrichmentHistory)) {
                    update.$push = { enrichmentHistory: { $each: data.enrichmentHistory } };
                }

                // ✅ PROFILE EVALUATION
                if (data.profileEvaluation) {
                    update.profileEvaluation = {
                        ...profile.profileEvaluation,
                        ...data.profileEvaluation,
                        lastUpdated: new Date()
                    };
                }

                // 💾 USER ACTIONS
                if (data.isSaved !== undefined) {
                    update.isSaved = data.isSaved;
                    if (data.isSaved) {
                        update.savedAt = new Date();
                        if (data.savedToProjectId) {
                            update.savedToProjectId = data.savedToProjectId;
                        }
                    }
                }

                // Perform the update
                const updatedProfile = await SearchProfile.findByIdAndUpdate(
                    profileId,
                    update,
                    { new: true, runValidators: true }
                );

                return {
                    index,
                    profileId,
                    status: 'success',
                    updatedProfile
                };

            } catch (error) {
                console.error(`❌ Failed to update profile ${updateData.profileId}:`, error.message);
                return {
                    index,
                    profileId: updateData.profileId,
                    status: 'failed',
                    error: error.message
                };
            }
        });

        // Execute all updates in parallel
        const updateResults = await Promise.allSettled(updatePromises);

        // Process results
        updateResults.forEach((result, index) => {
            results.totalProcessed++;

            if (result.status === 'fulfilled') {
                if (result.value.status === 'success') {
                    results.successful.push(result.value);
                } else {
                    results.failed.push(result.value);
                }
            } else {
                results.failed.push({
                    index,
                    profileId: updates[index]?.profileId || 'unknown',
                    status: 'failed',
                    error: result.reason?.message || 'Unknown error'
                });
            }
        });

        console.log(`✅ Batch update completed: ${results.successful.length} successful, ${results.failed.length} failed`);

        res.status(StatusCodes.OK).json({
            success: true,
            message: `Batch update completed: ${results.successful.length}/${results.totalProcessed} profiles updated successfully`,
            data: {
                summary: {
                    totalProcessed: results.totalProcessed,
                    successful: results.successful.length,
                    failed: results.failed.length
                },
                successful: results.successful,
                failed: results.failed
            }
        });

    } catch (error) {
        console.error('Error in batch update profiles:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to batch update profiles',
            error: error.message
        });
    }
};

// Delete old searches (cleanup job)
const cleanupOldSearches = async (req, res) => {
    try {
        const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

        // MongoDB TTL should handle this automatically, but we can manually clean up if needed
        const deletedSearches = await SavedSearch.deleteMany({ createdAt: { $lt: cutoffDate } });
        const deletedProfiles = await SearchProfile.deleteMany({ createdAt: { $lt: cutoffDate } });

        res.status(StatusCodes.OK).json({
            success: true,
            message: 'Cleanup completed',
            data: {
                deletedSearches: deletedSearches.deletedCount,
                deletedProfiles: deletedProfiles.deletedCount
            }
        });

    } catch (error) {
        console.error('Error during cleanup:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: 'Failed to cleanup old searches',
            error: error.message
        });
    }
};

// Delete a single search profile
const deleteProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { profileId } = req.params;

        // Find the profile and verify ownership
        const profile = await SearchProfile.findById(profileId);

        if (!profile) {
            return res.status(StatusCodes.NOT_FOUND).json({
                success: false,
                error: 'Profile not found'
            });
        }

        // Verify the profile belongs to the authenticated user
        if (profile.userId.toString() !== userId) {
            return res.status(StatusCodes.FORBIDDEN).json({
                success: false,
                error: 'Access denied: You do not own this profile'
            });
        }

        // Delete the profile
        await profile.deleteOne();

        console.log(`🗑️ Deleted search profile: ${profileId} for user: ${userId}`);

        res.status(StatusCodes.OK).json({
            success: true,
            message: 'Profile deleted successfully',
            deletedProfileId: profileId
        });

    } catch (error) {
        console.error('Error in deleteProfile:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            error: 'Failed to delete profile'
        });
    }
};

// Delete multiple search profiles by ids
const deleteMultipleProfiles = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { profileIds } = req.body;

        // Validate input
        if (!Array.isArray(profileIds) || profileIds.length === 0) {
            return res.status(StatusCodes.BAD_REQUEST).json({
                success: false,
                error: 'profileIds must be a non-empty array'
            });
        }

        // Find all profiles to delete
        const profiles = await SearchProfile.find({
            _id: { $in: profileIds }
        });

        if (profiles.length === 0) {
            return res.status(StatusCodes.NOT_FOUND).json({
                success: false,
                error: 'No profiles found'
            });
        }

        // Filter profiles that belong to the authenticated user
        const userProfiles = profiles.filter(profile =>
            profile.userId.toString() === userId
        );

        if (userProfiles.length === 0) {
            return res.status(StatusCodes.FORBIDDEN).json({
                success: false,
                error: 'Access denied: No profiles found that you have permission to delete'
            });
        }

        // Get the valid profile IDs that belong to the user
        const validProfileIds = userProfiles.map(profile => profile._id);

        // Delete the profiles
        const deleteResult = await SearchProfile.deleteMany({
            _id: { $in: validProfileIds }
        });

        const notFoundCount = profileIds.length - profiles.length;
        const unauthorizedCount = profiles.length - userProfiles.length;

        console.log(`🗑️ Bulk deleted ${deleteResult.deletedCount} search profiles for user: ${userId}`);

        res.status(StatusCodes.OK).json({
            success: true,
            message: 'Profiles deletion completed',
            deleted: deleteResult.deletedCount,
            requested: profileIds.length,
            notFound: notFoundCount,
            unauthorized: unauthorizedCount,
            deletedProfileIds: validProfileIds
        });

    } catch (error) {
        console.error('Error in deleteMultipleProfiles:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            success: false,
            error: 'Failed to delete profiles'
        });
    }
};

module.exports = {
    saveSearchResults,
    getRecentSearches,
    getSearchProfiles,
    updateProfile,
    cleanupOldSearches,
    batchUpdateProfiles,
    deleteProfile,
    deleteMultipleProfiles
};
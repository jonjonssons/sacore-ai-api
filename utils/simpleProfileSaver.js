const SavedSearch = require('../models/SavedSearch');
const SearchProfile = require('../models/SearchProfile');

/**
 * Simple and efficient profile saving - replaces the complex autoSaveSearchResults
 * @param {Object} params - Parameters for saving search results
 * @param {string} params.userId - User ID who performed the search
 * @param {Array} params.filters - Search filters array
 * @param {Object} params.sourceInclusions - Which sources were included
 * @param {Array} params.finalResults - Final processed profiles
 * @param {Object} params.meta - Search metadata
 * @param {number} params.duration - Search duration in milliseconds
 * @param {number} params.creditsUsed - Credits consumed for the search
 * @returns {Promise<Object>} - Save results with searchId
 */
async function saveSearchResults({
    userId,
    filters,
    sourceInclusions,
    finalResults,
    meta,
    duration = 0,
    creditsUsed = 0
}) {
    try {
        console.log(`💾 Starting to save ${finalResults.length} profiles for user ${userId}`);

        // 1. Extract search criteria from filters
        const getFilterValue = (field) => filters.find(f => f.field === field)?.value || '';
        const getAllFilterValues = (field) => filters.filter(f => f.field === field).map(f => f.value);

        const searchCriteria = {
            title: getAllFilterValues('title').join(', '),
            location: getAllFilterValues('location').join(', '),
            industry: getAllFilterValues('industry').join(', '),
            experience: getFilterValue('experience'),
            companySize: getFilterValue('companySize'),
            specificRequirements: sourceInclusions.specificRequirements || []
        };

        // 2. Create search query string
        const searchQuery = [
            searchCriteria.title,
            searchCriteria.location,
            searchCriteria.industry
        ].filter(Boolean).join(' | ') || 'Advanced Search';

        // 3. Extract CSV file info if available
        const csvFileInfo = meta.csvImportMeta ? {
            filename: meta.csvImportMeta.fileName || 'uploaded_file.csv',
            originalName: meta.csvImportMeta.fileName || 'CSV Import',
            size: meta.csvImportMeta.fileSize || meta.csvImportMeta.inputTextLength || 0,
            profilesImported: meta.csvImportResults || 0
        } : undefined;

        // 4. Create search metadata
        const searchMetadata = {
            duration,
            creditsUsed,
            apiCallsCount: (meta.googleResults || 0) + (meta.braveResults || 0) +
                (meta.signalHireResults || 0) + (meta.contactOutResults || 0) +
                (meta.icypeasResults || 0),
            errorCount: 0
        };

        // 5. Create the SavedSearch record
        const savedSearch = await SavedSearch.create({
            userId,
            searchQuery,
            searchCriteria,
            sourceInclusions,
            totalProfilesFound: finalResults.length,
            csvFileInfo,
            searchMetadata
        });

        console.log(`✅ Created SavedSearch with ID: ${savedSearch._id}`);

        // 6. 🚀 ULTRA-SIMPLE: Store entire profiles as-is with minimal processing
        const profilesData = finalResults.map((profile, index) => {
            // Extract basic info for indexing (but keep everything in rawProfileData)
            let fullName = 'Unknown';
            let title = 'Unknown Title';
            let company = 'Unknown Company';
            let location = 'Unknown Location';
            let linkedinUrl = '';

            // Get fullName from various sources
            if (profile.fullName) {
                fullName = profile.fullName;
            } else if (profile.pagemap?.metatags?.[0]) {
                const firstName = profile.pagemap.metatags[0]['profile:first_name'] || '';
                const lastName = profile.pagemap.metatags[0]['profile:last_name'] || '';
                fullName = `${firstName} ${lastName}`.trim() || 'Unknown';
            }

            // Get title (prefer extracted)
            if (profile.extractedTitle) {
                title = profile.extractedTitle;
            } else if (profile.title) {
                title = profile.title;
            }

            // Get company (handle object vs string)
            if (profile.extractedCompany) {
                company = profile.extractedCompany;
            } else if (typeof profile.company === 'string') {
                company = profile.company;
            } else if (profile.company && profile.company.name) {
                company = profile.company.name;  // Handle ContactOut format
            }

            // Get LinkedIn URL from various sources
            if (profile.linkedinUrl) {
                linkedinUrl = profile.linkedinUrl;
            } else if (profile.linkedInUrl) {
                linkedinUrl = profile.linkedInUrl;  // ContactOut variant
            } else if (profile.link) {
                linkedinUrl = profile.link;
            }

            // Get location (prefer extracted)
            if (profile.extractedLocation) {
                location = profile.extractedLocation;
            } else if (profile.location) {
                location = profile.location;
            } else if (profile.contactOutData?.location) {
                location = profile.contactOutData.location;  // ContactOut format
            } else if (profile.signalHireData?.location) {
                location = profile.signalHireData.location;  // SignalHire format
            }

            return {
                searchId: savedSearch._id,
                userId,

                // 🚀 MAIN STORAGE: Store the ENTIRE profile object exactly as-is
                rawProfileData: profile,  // This is the complete profile data!

                // Basic extracted fields for indexing/searching (optional)
                fullName,
                title,
                company,
                location,
                linkedinUrl,
                source: profile.source || 'unknown',

                // Keep original index for direct mapping
                originalIndex: index
            };
        });

        // 7. Bulk insert all profiles - MUCH faster than individual creates
        console.log(`💾 Bulk inserting ${profilesData.length} profiles...`);

        const savedProfiles = await SearchProfile.insertMany(profilesData, {
            ordered: false, // Continue even if some profiles fail
            rawResult: false // Return the actual documents
        });

        console.log(`✅ Successfully saved ${savedProfiles.length}/${finalResults.length} profiles`);

        // 8. 🚀 Add database ID to finalResults (simple 1:1 mapping by index)
        finalResults.forEach((profile, index) => {
            if (savedProfiles[index]) {
                // Add the database ID for future updates
                profile.searchProfileId = savedProfiles[index]._id.toString();
                profile.canUpdate = true;
                profile.mappingMethod = 'direct_index';

                console.log(`✅ Profile ${index + 1}: ${profile.fullName || 'Unknown'} -> ID: ${profile.searchProfileId}`);
            } else {
                profile.searchProfileId = null;
                profile.canUpdate = false;
                profile.mappingMethod = 'failed';
                console.warn(`❌ Failed to save profile at index ${index}: ${profile.fullName || 'Unknown'}`);
            }
        });

        const mappedCount = finalResults.filter(p => p.searchProfileId).length;
        console.log(`🎯 Mapped ${mappedCount}/${finalResults.length} profiles with searchProfileId`);

        return {
            success: true,
            searchId: savedSearch._id.toString(),
            totalProfiles: finalResults.length,
            savedProfiles: savedProfiles.length,
            failedSaves: finalResults.length - savedProfiles.length
        };

    } catch (error) {
        console.error('❌ Error saving search results:', error);

        // Add null searchProfileId to all profiles on error
        finalResults.forEach(profile => {
            profile.searchProfileId = null;
            profile.canUpdate = false;
            profile.mappingMethod = 'save_failed';
        });

        console.log(`❌ All ${finalResults.length} profiles marked with null searchProfileId due to save error`);

        return {
            success: false,
            error: error.message,
            searchId: null,
            totalProfiles: finalResults.length,
            savedProfiles: 0,
            failedSaves: finalResults.length
        };
    }
}

module.exports = {
    saveSearchResults
};

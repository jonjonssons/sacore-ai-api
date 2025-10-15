const SavedSearch = require('../models/SavedSearch');
const SearchProfile = require('../models/SearchProfile');

/**
 * Automatically save search results from a search operation
 * @param {Object} params - Parameters for saving search results
 * @param {string} params.userId - User ID who performed the search
 * @param {Object} params.searchRequest - Original search request data
 * @param {Array} params.results - Array of profile results
 * @param {Object} params.meta - Search metadata from response
 * @param {number} params.duration - Search duration in milliseconds
 * @param {number} params.creditsUsed - Credits consumed for the search
 * @returns {Promise<Object>} - Save results
 */
async function autoSaveSearchResults({ userId, searchRequest, results, meta, duration = 0, creditsUsed = 0 }) {
    try {
        // Extract search criteria from the original request
        const searchCriteria = {
            title: searchRequest.filters?.find(f => f.field === 'title')?.value || '',
            location: searchRequest.filters?.find(f => f.field === 'location')?.value || '',
            industry: searchRequest.filters?.find(f => f.field === 'industry')?.value || '',
            experience: searchRequest.filters?.find(f => f.field === 'experience')?.value || '',
            companySize: searchRequest.filters?.find(f => f.field === 'companySize')?.value || '',
            specificRequirements: searchRequest.specificRequirements || []
        };

        // Create search query string
        const searchQuery = [
            searchCriteria.title,
            searchCriteria.location,
            searchCriteria.industry
        ].filter(Boolean).join(' | ');

        // Extract source inclusions
        const sourceInclusions = {
            includeSignalHire: searchRequest.includeSignalHire || false,
            includeBrave: searchRequest.includeBrave || false,
            includeGoogle: searchRequest.includeGoogle || false,
            includeContactOut: searchRequest.includeContactOut || false,
            includeIcypeas: searchRequest.includeIcypeas || false,
            includeCsvImport: searchRequest.includeCsvImport || false
        };

        // Extract CSV file info if available
        const csvFileInfo = meta.csvImportMeta ? {
            filename: 'uploaded_file.csv', // You might want to capture actual filename
            originalName: 'CSV Import',
            size: meta.csvImportMeta.inputTextLength || 0,
            profilesImported: meta.csvImportResults || 0
        } : undefined;

        // Create search metadata
        const searchMetadata = {
            duration,
            creditsUsed,
            apiCallsCount: (meta.googleResults || 0) + (meta.braveResults || 0) + (meta.signalHireResults || 0) + (meta.contactOutResults || 0) + (meta.icypeasResults || 0),
            errorCount: 0 // You might want to track this from the search process
        };

        // Create the saved search record
        const savedSearch = await SavedSearch.create({
            userId,
            searchQuery,
            searchCriteria,
            sourceInclusions,
            totalProfilesFound: results.length,
            csvFileInfo,
            searchMetadata
        });

        console.log(`💾 Auto-saved search with ID: ${savedSearch._id}`);

        // Save all profiles
        const profilePromises = results.map(profileData => {
            // Extract names from fullName if firstName/lastName not provided
            let firstName = profileData.firstName;
            let lastName = profileData.lastName;
            if (!firstName && !lastName && profileData.fullName) {
                const nameParts = profileData.fullName.split(' ');
                firstName = nameParts[0] || '';
                lastName = nameParts.slice(1).join(' ') || '';
            }

            // Extract basic info from title/snippet if not provided
            let title = profileData.title || profileData.extractedTitle;
            let company = profileData.company || profileData.extractedCompany;
            let location = profileData.location || profileData.extractedLocation;
            let fullName = profileData.fullName;

            // Try to extract from title format: "Name - Title - Company"
            if (!fullName || !title || !company) {
                const titleParts = (profileData.title || '').split(' - ');
                if (titleParts.length >= 3) {
                    fullName = fullName || titleParts[0];
                    title = title || titleParts[1];
                    company = company || titleParts[2];
                }
            }

            // Try to extract from snippet
            if (!location && profileData.snippet) {
                const snippetMatch = profileData.snippet.match(/•\s*([^•]+)\s*•/);
                if (snippetMatch) {
                    location = snippetMatch[1].trim();
                }
            }

            return SearchProfile.create({
                searchId: savedSearch._id,
                userId,
                fullName: fullName || 'Unknown',
                title: title || 'Professional',
                company: (() => {
                    if (typeof profileData.company === 'string') {
                        return profileData.company || 'Company';
                    } else if (typeof profileData.company === 'object' && profileData.company !== null) {
                        return profileData.company.name || 'Company';
                    } else {
                        return 'Company';
                    }
                })(),
                location: location || '',
                firstName,
                lastName,
                linkedinUrl: profileData.linkedinUrl || profileData.link || '',
                emailAddress: profileData.emailAddress || profileData.email || '',
                extractedCompany: (() => {
                    if (typeof profileData.extractedCompany === 'string') {
                        return profileData.extractedCompany || company;
                    } else if (typeof profileData.company === 'object' && profileData.company !== null) {
                        return profileData.company.name || 'Company';
                    } else {
                        return company || 'Company';
                    }
                })(),
                extractedTitle: profileData.extractedTitle || title,
                extractedLocation: profileData.extractedLocation || location,
                extractedIndustry: profileData.extractedIndustry || '',
                relevanceScore: profileData.relevanceScore,
                originalRelevanceScore: profileData.originalRelevanceScore || 50,
                matchedCategories: profileData.matchedCategories,
                matchedCategoriesValue: profileData.matchedCategoriesValue,
                source: profileData.source || 'unknown',
                sourceBoost: profileData.sourceBoost || 0,
                originalApiResponse: {
                    title: profileData.title,
                    link: profileData.link,
                    snippet: profileData.snippet,
                    formattedUrl: profileData.formattedUrl,
                    pagemap: profileData.pagemap,
                    query: profileData.query,
                    page: profileData.page
                },
                signalHireData: profileData.signalHireData,
                contactOutData: profileData.contactOutData,
                icypeasData: profileData.icypeasData,
                csvData: profileData.csvData,
                analysisScore: profileData.analysisScore,
                analysisDescription: profileData.analysisDescription,
                analysisBreakdown: profileData.analysisBreakdown,
                analysisCreditsUsed: profileData.analysisCreditsUsed,
                analyzedAt: profileData.analyzedAt,
                profileEvaluation: profileData.profileEvaluation || { status: 'pending' },
                experienceLevel: profileData.experienceLevel,
                companySize: profileData.companySize,
                industry: profileData.industry || profileData.extractedIndustry,
                enrichmentHistory: profileData.enrichmentHistory || [],
                emailFetchStatus: profileData.emailAddress || profileData.email ? 'success' : 'not_attempted',
                linkedinUrlStatus: profileData.linkedinUrl || profileData.link ? 'success' : 'no_url_found',
                emailFetchedAt: profileData.emailAddress || profileData.email ? new Date() : undefined,
                linkedinUrlFetchedAt: profileData.linkedinUrl || profileData.link ? new Date() : undefined
            });
        });

        const savedProfiles = await Promise.allSettled(profilePromises);
        const successfulSaves = savedProfiles.filter(result => result.status === 'fulfilled');
        const failedSaves = savedProfiles.filter(result => result.status === 'rejected');

        if (failedSaves.length > 0) {
            console.error(`⚠️ Failed to auto-save ${failedSaves.length} profiles:`, failedSaves.map(f => f.reason?.message || f.reason));
        }

        console.log(`💾 Auto-saved ${successfulSaves.length}/${results.length} profiles to search ${savedSearch._id}`);

        // Create mapping using multiple strategies for robust matching
        const profileIdMapping = {};

        // Also update the mapping creation to handle LinkedIn URL variations:

        successfulSaves.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                const savedProfile = result.value;
                const originalProfile = results[index];

                console.log(`🔗 Creating mapping for profile ${index}: ${originalProfile.fullName}`);

                // Strategy 1: Use SignalHire UID if available
                if (originalProfile.signalHireData?.uid) {
                    const uidKey = `uid_${originalProfile.signalHireData.uid}`;
                    profileIdMapping[uidKey] = {
                        searchProfileId: savedProfile._id.toString(),
                        originalIndex: index,
                        mappingType: 'signalhire_uid'
                    };
                }

                // Strategy 2: Use LinkedIn URL with multiple field variations
                const linkedinUrls = [
                    originalProfile.linkedinUrl,
                    originalProfile.linkedInUrl,    // ContactOut variant
                    originalProfile.link
                ].filter(Boolean).filter(url => url.trim() !== '');

                linkedinUrls.forEach(url => {
                    const linkedinKey = url.toLowerCase().trim();
                    profileIdMapping[linkedinKey] = {
                        searchProfileId: savedProfile._id.toString(),
                        originalIndex: index,
                        mappingType: 'linkedin_url'
                    };
                    console.log(`   ✅ Mapped by LinkedIn URL: ${linkedinKey}`);
                });

                // Strategy 2.5: Add ContactOut vanity mapping
                if (originalProfile.liVanity) {
                    const vanityKey = `vanity_${originalProfile.liVanity}`;
                    profileIdMapping[vanityKey] = {
                        searchProfileId: savedProfile._id.toString(),
                        originalIndex: index,
                        mappingType: 'contactout_vanity'
                    };
                    console.log(`   ✅ Mapped by ContactOut vanity: ${vanityKey}`);
                }

                // Strategy 3: Use multiple company field variations
                const companies = [
                    originalProfile.extractedCompany,   // Extracted field
                    originalProfile.company?.name,      // ContactOut nested format
                    typeof originalProfile.company === 'string' ? originalProfile.company : null, // Direct field only if string
                    'Company'                           // Always include fallback
                ].filter(Boolean).filter(c => typeof c === 'string' && c.trim() !== '');

                if (originalProfile.fullName && companies.length > 0) {
                    companies.forEach(company => {
                        const nameCompanyKey = `${originalProfile.fullName.toLowerCase().trim()}_${company.toLowerCase().trim()}`;
                        profileIdMapping[nameCompanyKey] = {
                            searchProfileId: savedProfile._id.toString(),
                            originalIndex: index,
                            mappingType: 'name_company'
                        };
                        console.log(`   ✅ Mapped by Name+Company: ${nameCompanyKey}`);
                    });
                }

                // Strategy 4: Index-based mapping
                const indexKey = `index_${index}`;
                profileIdMapping[indexKey] = {
                    searchProfileId: savedProfile._id.toString(),
                    originalIndex: index,
                    mappingType: 'index'
                };
            }
        });

        console.log(`🔗 Created ${Object.keys(profileIdMapping).length} total mapping keys for ${successfulSaves.length} profiles`);

        return {
            success: true,
            searchId: savedSearch._id,
            totalProfiles: results.length,
            savedProfiles: successfulSaves.length,
            failedSaves: failedSaves.length,
            profileMapping: profileIdMapping
        };

    } catch (error) {
        console.error('Error auto-saving search results:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    autoSaveSearchResults
};
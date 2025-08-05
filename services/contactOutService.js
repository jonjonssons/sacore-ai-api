const axios = require('axios');

const CONTACTOUT_BASE_URL = 'https://api.contactout.com/v1';
const CONTACTOUT_TOKEN = process.env.CONTACTOUT_API_KEY || '23aG4rNAMaClrTxqaOltCdLU';

class ContactOutService {
    constructor() {
        this.baseURL = CONTACTOUT_BASE_URL;
        this.token = CONTACTOUT_TOKEN;
    }

    async searchProfilesByCriteria(criteria) {
        try {
            const { title, location, industry, keywords, size = 25, page = 1 } = criteria;

            // Prepare the request payload
            const requestData = {
                page: page,
                job_title: title ? [title] : undefined,
                location: location ? [location] : undefined,
                industry: industry ? [industry] : undefined,
                data_types: ["personal_email", "work_email", "phone"],
                reveal_info: false
            };

            // Remove undefined fields
            Object.keys(requestData).forEach(key => {
                if (requestData[key] === undefined) {
                    delete requestData[key];
                }
            });

            console.log('ContactOut API request:', {
                url: `${this.baseURL}/people/search`,
                data: requestData
            });

            const response = await axios.post(`${this.baseURL}/people/search`, requestData, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'basic',
                    'token': this.token
                },
                timeout: 30000
            });

            console.log('ContactOut API response status:', response.status);
            console.log('ContactOut API response metadata:', response.data?.metadata);

            if (response.status === 200 && response.data) {
                // Transform ContactOut response to our standard format
                const profiles = this.transformContactOutProfiles(response.data.profiles || {});

                return {
                    success: true,
                    results: {
                        profiles: profiles,
                        totalResults: response.data.metadata?.total_results || 0,
                        page: response.data.metadata?.page || page,
                        pageSize: response.data.metadata?.page_size || size,
                        hasMore: profiles.length === (response.data.metadata?.page_size || size)
                    },
                    metadata: response.data.metadata
                };
            } else {
                return {
                    success: false,
                    message: 'ContactOut API returned unexpected response',
                    status: response.status
                };
            }

        } catch (error) {
            console.error('ContactOut search error:', error.message);

            if (error.response) {
                console.error('ContactOut API error response:', {
                    status: error.response.status,
                    data: error.response.data
                });

                return {
                    success: false,
                    message: `ContactOut API error: ${error.response.status} - ${error.response.data?.message || error.message}`,
                    status: error.response.status
                };
            }

            return {
                success: false,
                message: `ContactOut request failed: ${error.message}`,
                status: 500
            };
        }
    }

    transformContactOutProfiles(profilesObject) {
        if (!profilesObject || typeof profilesObject !== 'object') {
            return [];
        }

        // Convert object to array - keys are LinkedIn URLs, values are profile data
        const profiles = Object.entries(profilesObject).map(([linkedInUrl, profileData]) => {
            try {
                return {
                    // Basic profile info
                    fullName: profileData.full_name || 'Unknown',
                    title: profileData.title || '',
                    headline: profileData.headline || '',
                    location: profileData.location || '',
                    country: profileData.country || '',
                    industry: profileData.industry || '',

                    // LinkedIn info
                    linkedInUrl: linkedInUrl,
                    liVanity: profileData.li_vanity || '',

                    // Company info
                    company: {
                        name: profileData.company?.name || '',
                        url: profileData.company?.url || '',
                        domain: profileData.company?.domain || '',
                        industry: profileData.company?.industry || '',
                        size: profileData.company?.size || null,
                        overview: profileData.company?.overview || ''
                    },

                    // Experience and education
                    experience: profileData.experience || [],
                    education: profileData.education || [],
                    skills: profileData.skills || [],

                    // Contact info
                    contactAvailability: profileData.contact_availability || {},
                    contactInfo: profileData.contact_info || {},

                    // Additional metadata
                    followers: profileData.followers || 0,
                    profilePictureUrl: profileData.profile_picture_url || '',
                    updatedAt: profileData.updated_at || '',

                    // Raw data for debugging
                    contactOutData: profileData
                };
            } catch (profileError) {
                console.error('Error transforming ContactOut profile:', profileError);
                return null;
            }
        }).filter(profile => profile !== null);

        console.log(`Transformed ${profiles.length} ContactOut profiles`);
        return profiles;
    }

    // Helper method to get multiple pages (similar to IcyPeas)
    async getMultiplePages(criteria, maxPages = 5) {
        try {
            let allProfiles = [];
            let currentPage = 1;

            while (currentPage <= maxPages) {
                console.log(`Fetching ContactOut page ${currentPage}...`);

                const result = await this.searchProfilesByCriteria({
                    ...criteria,
                    page: currentPage
                });

                if (!result.success || !result.results?.profiles?.length) {
                    console.log(`No more results on page ${currentPage}, stopping`);
                    break;
                }

                allProfiles = allProfiles.concat(result.results.profiles);
                console.log(`Page ${currentPage}: ${result.results.profiles.length} profiles. Total so far: ${allProfiles.length}`);

                // Check if we've reached the end
                if (!result.results.hasMore) {
                    console.log('No more results available according to hasMore flag');
                    break;
                }

                // Also check if we've reached our target (600 profiles)
                if (allProfiles.length >= 600) {
                    console.log(`Reached target of 600 profiles with ${allProfiles.length} profiles`);
                    break;
                }

                currentPage++;

                // Add small delay between requests
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            return {
                success: true,
                results: {
                    profiles: allProfiles,
                    totalPages: currentPage - 1,
                    totalProfiles: allProfiles.length
                }
            };

        } catch (error) {
            console.error('Error getting multiple ContactOut pages:', error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    async enrichProfile(linkedinUrl, includeFields = ["work_email", "personal_email", "phone"]) {
        try {
            console.log(`Enriching profile: ${linkedinUrl}`);

            const requestData = {
                linkedin_url: linkedinUrl,
                include: includeFields
            };

            console.log('ContactOut enrichment request:', {
                url: `${this.baseURL}/people/enrich`,
                data: requestData
            });

            const response = await axios.post(`${this.baseURL}/people/enrich`, requestData, {
                headers: {
                    'Content-Type': 'application/json',
                    'authorization': 'basic',
                    'token': this.token
                },
                timeout: 30000
            });

            console.log('ContactOut enrichment response status:', response.status);
            console.log('ContactOut enrichment response data keys:', Object.keys(response.data || {}));

            if (response.status === 200 && response.data) {
                // Transform the enriched profile data
                const enrichedProfile = this.transformEnrichedProfile(linkedinUrl, response.data);

                return {
                    success: true,
                    profile: enrichedProfile,
                    rawData: response.data
                };
            } else {
                return {
                    success: false,
                    message: 'ContactOut enrichment API returned unexpected response',
                    status: response.status
                };
            }

        } catch (error) {
            console.error('ContactOut enrichment error:', error.message);

            if (error.response) {
                console.error('ContactOut enrichment API error response:', {
                    status: error.response.status,
                    data: error.response.data
                });

                return {
                    success: false,
                    message: `ContactOut enrichment API error: ${error.response.status} - ${error.response.data?.message || error.message}`,
                    status: error.response.status
                };
            }

            return {
                success: false,
                message: `ContactOut enrichment request failed: ${error.message}`,
                status: 500
            };
        }
    }

    transformEnrichedProfile(linkedinUrl, responseData) {
        try {
            // The actual response has status_code and profile nested structure
            const profileData = responseData.profile || responseData;

            return {
                // Basic profile info
                fullName: profileData.full_name || 'Unknown',
                title: profileData.experience?.[0]?.title || '',
                headline: profileData.headline || '',
                location: profileData.location || '',
                country: profileData.country || '',
                industry: profileData.industry || '',
                summary: profileData.summary || '',

                // LinkedIn info
                linkedInUrl: profileData.url || linkedinUrl,

                // Company info (from current/first experience)
                company: profileData.company ? {
                    name: profileData.company.name || '',
                    url: profileData.company.url || '',
                    domain: profileData.company.domain || profileData.company.email_domain || '',
                    industry: profileData.company.industry || '',
                    size: profileData.company.size || null,
                    overview: profileData.company.overview || '',
                    type: profileData.company.type || '',
                    revenue: profileData.company.revenue || null,
                    foundedAt: profileData.company.founded_at || null,
                    headquarter: profileData.company.headquarter || '',
                    website: profileData.company.website || '',
                    logoUrl: profileData.company.logo_url || '',
                    specialties: profileData.company.specialties || [],
                    locations: profileData.company.locations || []
                } : {
                    name: profileData.experience?.[0]?.company_name || '',
                    url: profileData.experience?.[0]?.linkedin_url || '',
                    domain: '',
                    industry: '',
                    size: null,
                    overview: ''
                },

                // Experience and education
                experience: (profileData.experience || []).map(exp => ({
                    title: exp.title || '',
                    company: exp.company_name || '',
                    companyUrl: exp.linkedin_url || '',
                    location: exp.locality || '',
                    startDate: exp.start_date || '',
                    endDate: exp.end_date || '',
                    startYear: exp.start_date_year || null,
                    startMonth: exp.start_date_month || null,
                    endYear: exp.end_date_year || null,
                    endMonth: exp.end_date_month || null,
                    isCurrent: exp.is_current || false,
                    description: exp.summary || ''
                })),

                education: (profileData.education || []).map(edu => ({
                    school: edu.school_name || '',
                    degree: edu.degree || '',
                    fieldOfStudy: edu.field_of_study || '',
                    startYear: edu.start_date_year || '',
                    endYear: edu.end_date_year || '',
                    description: edu.description || ''
                })),

                skills: profileData.skills || [],
                languages: profileData.languages || [],
                certifications: profileData.certifications || [],
                publications: profileData.publications || [],
                projects: profileData.projects || [],

                // Contact info (enriched data) - arrays from ContactOut
                contactInfo: {
                    emails: profileData.email || [],
                    workEmails: profileData.work_email || [],
                    personalEmails: profileData.personal_email || [],
                    phones: profileData.phone || [],
                    github: profileData.github || [],
                    twitter: profileData.twitter || []
                },

                // Additional metadata
                followers: profileData.followers || 0,
                profilePictureUrl: profileData.profile_picture_url || '',
                updatedAt: profileData.updated_at || '',
                enrichedAt: new Date().toISOString(),

                // Status information
                statusCode: responseData.status_code || 200,

                // Raw data for debugging
                contactOutData: responseData
            };
        } catch (transformError) {
            console.error('Error transforming enriched ContactOut profile:', transformError);
            return {
                linkedInUrl: linkedinUrl,
                fullName: 'Unknown',
                error: 'Failed to transform profile data',
                contactOutData: responseData
            };
        }
    }

    // Batch enrichment method for multiple LinkedIn URLs
    async batchEnrichProfiles(linkedinUrls, includeFields = ["work_email", "personal_email", "phone"]) {
        try {
            console.log(`Batch enriching ${linkedinUrls.length} profiles with timeout protection`);

            const results = [];
            const batchSize = 5; // Process in small batches to avoid overwhelming the API
            const requestTimeout = 30000; // 30 seconds per request
            const maxBatchTime = 120000; // 2 minutes max for entire batch

            const batchStartTime = Date.now();

            for (let i = 0; i < linkedinUrls.length; i += batchSize) {
                // Check if we're approaching max batch time
                if (Date.now() - batchStartTime > maxBatchTime) {
                    console.warn(`Batch enrichment timeout reached, stopping at ${i}/${linkedinUrls.length} profiles`);

                    // Add failed results for remaining URLs
                    for (let j = i; j < linkedinUrls.length; j++) {
                        results.push({
                            linkedinUrl: linkedinUrls[j],
                            success: false,
                            message: 'Batch timeout - profile not processed',
                            error: 'timeout'
                        });
                    }
                    break;
                }

                const batch = linkedinUrls.slice(i, i + batchSize);
                console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(linkedinUrls.length / batchSize)}: ${batch.length} profiles`);

                // Add timeout wrapper for each enrichment request
                const batchPromises = batch.map(url =>
                    Promise.race([
                        this.enrichProfile(url, includeFields),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Request timeout')), requestTimeout)
                        )
                    ])
                );

                const batchResults = await Promise.allSettled(batchPromises);

                batchResults.forEach((result, index) => {
                    const linkedinUrl = batch[index];
                    if (result.status === 'fulfilled') {
                        results.push({
                            linkedinUrl,
                            ...result.value
                        });
                    } else {
                        const isTimeout = result.reason?.message === 'Request timeout';
                        results.push({
                            linkedinUrl,
                            success: false,
                            message: isTimeout ? 'Request timeout' : `Enrichment failed: ${result.reason}`,
                            error: isTimeout ? 'timeout' : result.reason,
                            timeout: isTimeout
                        });
                    }
                });

                // Add delay between batches (shorter if we're running out of time)
                if (i + batchSize < linkedinUrls.length) {
                    const remainingTime = maxBatchTime - (Date.now() - batchStartTime);
                    const delayTime = remainingTime > 30000 ? 1000 : 200; // Shorter delay if time is running out
                    await new Promise(resolve => setTimeout(resolve, delayTime));
                }
            }

            const successful = results.filter(r => r.success).length;
            const failed = results.length - successful;
            const timeouts = results.filter(r => r.timeout).length;

            console.log(`Batch enrichment completed: ${successful} successful, ${failed} failed (${timeouts} timeouts)`);

            return {
                success: true,
                results: results,
                summary: {
                    total: results.length,
                    successful,
                    failed,
                    timeouts,
                    batchTimeMs: Date.now() - batchStartTime
                }
            };

        } catch (error) {
            console.error('Batch enrichment error:', error);

            // Return failed results for all URLs if the entire batch fails
            const failedResults = linkedinUrls.map(url => ({
                linkedinUrl: url,
                success: false,
                message: `Batch error: ${error.message}`,
                error: error.message
            }));

            return {
                success: false,
                message: error.message,
                results: failedResults,
                summary: {
                    total: linkedinUrls.length,
                    successful: 0,
                    failed: linkedinUrls.length,
                    timeouts: 0
                }
            };
        }
    }
}

module.exports = new ContactOutService(); 
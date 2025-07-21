/**
 * Service for interacting with IcyPeas API
 */

// API configuration
const ICYPEAS_API_KEY = process.env.ICYPEAS_API_KEY || 'b16d5527eaff4db5bbd1087b401b66d82aeeec4447a24bda8e70923d0bed7957';
const ICYPEAS_BASE_URL = 'https://app.icypeas.com/api';

// Check available credits (if IcyPeas has such endpoint)
exports.checkCredits = async () => {
    try {
        // Note: Check IcyPeas documentation for actual credits endpoint
        const response = await fetch(`${ICYPEAS_BASE_URL}/credits`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': ICYPEAS_API_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`IcyPeas API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
            success: true,
            credits: data.credits || data.remaining || 0
        };
    } catch (error) {
        console.error('Error checking IcyPeas credits:', error);
        return { success: false, error: error.message, credits: 0 };
    }
};

// Search profiles by criteria
exports.searchProfilesByCriteria = async (searchCriteria) => {
    try {
        console.log('🔍 IcyPeas Search Criteria:', searchCriteria);

        // Build the query object according to IcyPeas API format
        const query = {};

        // Map currentJobTitle
        if (searchCriteria.title) {
            query.currentJobTitle = {
                include: Array.isArray(searchCriteria.title) ? searchCriteria.title : [searchCriteria.title]
            };
        }

        // Map location
        if (searchCriteria.location) {
            query.location = {
                include: Array.isArray(searchCriteria.location) ? searchCriteria.location : [searchCriteria.location]
            };
        }

        // Map keywords/industry
        if (searchCriteria.keywords) {
            query.keyword = {
                include: Array.isArray(searchCriteria.keywords) ? searchCriteria.keywords : [searchCriteria.keywords]
            };
        } else if (searchCriteria.industry) {
            query.keyword = {
                include: Array.isArray(searchCriteria.industry) ? searchCriteria.industry : [searchCriteria.industry]
            };
        }

        // Build the request payload
        const requestPayload = {
            query,
            pagination: {
                size: searchCriteria.size // IcyPeas might have limits
            }
        };

        console.log('🔍 IcyPeas Request Payload:', JSON.stringify(requestPayload, null, 2));

        const response = await fetch(`${ICYPEAS_BASE_URL}/find-people`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': ICYPEAS_API_KEY
            },
            body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
            throw new Error(`IcyPeas API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('🔍 IcyPeas Raw Response:', {
            total: data.total,
            success: data.success,
            leadsCount: data.leads?.length
        });

        // Log full response if there's an error
        if (data.success === false || !data.leads) {
            console.log('🔍 IcyPeas Full Error Response:', JSON.stringify(data, null, 2));
        }

        // Transform IcyPeas leads to our standard format
        const transformedLeads = (data.leads || []).map(lead => ({
            // Standard profile data
            uid: `icypeas_${lead.profileUrl?.split('/').pop() || Math.random()}`,
            fullName: `${lead.firstname || ''} ${lead.lastname || ''}`.trim(),
            location: lead.address || '',

            // Experience data (using last job info)
            experience: [{
                title: lead.lastJobTitle || lead.headline || '',
                company: lead.lastCompanyName || '',
                startDate: lead.lastJobStartDate || '',
                description: lead.lastJobDescription || ''
            }],

            // Skills/keywords from description
            skills: lead.description ?
                lead.description.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g)?.slice(0, 10) || [] : [],

            // Contact info (if available)
            contactsFetched: false,

            // IcyPeas specific data
            icypeasData: {
                firstname: lead.firstname,
                lastname: lead.lastname,
                headline: lead.headline,
                description: lead.description,
                profileUrl: lead.profileUrl,
                lastJobTitle: lead.lastJobTitle,
                lastJobDescription: lead.lastJobDescription,
                lastJobStartDate: lead.lastJobStartDate,
                address: lead.address,
                lastCompanyName: lead.lastCompanyName,
                lastCompanyUrn: lead.lastCompanyUrn,
                lastCompanyUrl: lead.lastCompanyUrl,
                lastCompanyWebsite: lead.lastCompanyWebsite,
                lastCompanyDescription: lead.lastCompanyDescription,
                lastCompanySize: lead.lastCompanySize,
                lastCompanyIndustry: lead.lastCompanyIndustry,
                lastCompanyAddress: lead.lastCompanyAddress
            }
        }));

        return {
            success: data.success || true,
            results: {
                profiles: transformedLeads,
                total: data.total || transformedLeads.length,
                // Note: IcyPeas might not support scroll/pagination like SignalHire
                scrollId: null,
                requestId: null
            }
        };

    } catch (error) {
        console.error('Error searching profiles with IcyPeas:', error);
        return {
            success: false,
            error: error.message,
            results: { profiles: [], total: 0 }
        };
    }
};

// Pagination support (if IcyPeas supports it)
exports.getNextPage = async (searchCriteria, page = 2) => {
    try {
        // Modify the search criteria to include pagination
        const paginatedCriteria = {
            ...searchCriteria,
            pagination: {
                size: searchCriteria.size || 100,
                page: page
            }
        };

        // Note: Check IcyPeas documentation for actual pagination support
        return await exports.searchProfilesByCriteria(paginatedCriteria);
    } catch (error) {
        console.error('Error getting next page from IcyPeas:', error);
        return {
            success: false,
            error: error.message,
            results: { profiles: [], total: 0 }
        };
    }
};

// Get profile details (if IcyPeas has individual profile endpoint)
exports.getProfileDetails = async (profileUrl) => {
    try {
        // Note: Check IcyPeas documentation for profile details endpoint
        const response = await fetch(`${ICYPEAS_BASE_URL}/profile`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': ICYPEAS_API_KEY
            },
            body: JSON.stringify({ profileUrl })
        });

        if (!response.ok) {
            throw new Error(`IcyPeas API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
            success: true,
            profile: data
        };
    } catch (error) {
        console.error('Error getting profile details from IcyPeas:', error);
        return { success: false, error: error.message, profile: null };
    }
};

/**
 * Starts an email search job on Icypeas.
 * @param {string} firstname
 * @param {string} lastname
 * @param {string} domainOrCompany
 * @returns {Promise<object>} The initial response from Icypeas containing the search ID.
 */
exports.startEmailSearch = async (firstname, lastname, domainOrCompany) => {
    const response = await fetch(`${ICYPEAS_BASE_URL}/email-search`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': ICYPEAS_API_KEY
        },
        body: JSON.stringify({ firstname, lastname, domainOrCompany })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error('IcyPeas API error response body:', errorBody);
        throw new Error(`IcyPeas API error in startEmailSearch: ${response.status} ${response.statusText}`);
    }
    return await response.json();
};

/**
 * Polls for the results of a previously started email search job.
 * @param {string} searchId The ID of the search job.
 * @returns {Promise<object>} The search result from Icypeas.
 */
exports.getSearchResults = async (searchId) => {
    const response = await fetch(`${ICYPEAS_BASE_URL}/bulk-single-searchs/read`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': ICYPEAS_API_KEY
        },
        body: JSON.stringify({ mode: 'single', id: searchId })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error('IcyPeas API error response body:', errorBody);
        throw new Error(`IcyPeas API error in getSearchResults: ${response.status} ${response.statusText}`);
    }
    return await response.json();
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Enriches a profile with email from Icypeas by starting a job and polling for results.
 * @param {string} firstname
 * @param {string} lastname
 * @param {string} domainOrCompany
 * @returns {Promise<object>} An object containing the success status and the enrichment data or an error message.
 */
exports.enrichProfileWithEmail = async (firstname, lastname, domainOrCompany) => {
    try {
        console.log(`Enriching profile with email from IcyPeas for ${firstname} ${lastname} at ${domainOrCompany}`);
        const startResponse = await exports.startEmailSearch(firstname, lastname, domainOrCompany);

        if (!startResponse.success || !startResponse.item || !startResponse.item._id) {
            throw new Error(`Failed to start IcyPeas email search job. Response: ${JSON.stringify(startResponse)}`);
        }

        const searchId = startResponse.item._id;
        console.log(`IcyPeas search job started with ID: ${searchId}. Polling for results...`);

        const MAX_POLLS = 15; // Poll for 30 seconds
        const POLL_INTERVAL = 2000; // 2 seconds

        for (let i = 0; i < MAX_POLLS; i++) {
            await delay(POLL_INTERVAL);
            console.log(`Polling IcyPeas... Attempt ${i + 1}/${MAX_POLLS}`);
            const resultsResponse = await exports.getSearchResults(searchId);

            if (resultsResponse.success && resultsResponse.items && resultsResponse.items.length > 0) {
                const searchResult = resultsResponse.items[0];

                // Final success statuses
                if (searchResult.status === 'DEBITED' || searchResult.status === 'FOUND') {
                    console.log('Successfully retrieved email from IcyPeas.');
                    const emails = (searchResult.results.emails || []).map(e => ({
                        email: e.email,
                        type: 'professional',
                        verification: { status: e.certainty }
                    }));

                    return {
                        success: true,
                        data: {
                            emails: emails,
                            raw: searchResult,
                        }
                    };
                }

                // Final failure statuses - stop polling
                if (searchResult.status === 'BAD_INPUT' ||
                    searchResult.status === 'INSUFFICIENT_FUNDS' ||
                    searchResult.status === 'ABORTED' ||
                    searchResult.status === 'NOT_FOUND' ||
                    searchResult.status === 'DEBITED_NOT_FOUND') {
                    console.warn(`IcyPeas search completed with final status: '${searchResult.status}'. Stopping poll.`);
                    throw new Error(`Icypeas search failed with status: ${searchResult.status}`);
                }

                // Processing statuses - continue polling (NONE, SCHEDULED, IN_PROGRESS)
                if (searchResult.status === 'NONE' ||
                    searchResult.status === 'SCHEDULED' ||
                    searchResult.status === 'IN_PROGRESS') {
                    console.log(`IcyPeas search status is '${searchResult.status}'. Continuing to poll...`);
                    // Continue polling by not returning/throwing
                } else {
                    // Unknown status - log warning but continue polling for safety
                    console.warn(`Unknown IcyPeas status: '${searchResult.status}'. Continuing to poll...`);
                }
            } else if (resultsResponse.success === false) {
                throw new Error(`Failed to get IcyPeas search results. Response: ${JSON.stringify(resultsResponse)}`);
            }
        }

        throw new Error(`IcyPeas email enrichment timed out after ${MAX_POLLS * POLL_INTERVAL / 1000} seconds.`);

    } catch (error) {
        console.error('Error during IcyPeas email enrichment process:', error);
        return { success: false, error: error.message, data: null };
    }
};
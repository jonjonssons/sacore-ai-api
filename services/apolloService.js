const axios = require('axios');

class ApolloService {
    constructor() {
        this.baseURL = 'https://api.apollo.io/api/v1';
        this.apiKey = process.env.APOLLO_API_KEY;

        if (!this.apiKey) {
            console.warn('APOLLO_API_KEY not found in environment variables');
        }
    }

    /**
     * Find LinkedIn URL for a person using name and company
     * @param {string} name - Full name of the person
     * @param {string} organizationName - Company/organization name
     * @returns {Promise<Object>} Apollo API response
     */
    async findLinkedInUrl(name, organizationName) {
        try {
            if (!this.apiKey) {
                throw new Error('Apollo API key not configured');
            }

            if (!name) {
                throw new Error('Name is required');
            }

            const params = new URLSearchParams({
                name: name.trim(),
                reveal_personal_emails: 'false',
                reveal_phone_number: 'false'
            });

            // Add organization name if provided
            if (organizationName && organizationName.trim()) {
                params.append('organization_name', organizationName.trim());
            }

            const response = await axios.get(`${this.baseURL}/people/match`, {
                params,
                headers: {
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/json',
                    'accept': 'application/json',
                    'x-api-key': this.apiKey
                },
                timeout: 10000 // 10 second timeout
            });

            if (response.data && response.data.person) {
                const person = response.data.person;

                return {
                    success: true,
                    linkedinUrl: person.linkedin_url || null,
                    person: {
                        id: person.id,
                        firstName: person.first_name,
                        lastName: person.last_name,
                        fullName: person.name,
                        title: person.title,
                        emailStatus: person.email_status,
                        linkedinUrl: person.linkedin_url
                    }
                };
            } else {
                return {
                    success: false,
                    error: 'No person found',
                    linkedinUrl: null
                };
            }

        } catch (error) {
            console.error('Apollo API error:', error.message);

            if (error.response) {
                // API returned an error response
                return {
                    success: false,
                    error: `Apollo API error: ${error.response.status} - ${error.response.data?.message || error.message}`,
                    linkedinUrl: null,
                    statusCode: error.response.status
                };
            } else if (error.request) {
                // Request was made but no response received
                return {
                    success: false,
                    error: 'Apollo API request timeout or network error',
                    linkedinUrl: null
                };
            } else {
                // Other error
                return {
                    success: false,
                    error: error.message,
                    linkedinUrl: null
                };
            }
        }
    }

    /**
     * Batch find LinkedIn URLs for multiple people
     * @param {Array} profiles - Array of profile objects with name and company
     * @param {number} delayMs - Delay between requests in milliseconds
     * @returns {Promise<Array>} Array of results
     */
    async batchFindLinkedInUrls(profiles, delayMs = 1000) {
        const results = [];

        for (let i = 0; i < profiles.length; i++) {
            const profile = profiles[i];

            try {
                console.log(`Apollo search ${i + 1}/${profiles.length}: ${profile.name}`);

                const result = await this.findLinkedInUrl(profile.name, profile.company);
                results.push({
                    index: i,
                    profile,
                    ...result
                });

                // Add delay between requests to respect rate limits
                if (i < profiles.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }

            } catch (error) {
                console.error(`Apollo batch error for ${profile.name}:`, error);
                results.push({
                    index: i,
                    profile,
                    success: false,
                    error: error.message,
                    linkedinUrl: null
                });
            }
        }

        return results;
    }
}

module.exports = new ApolloService(); 
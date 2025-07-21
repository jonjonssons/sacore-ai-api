const axios = require('axios');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Claude API key
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Check if API key is available
if (!CLAUDE_API_KEY) {
    console.warn('CLAUDE_API_KEY is not set in environment variables');
}

// Helper function to validate API key format
const isValidClaudeKey = (key) => {
    if (!key || typeof key !== 'string') return false;

    // Claude API keys typically start with 'sk-ant-' followed by alphanumeric characters
    const claudeKeyFormat = /^sk-ant-[a-zA-Z0-9\-_]{32,}$/;

    return claudeKeyFormat.test(key);
};

// Helper function to sanitize API key for logging
const sanitizeApiKey = (apiKey) => {
    if (!apiKey) return 'undefined or null';
    if (typeof apiKey !== 'string') return 'invalid type';
    if (apiKey.length < 8) return 'too short';

    return `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`;
};

// Extract profile data from multiple profiles using Claude API
exports.extractProfilesDataBatch = async (profiles, industries = []) => {
    try {
        if (!CLAUDE_API_KEY) {
            throw new Error('Claude API key is not configured');
        }

        if (!isValidClaudeKey(CLAUDE_API_KEY)) {
            throw new Error('Invalid Claude API key format');
        }

        console.log(`Extracting profile data batch for ${profiles.length} profiles using Claude`);
        console.log(`Using API key: ${sanitizeApiKey(CLAUDE_API_KEY)}`);

        // Helper function to extract location from og:description using regex for "Location:" and equivalents
        const extractLocationFromDescription = (ogDesc, snippet) => {
            const locationRegex = /(?:Location|Plats|Ort|Lieu|Ubicación|Standort|Lugar|Localización|Lokasi|Lokasyon|位置|地点|所在地)[\s]*[:\-–][\s]*([^\n\r·,;]+)/i;

            // First check og:description only
            let match = ogDesc.match(locationRegex);
            if (match && match[1]) return match[1].trim();

            // Fallback: then try snippet if not found
            match = snippet.match(locationRegex);
            if (match && match[1]) return match[1].trim();

            return '';
        };

        // Extract location from og:description for each profile if available
        const profilesWithLocation = profiles.map(profile => {
            const ogDesc = (
                profile?.pagemap?.metatags?.find(tag => tag['og:description'])?.['og:description']
            ) || '';
            const snippet = profile.snippet || '';
            const locationFromDescription = extractLocationFromDescription(ogDesc, snippet);

            return {
                ...profile,
                _extractedLocation: locationFromDescription
            };
        });

        // Prepare the user content with all profiles concatenated
        const profilesContent = profilesWithLocation.map((profile, index) => {
            return `Profile ${index + 1}:
Title: ${profile.title}
Snippet: ${profile.snippet}`;
        }).join('\n\n');

        // Prepare industries string for prompt
        const industriesString = industries.length > 0 ? industries.join(', ') : 'None';

        // Prepare the system message for Claude
        const systemMessage = `Extract LinkedIn profile information from the provided data.

Instructions:
1. For each profile, return a JSON object with these fields:
   - name: The person's full name (first and last)
   - title: Their current job title
   - company: The company they currently work at
   - location: Their location if available, if written like this anywhere "Location: " consider that as location. if not, analyse yourself
   - industry: The industry they work in, if identifiable. If the profile is similar to any of these industries: ${industriesString}, return that industry. Otherwise, return the actual industry if identifiable.

2. For the name:
   - Return ONLY the first name and last name in "First Last" format
   - If you cannot identify a name, return an empty string

3. For the company:
   - Return ONLY the company name, without any descriptors or locations
   - Ignore universities, schools, and locations UNLESS they are clearly the employer
   - If you can't determine the company with confidence, return an empty string
   - Prioritize current employment (ignore "former" positions)

4. For the location:
   - First, look for phrases like "Location: ..." in the 'og:description' or snippet fields. This is your top priority. If such a phrase is found, extract the location directly from it.
   - Accept alternate language equivalents of "Location", such as "Plats" (Swedish), "Ort" (German), "Lieu" (French), "Ubicación" (Spanish), etc., followed by a colon or dash (e.g., "Ort: Berlin", "Lieu – Paris").
   - If no such explicit "Location:" phrase is found, then infer the location from the most recent or current job/summary context (e.g., recent roles in the 'og:description', current job listings in snippet, etc.).
   - Do **not** extract locations that are part of past roles, education, or experience unless clearly marked as current.
   - Return ONLY the city and country or region (e.g., "London, United Kingdom" or "Toronto, Canada").
   - If no location is confidently determined using either method, return an empty string.

5. Return a JSON array called "profiles" with one object per profile in the same order as input.
6. Return valid JSON only - no additional text or explanations`;

        // Call Claude API to extract profile information for batch
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4000,
                temperature: 0.1,
                system: systemMessage,
                messages: [
                    {
                        role: 'user',
                        content: profilesContent
                    }
                ]
            },
            {
                headers: {
                    'x-api-key': CLAUDE_API_KEY,
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                }
            }
        );

        // Parse the response - Claude returns content in a different format than OpenAI
        const content = response.data.content[0].text;

        // Extract JSON from the response (Claude might return text with JSON inside)
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No valid JSON found in Claude response');
        }

        const extractedBatch = JSON.parse(jsonMatch[0]);

        // Override location in extractedBatch with location extracted from og:description if available
        if (extractedBatch && Array.isArray(extractedBatch.profiles)) {
            extractedBatch.profiles = extractedBatch.profiles.map((profile, index) => {
                const locationFromDescription = profilesWithLocation[index]._extractedLocation;
                if (locationFromDescription && locationFromDescription.length > 0) {
                    return {
                        ...profile,
                        location: locationFromDescription
                    };
                }
                return profile;
            });
        }

        console.log('Extracted batch profile data using Claude:', extractedBatch);

        return extractedBatch.profiles || [];
    } catch (error) {
        console.error('Error extracting batch profile data using Claude:', error);

        // Handle Claude API errors
        if (error.response) {
            const status = error.response.status;
            let message = 'Unknown Claude API error';

            if (status === 401) {
                message = 'Invalid or expired Claude API key';
            } else if (status === 429) {
                console.log("errorrrrr", error.response.data);
                message = 'Claude rate limit exceeded';
            } else if (status === 400) {
                message = 'Bad request to Claude API';
            } else if (error.response.data && error.response.data.error) {
                message = `Claude API error: ${error.response.data.error.message || error.response.data.error}`;
            }

            console.error(`Claude API error (${status}): ${message}`);
        }

        // Return empty array on error
        return [];
    }
};

// Parse job requirements from natural language query using Claude
exports.parseJobRequirements = async (query) => {
    try {
        if (!CLAUDE_API_KEY) {
            throw new Error('Claude API key is not configured');
        }

        // Updated validation for the correct API key format
        if (!CLAUDE_API_KEY.startsWith('sk-ant-api03-')) {
            throw new Error('Invalid Claude API key format - should start with sk-ant-api03-');
        }

        console.log(`Parsing job requirements from query using Claude: ${query}`);
        console.log(`Using API key: ${sanitizeApiKey(CLAUDE_API_KEY)}`);

        const systemPrompt = `You are a multilingual assistant trained to extract job-related data from user queries. Your task is to return a structured JSON object and no extra text with: - "location": a single city, country, or region - "titles": an array of job titles (e.g., ["Backend Developer"]) - "industries": an array of industries (e.g., ["Fintech", "SaaS"]) - "skills": an array of relevant skills (e.g., ["Java", "React"])  Instructions: 1. Support messy or shorthand input, typos, and abbreviations. 2. Normalize roles (e.g., "dev" → "developer", "salse" → "sales"). 3. Handle inputs in multiple languages (English, Spanish, Portuguese, German, French, Swedish, Indian languages, Chinese, etc.). 4. Return one location only, but allow multiple titles, industries, and skills. 5. Detect seniority and infer missing context when possible. 6. Only include fields in the JSON if they are non-empty (e.g., skip 'skills' if no skills are detected). Always respond with valid JSON.  Example: {   "location": "Stockholm",   "titles": ["Java Developer", "Backend Engineer"],   "industries": ["SaaS"],   "skills": ["Java", "Spring Boot"] }`;

        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 1000,
                temperature: 0.1,
                system: systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: query
                    }
                ]
            },
            {
                headers: {
                    'x-api-key': CLAUDE_API_KEY,  // Fixed: Use x-api-key instead of Authorization Bearer
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                }
            }
        );

        const content = response.data.content[0].text;
        console.log('Raw Claude response:', content);

        // Extract JSON from the response
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No valid JSON found in Claude response');
        }

        const parsedRequirements = JSON.parse(jsonMatch[0]);

        console.log('Parsed job requirements using Claude:', parsedRequirements);

        return {
            ...parsedRequirements
        };
    } catch (error) {
        console.error('Error parsing job requirements using Claude:', error.message);

        if (error.response) {
            const status = error.response.status;
            const errorData = error.response.data;

            console.error(`Claude API error (${status}):`, errorData);

            let message = 'Unknown Claude API error';

            if (status === 401) {
                message = 'Invalid or expired Claude API key';
            } else if (status === 429) {
                message = 'Claude rate limit exceeded';
            } else if (status === 400) {
                message = 'Bad request to Claude API';
            } else if (errorData?.error?.message) {
                message = `Claude API error: ${errorData.error.message}`;
            }

            console.error(`Detailed error: ${message}`);
        }

        return {
            location: null,
            titles: [],
            industries: [],
            skills: [],
        };
    }
};


// Analyze profiles against criteria using Claude
exports.analyzeProfilesBatchAgainstCriteria = async (profiles, criteria) => {
    try {
        if (!CLAUDE_API_KEY) {
            throw new Error('Claude API key is not configured');
        }

        if (!isValidClaudeKey(CLAUDE_API_KEY)) {
            throw new Error('Invalid Claude API key format');
        }

        console.log(`Analyzing batch of ${profiles.length} profiles against criteria using Claude`);
        console.log(`Using API key: ${sanitizeApiKey(CLAUDE_API_KEY)}`);
        const currentDate = new Date().toISOString().split('T')[0];

        // Helper to format experience
        const calculateExperienceSummary = (experienceArray) => {
            const today = new Date();

            const formatDuration = (months) => {
                const years = Math.floor(months / 12);
                const remainingMonths = Math.round(months % 12);
                let parts = [];
                if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`);
                if (remainingMonths > 0) parts.push(`${remainingMonths} month${remainingMonths > 1 ? 's' : ''}`);
                return parts.join(' ') || 'Less than a month';
            };

            const result = experienceArray.map(exp => {
                const start = new Date(exp.started);
                const end = exp.ended ? new Date(exp.ended) : today;
                const diffInMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
                const position = exp.position || 'Unknown Position';
                const company = exp.company || 'Unknown Company';
                const duration = formatDuration(diffInMonths);
                return `${position} at ${company}: ${duration}`;
            });

            return result.join('\n');
        };

        // Enrich each profile and prepare summaries
        const enrichedProfiles = profiles.map((profile, index) => {
            const experienceSummary = calculateExperienceSummary(profile.experience || []);
            return {
                ...profile,
                experienceSummary,
                summaryString: `Profile ${index + 1}:\n${experienceSummary}\n`
            };
        });

        const profileSummaries = enrichedProfiles.map(p => p.summaryString).join('\n');

        // System message with embedded profile experience summaries
        const systemMessage = `You are an AI assistant that evaluates LinkedIn profiles against specific job criteria.

Instructions:
1. Today's date is ${currentDate}.
2. You will receive an array of profiles and an array of evaluation criteria.
3. Use the following profile experience summaries:

${profileSummaries}

4. For EACH profile:
   - Check how well the profile satisfies EACH individual criterion.
   - Focus more on the durations if there are any in the criterias.
   - Use the experienceSummary field as a basis for evaluating each experience.
   - Also consider, calculate and analyze all the experiences with their summary of the profile whether it is from current experience or past.
   - Provide a description summarizing why the profile got that criterion matched or if the criteria doesn't match then explain why exactly it didn't matched.

5. Return a JSON array called "profiles" where each element is an object like:
  {
    profileId: <index of the profile in the input array starting from 1>,
    breakdown: [
      { criterion: "Criterion 1 text", met: true/false },
      ...
    ],
    description: "Brief summary explaining the criterion met and context"
  }

6. Do not include any markdown, commentary, or anything outside the JSON.
7. Be concise and clear in your scoring.`;

        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 4000,
                temperature: 0.2,
                system: systemMessage,
                messages: [
                    {
                        role: 'user',
                        content: `Profiles:\n${JSON.stringify(enrichedProfiles, null, 2)}\n\nCriteria:\n${JSON.stringify(criteria, null, 2)}`
                    }
                ]
            },
            {
                headers: {
                    'Authorization': `Bearer ${CLAUDE_API_KEY}`,
                    'Content-Type': 'application/json',
                    'anthropic-version': '2023-06-01'
                }
            }
        );

        const content = response.data.content[0].text;
        console.log('Raw response content from Claude:', content);

        // Extract JSON from the response
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No valid JSON found in Claude response');
        }

        const analysisResults = JSON.parse(jsonMatch[0]);

        console.log('Batch profile analysis completed using Claude');

        return analysisResults;
    } catch (error) {
        console.error('Error analyzing profiles batch against criteria using Claude:', error);

        if (error.response) {
            const status = error.response.status;
            let message = 'Unknown Claude API error';

            if (status === 401) {
                message = 'Invalid or expired Claude API key';
            } else if (status === 429) {
                message = 'Claude rate limit exceeded';
            } else if (status === 400) {
                message = 'Bad request to Claude API';
            } else if (error.response.data && error.response.data.error) {
                message = `Claude API error: ${error.response.data.error.message || error.response.data.error}`;
            }

            console.error(`Claude API error (${status}): ${message}`);
        }

        throw error;
    }
};

// Filter profiles from CSV data based on title, location, and industries
exports.filterProfilesFromCsv = async (profiles, filters) => {
    try {
        if (!CLAUDE_API_KEY) {
            throw new Error('Claude API key is not configured');
        }

        if (!isValidClaudeKey(CLAUDE_API_KEY)) {
            throw new Error('Invalid Claude API key format');
        }

        console.log(`Filtering ${profiles.length} profiles from CSV using Claude`);
        console.log(`Using API key: ${sanitizeApiKey(CLAUDE_API_KEY)}`);
        console.log('Filters:', filters);

        // Further reduce batch size for better rate limit handling
        const batchSize = 20; // Reduced from 25 to 10
        const batches = [];

        for (let i = 0; i < profiles.length; i += batchSize) {
            batches.push(profiles.slice(i, i + batchSize));
        }

        let allFilteredProfiles = [];
        const maxRetries = 3;
        let baseDelay = 1000; // Start with 1 second
        let adaptiveDelay = 1000; // 5 seconds between batches
        let consecutive429s = 0;

        console.log(`Processing ${batches.length} batches of ${batchSize} profiles each`);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(`Processing batch ${i + 1}/${batches.length} with ${batch.length} profiles`);

            let retryCount = 0;
            let success = false;
            let batchStart = Date.now();

            while (!success && retryCount < maxRetries) {
                try {
                    // Prepare the profile content for Claude
                    const profilesContent = batch.map((profile, index) => {
                        return `Profile ${index + 1}:
Title: ${profile.title}
Snippet: ${profile.snippet}`;
                    }).join('\n\n');

                    // Prepare filters string
                    const filtersText = `
Title Filter: ${filters.title || 'None'}
Location Filter: ${filters.location || 'None'}
Industries Filter: ${filters.industries && filters.industries.length > 0 ? filters.industries.join(', ') : 'None'}`;

                    // System message for Claude
                    const systemMessage = `You are an AI assistant that filters LinkedIn profiles based on specific criteria.

Instructions:
1. Analyze each profile's title and snippet against the provided filters
2. Extract the following information for each profile that matches ALL the filters:
   - title: The person's job title or professional role
   - industry: The industry they work in (inferred from their role/company)
   - location: Their location (extracted from the snippet if available)

3. Filtering Rules:
   - Title Filter: If provided, the profile's title/role should contain or be related to this filter
   - Location Filter: If provided, the profile should be located in or near this location
   - Industries Filter: If provided, the profile should work in one of these industries

4. Only return profiles that match ALL provided filters (ignore filters that are "None")
5. If no location is found in the snippet, try to infer it from company information or leave empty
6. Return a JSON object with a "profiles" array containing only the matching profiles

7. Return valid JSON only - no additional text or explanations`;

                    const response = await axios.post(
                        'https://api.anthropic.com/v1/messages',
                        {
                            model: 'claude-3-5-sonnet-20241022',
                            max_tokens: 3000, // Reduced from 4000
                            temperature: 0.1,
                            system: systemMessage,
                            messages: [
                                {
                                    role: 'user',
                                    content: `${profilesContent}\n\nFilters:${filtersText}`
                                }
                            ]
                        },
                        {
                            headers: {
                                'x-api-key': CLAUDE_API_KEY,
                                'Content-Type': 'application/json',
                                'anthropic-version': '2023-06-01'
                            }
                        }
                    );

                    const content = response.data.content[0].text;

                    // Improved JSON parsing to handle malformed responses
                    let batchResults = null;
                    try {
                        // Try to extract JSON from the response
                        let jsonMatch = content.match(/\{[\s\S]*?\}(?=\s*$|$)/);
                        if (!jsonMatch) {
                            // Try to find JSON object with "profiles" key
                            jsonMatch = content.match(/\{[^}]*"profiles"[^}]*\[[^\]]*\][^}]*\}/s);
                        }

                        if (jsonMatch) {
                            batchResults = JSON.parse(jsonMatch[0]);
                        } else {
                            console.warn(`No valid JSON found in Claude response for batch ${i + 1}`);
                            success = true; // Skip this batch
                            continue;
                        }
                    } catch (jsonError) {
                        console.warn(`JSON parsing error for batch ${i + 1}:`, jsonError.message);
                        console.warn(`Response content: ${content.substring(0, 200)}...`);
                        success = true; // Skip this batch
                        continue;
                    }

                    if (batchResults && batchResults.profiles && Array.isArray(batchResults.profiles)) {
                        allFilteredProfiles.push(...batchResults.profiles);
                        console.log(`Batch ${i + 1} completed: ${batchResults.profiles.length} profiles matched filters`);
                        consecutive429s = 0; // Reset consecutive 429 counter
                    } else {
                        console.warn(`Batch ${i + 1} returned no profiles array`);
                    }

                    success = true;

                } catch (error) {
                    retryCount++;

                    if (error.response && error.response.status === 429) {
                        consecutive429s++;
                        console.log(`Claude API rate limited (429) for batch ${i + 1}, attempt ${retryCount}/${maxRetries}`);
                        console.log(`Consecutive 429s: ${consecutive429s}`);

                        if (retryCount < maxRetries) {
                            // Exponential backoff with adaptive increase
                            const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1) * (1 + consecutive429s * 0.5), 30000);
                            console.log(`Waiting ${delay}ms before retry...`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            console.error(`Max retries reached for batch ${i + 1}. Skipping this batch.`);
                            success = true; // Skip this batch
                        }
                    } else if (error.response && error.response.status === 529) {
                        console.log(`Claude API overloaded (529) for batch ${i + 1}, attempt ${retryCount}/${maxRetries}`);

                        if (retryCount < maxRetries) {
                            const delay = baseDelay * Math.pow(3, retryCount - 1); // Longer delays for 529
                            console.log(`Waiting ${delay}ms before retry...`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            console.error(`Max retries reached for batch ${i + 1}. Skipping this batch.`);
                            success = true; // Skip this batch
                        }
                    } else {
                        console.error(`Error processing batch ${i + 1} (attempt ${retryCount}):`, error.message);
                        if (retryCount >= maxRetries) {
                            console.error(`Max retries reached for batch ${i + 1}. Skipping this batch.`);
                            success = true; // Skip this batch
                        } else {
                            // Wait before retry for other errors too
                            await new Promise(resolve => setTimeout(resolve, baseDelay));
                        }
                    }
                }
            }

            // Adaptive delay between batches based on 429 frequency
            if (i < batches.length - 1) {
                // Increase delay if we're getting many 429s
                if (consecutive429s > 3) {
                    adaptiveDelay = Math.min(adaptiveDelay * 1.5, 20000); // Max 20 seconds
                    console.log(`Increased delay to ${adaptiveDelay}ms due to frequent rate limiting`);
                } else if (consecutive429s === 0) {
                    adaptiveDelay = Math.max(adaptiveDelay * 0.9, 5000); // Min 5 seconds
                }

                console.log(`Waiting ${adaptiveDelay}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
            }
        }

        console.log(`Filtering completed: ${allFilteredProfiles.length} profiles matched all filters`);
        return allFilteredProfiles;

    } catch (error) {
        console.error('Error filtering profiles from CSV using Claude:', error);

        if (error.response) {
            const status = error.response.status;
            let message = 'Unknown Claude API error';

            if (status === 401) {
                message = 'Invalid or expired Claude API key';
            } else if (status === 429) {
                message = 'Claude rate limit exceeded - consider reducing request frequency';
            } else if (status === 529) {
                message = 'Claude service is overloaded - try again later';
            } else if (status === 400) {
                message = 'Bad request to Claude API';
            } else if (error.response.data && error.response.data.error) {
                message = `Claude API error: ${error.response.data.error.message || error.response.data.error}`;
            }

            console.error(`Claude API error (${status}): ${message}`);
        }

        throw error;
    }
}; 


const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const { default: pLimit } = require('p-limit');

// Load environment variables
dotenv.config();

// Gemini API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Check if API key is available
if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is not set in environment variables');
}

// Helper function to validate API key format
const isValidGeminiKey = (key) => {
    if (!key || typeof key !== 'string') return false;

    // Gemini API keys typically start with 'AIzaSy' followed by alphanumeric characters
    const geminiKeyFormat = /^AIzaSy[a-zA-Z0-9\-_]{33}$/;

    return geminiKeyFormat.test(key);
};

// Helper function to sanitize API key for logging
const sanitizeApiKey = (apiKey) => {
    if (!apiKey) return 'undefined or null';
    if (typeof apiKey !== 'string') return 'invalid type';
    if (apiKey.length < 8) return 'too short';

    return `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`;
};

// Filter profiles from CSV data based on title, location, and industries using Gemini
exports.filterProfilesFromCsv = async (profiles, filters) => {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        if (!isValidGeminiKey(GEMINI_API_KEY)) {
            throw new Error('Invalid Gemini API key format');
        }

        console.log(`Filtering ${profiles.length} profiles from CSV using Gemini`);
        console.log(`Using API key: ${sanitizeApiKey(GEMINI_API_KEY)}`);
        console.log('Filters:', filters);

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

        // Process in batches to avoid API limits
        const batchSize = 40; // Gemini typically handles larger batches well
        const batches = [];

        for (let i = 0; i < profiles.length; i += batchSize) {
            batches.push(profiles.slice(i, i + batchSize));
        }

        let allFilteredProfiles = [];
        const maxRetries = 3;
        let baseDelay = 1000; // Start with 1 second
        let adaptiveDelay = 500; // 0.5 second between batches (Gemini is faster)
        let consecutive429s = 0;

        console.log(`Processing ${batches.length} batches of ${batchSize} profiles each with concurrency limit of 8`);

        // Import p-limit for concurrency control

        const limit = pLimit(8); // Limit to 8 concurrent batches

        // Create batch promises with concurrency control
        const batchPromises = batches.map((batch, batchIndex) =>
            limit(async () => {
                console.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} profiles`);

                let retryCount = 0;
                let success = false;
                let batchResult = [];

                while (!success && retryCount < maxRetries) {
                    try {
                        // Add staggered delay for concurrent batches to avoid rate limiting
                        if (batchIndex > 0) {
                            const staggerDelay = (batchIndex % 8) * 200; // Stagger by 200ms per concurrent batch
                            await new Promise(resolve => setTimeout(resolve, staggerDelay));
                        }

                        // Prepare the profile content for Gemini - handle raw CSV data
                        const profilesContent = batch.map((profile, index) => {
                            // Convert raw CSV row to readable format
                            const fields = Object.keys(profile).map(key =>
                                `${key}: ${profile[key] || ''}`
                            ).join('\n');

                            return `Profile ${index + 1}:\n${fields}`;
                        }).join('\n\n');

                        // Prepare filters string
                        const filtersText = `
Title Filter: ${filters.title || 'None'}
Location Filter: ${filters.location || 'None'}
Industries Filter: ${filters.industries && filters.industries.length > 0 ? filters.industries.join(', ') : 'None'}`;

                        // Create the prompt for Gemini
                        const prompt = `You are an AI assistant for analyzing messy CSV data to extract and filter professional profiles from any language.

**Instructions:**

1.  **Multilingual Data Analysis**:
    *   The CSV data can be in ANY language (English, Spanish, French, German, Portuguese, Italian, Dutch, Swedish, Norwegian, Danish, Polish, Czech, Russian, Chinese, Japanese, Korean, Arabic, Hindi, etc.).
    *   Understand and process names, job titles, companies, locations, and industries regardless of language.
    *   Recognize common professional terms and titles across languages (e.g., "Manager", "Directeur", "Gerente", "マネージャー", "经理").
    *   Handle mixed-language data where different fields might be in different languages.

2.  **Parse Unstructured Data**:
    *   The data is not clean CSV; a single person's record may span multiple lines, often starting with a URL.
    *   Logically group lines for each person and ignore noisy lines (e.g., \`;;;;;\`, empty cells, separators).
    *   Do not rely on a fixed column order. Find information semantically from the text.
    *   Look for patterns that indicate personal/professional information.

3.  **Extract Key Information**: For each profile, extract and clean the following fields:
    *   \`name\`: Person's full name (in any language/script).
    *   \`title\`: Current job title (translate/standardize if needed).
    *   \`company\`: Current company name.
    *   \`location\`: Geographic location (standardize format: "City, Country").
    *   \`industry\`: Business sector (standardize to common English terms).
    *   \`linkedinUrl\`: LinkedIn profile URL if found (clean and validate format).
    *   \`email\`: Email address if found (validate format).

4.  **LinkedIn URL Extraction**:
    *   Look for URLs containing "linkedin.com/in/" or variations.
    *   Clean URLs: remove tracking parameters, ensure proper format.
    *   Accept variations like "linkedin.com/in/username", "www.linkedin.com/in/username".
    *   If multiple LinkedIn URLs found for same person, use the most complete one.

5.  **Email Extraction**:
    *   Look for valid email addresses (format: user@domain.ext).
    *   Prioritize professional emails over personal ones if multiple found.
    *   Validate email format before including.

6.  **Apply Filters Intelligently**:
    *   Return only profiles that match ALL provided non-"None" filters.
    *   Use flexible, language-agnostic matching for titles, locations, and industries.
    *   Include synonyms, translations, and partial matches.
    *   Examples: "Sviluppatore" (Italian) matches "Developer", "Paris" matches "París".

7.  **Output Requirements**:
    *   Return a single valid JSON object containing a "profiles" array. No extra text or explanations.
    *   The format must be *exactly*: 
    \`{"profiles": [{"name": "...", "title": "...", "company": "...", "location": "...", "industry": "...", "linkedinUrl": "...", "email": "..."}]}\`
    *   Include empty strings for fields not found (do not omit fields).
    *   Include only profiles that were successfully matched and cleaned.

**CSV Data to Analyze:**
${profilesContent}

**Filters to Apply:**
${filtersText}`;

                        const result = await model.generateContent(prompt);
                        const response = await result.response;
                        const content = response.text();

                        // Parse JSON response
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
                                // Try parsing the entire response as JSON
                                batchResults = JSON.parse(content);
                            }
                        } catch (jsonError) {
                            console.warn(`JSON parsing error for batch ${batchIndex + 1}:`, jsonError.message);
                            console.warn(`Response content: ${content.substring(0, 200)}...`);
                            success = true; // Skip this batch
                            return [];
                        }

                        if (batchResults && batchResults.profiles && Array.isArray(batchResults.profiles)) {
                            // Validate and clean the extracted profiles
                            batchResult = batchResults.profiles.map(profile => ({
                                name: profile.name || '',
                                title: profile.title || '',
                                company: profile.company || '',
                                location: profile.location || '',
                                industry: profile.industry || '',
                                linkedinUrl: profile.linkedinUrl || '',
                                email: profile.email || ''
                            }));

                            console.log(`Batch ${batchIndex + 1} completed: ${batchResult.length} profiles matched filters`);
                            consecutive429s = 0; // Reset consecutive error counter
                        } else {
                            console.warn(`Batch ${batchIndex + 1} returned no profiles array`);
                        }

                        success = true;

                    } catch (error) {
                        retryCount++;

                        // Check for different types of errors
                        if (error.status === 429 || error.message.includes('429') || error.message.includes('RATE_LIMIT')) {
                            consecutive429s++;
                            console.log(`Gemini API rate limited (429) for batch ${batchIndex + 1}, attempt ${retryCount}/${maxRetries}`);
                            console.log(`Consecutive 429s: ${consecutive429s}`);

                            if (retryCount < maxRetries) {
                                // Exponential backoff with adaptive increase
                                const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1) * (1 + consecutive429s * 0.3), 20000);
                                console.log(`Waiting ${delay}ms before retry...`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                console.error(`Max retries reached for batch ${batchIndex + 1}. Skipping this batch.`);
                                success = true; // Skip this batch
                            }
                        } else if (error.status === 503 || error.message.includes('503') || error.message.includes('SERVICE_UNAVAILABLE')) {
                            console.log(`Gemini API service unavailable (503) for batch ${batchIndex + 1}, attempt ${retryCount}/${maxRetries}`);

                            if (retryCount < maxRetries) {
                                const delay = baseDelay * Math.pow(2, retryCount - 1); // Exponential backoff
                                console.log(`Waiting ${delay}ms before retry...`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                console.error(`Max retries reached for batch ${batchIndex + 1}. Skipping this batch.`);
                                success = true; // Skip this batch
                            }
                        } else {
                            console.error(`Error processing batch ${batchIndex + 1} (attempt ${retryCount}):`, error.message);
                            if (retryCount >= maxRetries) {
                                console.error(`Max retries reached for batch ${batchIndex + 1}. Skipping this batch.`);
                                success = true; // Skip this batch
                            } else {
                                // Wait before retry for other errors too
                                await new Promise(resolve => setTimeout(resolve, baseDelay));
                            }
                        }
                    }
                }

                return batchResult;
            })
        );

        // Execute all batches concurrently and collect results
        const batchResults = await Promise.all(batchPromises);
        allFilteredProfiles = batchResults.flat();

        console.log(`Filtering completed: ${allFilteredProfiles.length} profiles matched all filters`);
        console.log(`Sample extracted profile:`, allFilteredProfiles[0] || 'No profiles found');

        return allFilteredProfiles;

    } catch (error) {
        console.error('Error filtering profiles from CSV using Gemini:', error);

        // Handle Gemini API errors
        if (error.status) {
            const status = error.status;
            let message = 'Unknown Gemini API error';

            if (status === 401) {
                message = 'Invalid or expired Gemini API key';
            } else if (status === 429) {
                message = 'Gemini rate limit exceeded - consider reducing request frequency';
            } else if (status === 503) {
                message = 'Gemini service is temporarily unavailable - try again later';
            } else if (status === 400) {
                message = 'Bad request to Gemini API';
            } else if (error.message) {
                message = `Gemini API error: ${error.message}`;
            }

            console.error(`Gemini API error (${status}): ${message}`);
        }

        throw error;
    }
};

// Clean up and standardize messy CSV data without filtering using Gemini
exports.cleanupCsvProfiles = async (profiles) => {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        if (!isValidGeminiKey(GEMINI_API_KEY)) {
            throw new Error('Invalid Gemini API key format');
        }

        console.log(`Cleaning up ${profiles.length} profiles from CSV using Gemini`);
        console.log(`Using API key: ${sanitizeApiKey(GEMINI_API_KEY)}`);

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

        // Process in batches to avoid API limits
        const batchSize = 40;
        const batches = [];

        for (let i = 0; i < profiles.length; i += batchSize) {
            batches.push(profiles.slice(i, i + batchSize));
        }

        let allCleanedProfiles = [];
        const maxRetries = 3;
        let baseDelay = 1000;
        let consecutive429s = 0;

        console.log(`Processing ${batches.length} batches of ${batchSize} profiles each with concurrency limit of 8`);

        const limit = pLimit(8);

        // Create batch promises with concurrency control
        const batchPromises = batches.map((batch, batchIndex) =>
            limit(async () => {
                console.log(`Processing cleanup batch ${batchIndex + 1}/${batches.length} with ${batch.length} profiles`);

                let retryCount = 0;
                let success = false;
                let batchResult = [];

                while (!success && retryCount < maxRetries) {
                    try {
                        // Add staggered delay for concurrent batches
                        if (batchIndex > 0) {
                            const staggerDelay = (batchIndex % 8) * 200;
                            await new Promise(resolve => setTimeout(resolve, staggerDelay));
                        }

                        // Prepare the profile content for Gemini
                        const profilesContent = batch.map((profile, index) => {
                            const fields = Object.keys(profile).map(key =>
                                `${key}: ${profile[key] || ''}`
                            ).join('\n');

                            return `Profile ${index + 1}:\n${fields}`;
                        }).join('\n\n');

                        // Create the prompt for Gemini (only profiles with valid LinkedIn URLs)
                        const prompt = `You are an AI assistant for cleaning up and standardizing messy CSV data containing professional profiles from any language.

**CRITICAL REQUIREMENT: ONLY return profiles that have VALID LinkedIn URLs. If a profile doesn't have a LinkedIn URL, exclude it completely.**

**Instructions:**

1.  **Multilingual Data Processing**:
    *   Process data in ANY language (English, Spanish, French, German, Portuguese, Italian, Dutch, Swedish, Norwegian, Danish, Polish, Czech, Russian, Chinese, Japanese, Korean, Arabic, Hindi, etc.).
    *   Understand and extract names, job titles, companies, locations, and industries regardless of language.
    *   Handle mixed-language data where different fields might be in different languages.

2.  **Parse and Clean Unstructured Data**:
    *   The data is messy CSV; a single person's record may span multiple lines, often starting with a URL.
    *   Logically group lines for each person and ignore noisy lines (e.g., \`;;;;;\`, empty cells, separators).
    *   Do not rely on fixed column order. Find information semantically from the text.
    *   Extract meaningful professional information from any structure.

3.  **Extract and Standardize Information**: For each profile, extract and clean these fields:
    *   \`name\`: Person's full name (in any language/script).
    *   \`title\`: Current job title (translate/standardize if needed).
    *   \`company\`: Current company name.
    *   \`location\`: Geographic location (standardize format: "City, Country").
    *   \`industry\`: Business sector (standardize to common English terms).
    *   \`linkedinUrl\`: LinkedIn profile URL (REQUIRED - see validation rules below).
    *   \`email\`: Email address if found (validate format).

4.  **STRICT LinkedIn URL Validation (CRITICAL)**:
    *   **ONLY include profiles that have valid LinkedIn URLs.**
    *   Look for URLs containing "linkedin.com/in/" or variations.
    *   **Validate that the LinkedIn URL belongs to the correct person:**
        - Cross-reference the LinkedIn URL path with the person's name
        - If the URL contains a username, verify it matches the person's name format
        - Be confident that this LinkedIn URL actually belongs to this specific person
    *   **Clean URLs properly (PRESERVE COMPLETE USERNAME AND SUBDOMAIN):**
        - Remove ONLY tracking parameters (?utm_, ?trk=, &ref=, etc.)
        - **PRESERVE the complete username including ALL numbers, hyphens, underscores**
        - **PRESERVE country subdomains (fi.linkedin.com, uk.linkedin.com, etc.)**
        - **DO NOT truncate or modify the username part - keep the ENTIRE username**
        - **Extract the EXACT username from the original URL including unique identifiers**
        - Accept any LinkedIn subdomain format
        - Examples of CORRECT cleaning:
          * fi.linkedin.com/in/aleksi-nylund-a99402201?trk=123 → https://fi.linkedin.com/in/aleksi-nylund-a99402201
          * uk.linkedin.com/in/john-smith-12345678 → https://uk.linkedin.com/in/john-smith-12345678
          * linkedin.com/in/ahmetozcelik1?trk=123 → https://www.linkedin.com/in/ahmetozcelik1
          * www.linkedin.com/in/maria-garcia-a1b2c3d4 → https://www.linkedin.com/in/maria-garcia-a1b2c3d4
        - **CRITICAL: Keep the ENTIRE username exactly as found, including all alphanumeric identifiers**
    *   **Exclude profiles if:**
        - No LinkedIn URL is found in the data
        - LinkedIn URL appears generic or doesn't match the person
        - LinkedIn URL format is invalid or broken
        - You're not confident the URL belongs to this person
    *   **CRITICAL: Always preserve the complete username with all numbers, hyphens, and underscores**

5.  **Email Validation**:
    *   Look for valid email addresses (format: user@domain.ext).
    *   Prioritize professional emails over personal ones if multiple found.
    *   Validate email format before including.

6.  **LinkedIn URL Filtering**: 
    *   **ONLY return profiles that have valid LinkedIn URLs.**
    *   **Do NOT include profiles without LinkedIn URLs.**
    *   **Be strict about LinkedIn URL accuracy - only include if you're confident it belongs to the person.**

7.  **Output Requirements**:
    *   Return a single valid JSON object containing a "profiles" array. No extra text or explanations.
    *   Format: \`{"profiles": [{"name": "...", "title": "...", "company": "...", "location": "...", "industry": "...", "linkedinUrl": "...", "email": "..."}]}\`
    *   **LinkedIn URL Examples (PRESERVE COMPLETE USERNAME AND SUBDOMAIN):**
        - \`"linkedinUrl": "https://fi.linkedin.com/in/aleksi-nylund-a99402201"\` (keep country subdomain and full ID)
        - \`"linkedinUrl": "https://www.linkedin.com/in/ahmetozcelik1"\` (keep the "1")
        - \`"linkedinUrl": "https://uk.linkedin.com/in/john-doe-12345678"\` (keep country subdomain and all IDs)
        - \`"linkedinUrl": "https://www.linkedin.com/in/maria-garcia-a1b2c3d4"\` (keep complete alphanumeric IDs)
    *   Include empty strings for fields not found EXCEPT linkedinUrl (which must be valid and present).
    *   **ONLY include profiles with valid, verified LinkedIn URLs.**

**CSV Data to Clean:**
${profilesContent}`;

                        const result = await model.generateContent(prompt);
                        const response = await result.response;
                        const content = response.text();

                        // Parse JSON response
                        let batchResults = null;
                        try {
                            let jsonMatch = content.match(/\{[\s\S]*?\}(?=\s*$|$)/);
                            if (!jsonMatch) {
                                jsonMatch = content.match(/\{[^}]*"profiles"[^}]*\[[^\]]*\][^}]*\}/s);
                            }

                            if (jsonMatch) {
                                batchResults = JSON.parse(jsonMatch[0]);
                            } else {
                                batchResults = JSON.parse(content);
                            }
                        } catch (jsonError) {
                            console.warn(`JSON parsing error for cleanup batch ${batchIndex + 1}:`, jsonError.message);
                            console.warn(`Response content: ${content.substring(0, 200)}...`);
                            success = true;
                            return [];
                        }

                        if (batchResults && batchResults.profiles && Array.isArray(batchResults.profiles)) {
                            // Validate and clean the extracted profiles - ONLY keep profiles with valid LinkedIn URLs
                            const profilesWithLinkedIn = batchResults.profiles.filter(profile => {
                                const linkedinUrl = profile.linkedinUrl || '';
                                // Check if LinkedIn URL exists and is valid
                                const isValid = linkedinUrl &&
                                    linkedinUrl.trim() !== '' &&
                                    (linkedinUrl.includes('linkedin.com/in/') || linkedinUrl.includes('linkedin.com/pub/')) &&
                                    linkedinUrl.length > 25; // Minimum reasonable LinkedIn URL length

                                if (!isValid && linkedinUrl) {
                                    console.warn(`Invalid LinkedIn URL filtered out: ${linkedinUrl}`);
                                }
                                return isValid;
                            });

                            batchResult = profilesWithLinkedIn.map(profile => {
                                // Clean LinkedIn URL while preserving the complete username and subdomain
                                let cleanedLinkedInUrl = profile.linkedinUrl || '';
                                if (cleanedLinkedInUrl) {
                                    // Add https:// if missing
                                    if (!cleanedLinkedInUrl.startsWith('http')) {
                                        cleanedLinkedInUrl = 'https://' + cleanedLinkedInUrl;
                                    }

                                    // Only add www. if missing AND no country subdomain exists
                                    if (cleanedLinkedInUrl.includes('linkedin.com') &&
                                        !cleanedLinkedInUrl.includes('www.') &&
                                        !cleanedLinkedInUrl.match(/https?:\/\/[a-z]{2}\.linkedin\.com/)) {
                                        // No country subdomain found, add www.
                                        cleanedLinkedInUrl = cleanedLinkedInUrl.replace('linkedin.com', 'www.linkedin.com');
                                    }

                                    // Log if URL was modified
                                    if (cleanedLinkedInUrl !== profile.linkedinUrl) {
                                        console.log(`LinkedIn URL cleaned: ${profile.linkedinUrl} → ${cleanedLinkedInUrl}`);
                                    }
                                }

                                return {
                                    name: profile.name || '',
                                    title: profile.title || '',
                                    company: profile.company || '',
                                    location: profile.location || '',
                                    industry: profile.industry || '',
                                    linkedinUrl: cleanedLinkedInUrl,
                                    email: profile.email || ''
                                };
                            });

                            console.log(`Cleanup batch ${batchIndex + 1} completed: ${batchResult.length} profiles with LinkedIn URLs (filtered from ${batchResults.profiles.length} total)`);
                            consecutive429s = 0;
                        } else {
                            console.warn(`Cleanup batch ${batchIndex + 1} returned no profiles array`);
                        }

                        success = true;

                    } catch (error) {
                        retryCount++;

                        if (error.status === 429 || error.message.includes('429') || error.message.includes('RATE_LIMIT')) {
                            consecutive429s++;
                            console.log(`Gemini API rate limited (429) for cleanup batch ${batchIndex + 1}, attempt ${retryCount}/${maxRetries}`);

                            if (retryCount < maxRetries) {
                                const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1) * (1 + consecutive429s * 0.3), 20000);
                                console.log(`Waiting ${delay}ms before retry...`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                console.error(`Max retries reached for cleanup batch ${batchIndex + 1}. Skipping this batch.`);
                                success = true;
                            }
                        } else if (error.status === 503 || error.message.includes('503') || error.message.includes('SERVICE_UNAVAILABLE')) {
                            console.log(`Gemini API service unavailable (503) for cleanup batch ${batchIndex + 1}, attempt ${retryCount}/${maxRetries}`);

                            if (retryCount < maxRetries) {
                                const delay = baseDelay * Math.pow(2, retryCount - 1);
                                console.log(`Waiting ${delay}ms before retry...`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            } else {
                                console.error(`Max retries reached for cleanup batch ${batchIndex + 1}. Skipping this batch.`);
                                success = true;
                            }
                        } else {
                            console.error(`Error processing cleanup batch ${batchIndex + 1} (attempt ${retryCount}):`, error.message);
                            if (retryCount >= maxRetries) {
                                console.error(`Max retries reached for cleanup batch ${batchIndex + 1}. Skipping this batch.`);
                                success = true;
                            } else {
                                await new Promise(resolve => setTimeout(resolve, baseDelay));
                            }
                        }
                    }
                }

                return batchResult;
            })
        );

        // Execute all batches concurrently and collect results
        const batchResults = await Promise.all(batchPromises);
        allCleanedProfiles = batchResults.flat();

        console.log(`CSV cleanup completed: ${allCleanedProfiles.length} profiles with valid LinkedIn URLs cleaned and standardized`);
        console.log(`Sample cleaned profile:`, allCleanedProfiles[0] || 'No profiles with LinkedIn URLs found');

        return allCleanedProfiles;

    } catch (error) {
        console.error('Error cleaning up CSV profiles using Gemini:', error);

        if (error.status) {
            const status = error.status;
            let message = 'Unknown Gemini API error';

            if (status === 401) {
                message = 'Invalid or expired Gemini API key';
            } else if (status === 429) {
                message = 'Gemini rate limit exceeded - consider reducing request frequency';
            } else if (status === 503) {
                message = 'Gemini service is temporarily unavailable - try again later';
            } else if (status === 400) {
                message = 'Bad request to Gemini API';
            } else if (error.message) {
                message = `Gemini API error: ${error.message}`;
            }

            console.error(`Gemini API error (${status}): ${message}`);
        }

        throw error;
    }
};

// Parse job requirements from natural language query using Gemini
exports.parseJobRequirements = async (query) => {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        if (!isValidGeminiKey(GEMINI_API_KEY)) {
            throw new Error('Invalid Gemini API key format');
        }

        console.log(`Parsing job requirements from query using Gemini: ${query}`);
        console.log(`Using API key: ${sanitizeApiKey(GEMINI_API_KEY)}`);

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `You are a multilingual assistant trained to extract job-related data from user queries.

Your task is to return a structured JSON object and no extra text with:
- "location": a single city, country, or region
- "titles": an array of job titles (e.g., ["Backend Developer"])
- "industries": an array of industries (e.g., ["Fintech", "SaaS"])
- "skills": an array of relevant skills (e.g., ["Java", "React"])

Instructions:
1. Support messy or shorthand input, typos, and abbreviations.
2. Normalize roles (e.g., "dev" → "developer", "salse" → "sales").
3. Handle inputs in multiple languages (English, Spanish, Portuguese, German, French, Swedish, Indian languages, Chinese, etc.).
4. Return one location only, but allow multiple titles, industries, and skills.
5. Detect seniority and infer missing context when possible.
6. Only include fields in the JSON if they are non-empty (e.g., skip 'skills' if no skills are detected).
Always respond with valid JSON.

Example:
{
  "location": "Stockholm",
  "titles": ["Java Developer", "Backend Engineer"],
  "industries": ["SaaS"],
  "skills": ["Java", "Spring Boot"]
}

Query: ${query}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const content = response.text();

        console.log('Raw Gemini response:', content);

        // Extract JSON from the response
        let jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No valid JSON found in Gemini response');
        }

        const parsedRequirements = JSON.parse(jsonMatch[0]);

        console.log('Parsed job requirements using Gemini:', parsedRequirements);

        return {
            ...parsedRequirements
        };
    } catch (error) {
        console.error('Error parsing job requirements using Gemini:', error.message);

        if (error.status) {
            const status = error.status;
            let message = 'Unknown Gemini API error';

            if (status === 401) {
                message = 'Invalid or expired Gemini API key';
            } else if (status === 429) {
                message = 'Gemini rate limit exceeded';
            } else if (status === 400) {
                message = 'Bad request to Gemini API';
            } else if (error.message) {
                message = `Gemini API error: ${error.message}`;
            }

            console.error(`Gemini API error (${status}): ${message}`);
        }

        return {
            location: null,
            titles: [],
            industries: [],
            skills: [],
        };
    }
};

// Generate industry variations for search optimization using Gemini
exports.generateIndustryVariations = async (industry, searchEngine = 'google') => {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        if (!isValidGeminiKey(GEMINI_API_KEY)) {
            throw new Error('Invalid Gemini API key format');
        }

        console.log(`Generating industry variations for "${industry}" (${searchEngine}) using Gemini`);

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        let prompt;
        if (searchEngine === 'brave') {
            prompt = `Generate 3-5 single-word variations of the industry term "${industry}" for search optimization.

Requirements:
- Only return single words (no spaces, hyphens, or multi-word phrases)
- Focus on commonly used industry terms
- Include synonyms and related terms
- Make variations search-friendly

Return only a JSON array of strings, no other text.
Example: ["fintech", "finance", "banking", "payments"]

Industry: ${industry}`;
        } else {
            prompt = `Generate 3-5 variations of the industry term "${industry}" for search optimization.

Requirements:
- Include both single words and multi-word phrases
- Focus on commonly used industry terms
- Include synonyms and related terms
- Make variations search-friendly

Return only a JSON array of strings, no other text.
Example: ["financial technology", "fintech", "banking", "financial services"]

Industry: ${industry}`;
        }

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const content = response.text();

        console.log('Raw Gemini response for industry variations:', content);

        // Extract JSON from the response
        let jsonMatch = content.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            throw new Error('No valid JSON array found in Gemini response');
        }

        const variations = JSON.parse(jsonMatch[0]);

        console.log(`Generated ${variations.length} industry variations for "${industry}":`, variations);

        return variations;
    } catch (error) {
        console.error('Error generating industry variations using Gemini:', error.message);

        // Return fallback variations based on the original industry
        const fallbackVariations = [industry.toLowerCase()];

        if (searchEngine === 'brave') {
            // Single word fallbacks
            const singleWordMap = {
                'fintech': ['fintech', 'finance', 'banking'],
                'saas': ['saas', 'software', 'tech'],
                'healthcare': ['healthcare', 'medical', 'health'],
                'manufacturing': ['manufacturing', 'industrial', 'production'],
                'retail': ['retail', 'commerce', 'sales'],
                'education': ['education', 'learning', 'academic'],
                'consulting': ['consulting', 'advisory', 'services'],
                'technology': ['technology', 'tech', 'software'],
                'marketing': ['marketing', 'advertising', 'promotion'],
                'finance': ['finance', 'banking', 'investment']
            };

            const industryLower = industry.toLowerCase();
            for (const [key, values] of Object.entries(singleWordMap)) {
                if (industryLower.includes(key)) {
                    fallbackVariations.push(...values);
                    break;
                }
            }
        } else {
            // Multi-word fallbacks
            fallbackVariations.push(industry);
        }

        return [...new Set(fallbackVariations)]; // Remove duplicates
    }
};

// Convert industry to most relevant predefined industry using Gemini
exports.convertToRelevantIndustry = async (industry) => {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        if (!isValidGeminiKey(GEMINI_API_KEY)) {
            throw new Error('Invalid Gemini API key format');
        }

        console.log(`Converting industry "${industry}" to relevant predefined industry using Gemini`);

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `Convert the industry "${industry}" to the most relevant predefined industry category.

Choose from these predefined categories:
- Technology
- Healthcare
- Finance
- Manufacturing
- Retail
- Education
- Consulting
- Marketing
- Real Estate
- Energy
- Transportation
- Entertainment
- Government
- Non-profit
- Agriculture
- Construction
- Telecommunications
- Pharmaceuticals
- Automotive
- Food & Beverage

Return only the single most relevant category name, no other text.

Industry: ${industry}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const content = response.text().trim();

        console.log(`Converted industry "${industry}" to: ${content}`);

        return content;
    } catch (error) {
        console.error('Error converting industry using Gemini:', error.message);

        // Return fallback mapping
        const industryLower = industry.toLowerCase();
        const fallbackMap = {
            'fintech': 'Finance',
            'saas': 'Technology',
            'software': 'Technology',
            'tech': 'Technology',
            'healthcare': 'Healthcare',
            'medical': 'Healthcare',
            'finance': 'Finance',
            'banking': 'Finance',
            'manufacturing': 'Manufacturing',
            'retail': 'Retail',
            'education': 'Education',
            'consulting': 'Consulting',
            'marketing': 'Marketing',
            'realestate': 'Real Estate',
            'energy': 'Energy',
            'transportation': 'Transportation',
            'entertainment': 'Entertainment',
            'government': 'Government',
            'nonprofit': 'Non-profit',
            'agriculture': 'Agriculture',
            'construction': 'Construction',
            'telecommunications': 'Telecommunications',
            'pharmaceutical': 'Pharmaceuticals',
            'automotive': 'Automotive',
            'food': 'Food & Beverage'
        };

        for (const [key, value] of Object.entries(fallbackMap)) {
            if (industryLower.includes(key)) {
                return value;
            }
        }

        return 'Technology'; // Default fallback
    }
};

const tryGeminiWithFallback = async (genAI, prompt, primaryModel = 'gemini-1.5-pro', fallbackModel = 'gemini-1.5-flash') => {
    let lastError = null;

    // Try primary model first (gemini-1.5-pro)
    try {
        console.log(`Trying primary Gemini model: ${primaryModel}`);
        const model = genAI.getGenerativeModel({
            model: primaryModel,
            generationConfig: {
                temperature: 0.2,
            }
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const content = response.text();

        console.log(`✓ Success with ${primaryModel}`);
        return { content, modelUsed: primaryModel };

    } catch (primaryError) {
        console.warn(`✗ Primary model ${primaryModel} failed:`, primaryError.message);
        lastError = primaryError;

        // Try fallback model (gemini-1.5-flash)
        try {
            console.log(`Trying fallback Gemini model: ${fallbackModel}`);
            const fallbackModelInstance = genAI.getGenerativeModel({
                model: fallbackModel,
                generationConfig: {
                    temperature: 0.2,
                }
            });

            const result = await fallbackModelInstance.generateContent(prompt);
            const response = await result.response;
            const content = response.text();

            console.log(`✓ Success with fallback model ${fallbackModel}`);
            return { content, modelUsed: fallbackModel };

        } catch (fallbackError) {
            console.error(`✗ Fallback model ${fallbackModel} also failed:`, fallbackError.message);
            console.error('Both Gemini models failed, will trigger OpenAI fallback');

            // Throw the more serious error (or the last one)
            const errorToThrow = fallbackError.status === 429 || fallbackError.status === 503 ? fallbackError : primaryError;
            throw errorToThrow;
        }
    }
};

// Extract profiles data from batch using Gemini
exports.extractProfilesDataBatch = async (profiles, industries = [], titleFilters = [], locationFilters = []) => {
    try {
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key is not configured');
        }

        if (!isValidGeminiKey(GEMINI_API_KEY)) {
            throw new Error('Invalid Gemini API key format');
        }

        console.log(`Extracting profile data batch for ${profiles.length} profiles`);
        console.log(`Using Gemini API key: ${sanitizeApiKey(GEMINI_API_KEY)}`);

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

        // Initialize Gemini AI
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

        // Prepare profiles content
        const profilesContent = profilesWithLocation.map((profile, index) => {
            return `Profile ${index + 1}:
Title: ${profile.title}
Snippet: ${profile.snippet}`;
        }).join('\n\n');

        // Prepare filter strings for prompt
        const industriesString = industries.length > 0 ? industries.join(', ') : 'None';
        const titleFiltersString = titleFilters.length > 0 ? titleFilters.join(', ') : 'None';
        const locationFiltersString = locationFilters.length > 0 ? locationFilters.join(', ') : 'None';

        const prompt = `Extract LinkedIn profile information from the provided data using the following search filters as context for more accurate extraction.

Search Context Filters:
- Title Filters: ${titleFiltersString}
- Location Filters: ${locationFiltersString}
- Industry Filters: ${industriesString}

Instructions:
1. For each profile, return a JSON object with these fields:
   - name: The person's full name (first and last)
   - title: Their current job title (prioritize titles that match or are related to the title filters: ${titleFiltersString})
   - company: The company they currently work at
   - location: Their location (prioritize locations that match the location filters: ${locationFiltersString})
   - industry: The industry they work in (prioritize industries that match the industry filters: ${industriesString})

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
   - Accept alternate language equivalents of "Location", such as "Plats" (Swedish), "Ort" (German), "Lieu" (French), "Ubicación" (Spanish), etc., followed by a colon or dash (e.g., "Ort: Berlin", "Lieu-Paris").
   - If no such explicit "Location:" phrase is found, then infer the location from the most recent or current job/summary context.
   - When possible, prioritize locations that match or are near the target locations: ${locationFiltersString}
   - Do **not** extract locations that are part of past roles, education, or experience unless clearly marked as current.
   - Return ONLY the city and country or region (e.g., "London, United Kingdom" or "Toronto, Canada").
   - If no location is confidently determined using either method, return an empty string.

5. For the title:
   - Extract the current job title or professional role
   - When possible, prioritize titles that match or are related to the target roles: ${titleFiltersString}
   - If multiple titles are mentioned, choose the most current/recent one
   - If you can't determine a clear title, return an empty string

6. For the industry:
   - First, try to match with one of the target industries: ${industriesString} using reasoning.
   - Consider:
    - The person's job title (e.g., "Product Manager" → "software")
    - Keywords or context in the snippet (e.g., "cloud platform", "banking systems", "e-commerce")
    - The nature of the current employer if recognizable (e.g., "Shopify" → "e-commerce")
    - If a clear match is found with the target industries, use that industry
    - If no clear match is found with target industries, infer the actual industry by:
    - Looking at the language in their description
    - Reasoning about the employer's domain
    - Using general knowledge about the company or role
    - Return the best-fitting industry. If no clear industry is supported, return an empty string ""

7. Return EXACTLY this JSON format with no additional text:
{
  "profiles": [
    {
      "name": "Full Name",
      "title": "Job Title", 
      "company": "Company Name",
      "location": "City, Country",
      "industry": "Industry"
    }
  ]
}
8. Return valid JSON only - no markdown, no code blocks, no additional text or explanations.

Here are the profiles to analyze:

${profilesContent}`;

        // Try Gemini models with cascading fallback
        const { content, modelUsed } = await tryGeminiWithFallback(genAI, prompt);

        console.log(`Raw Gemini response for profile extraction (${modelUsed}):`, content.substring(0, 500));

        // Enhanced JSON parsing with better error handling
        let extractedBatch;
        // First, clean the response - remove any leading text like "json"
        let cleanedContent = content.trim();
        try {

            // Remove leading "json" or similar prefixes
            if (cleanedContent.toLowerCase().startsWith('json')) {
                cleanedContent = cleanedContent.substring(4).trim();
            }

            // Remove markdown code block markers if present
            cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');

            // Try to extract JSON object using multiple strategies
            let jsonMatch = null;

            // Strategy 1: Look for complete JSON object with profiles array
            jsonMatch = cleanedContent.match(/\{\s*"profiles"\s*:\s*\[[\s\S]*?\]\s*\}/);

            if (!jsonMatch) {
                // Strategy 2: Look for any complete JSON object
                jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
            }

            if (!jsonMatch) {
                // Strategy 3: Try to find just the profiles array and wrap it
                const profilesArrayMatch = cleanedContent.match(/"profiles"\s*:\s*(\[[\s\S]*?\])/);
                if (profilesArrayMatch) {
                    jsonMatch = [`{"profiles": ${profilesArrayMatch[1]}}`];
                }
            }

            if (jsonMatch) {
                let jsonStr = jsonMatch[0];

                // Fix common JSON issues
                // Remove trailing commas before closing brackets/braces
                jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');

                // Ensure the JSON is complete - if it ends abruptly, try to close it
                const openBraces = (jsonStr.match(/\{/g) || []).length;
                const closeBraces = (jsonStr.match(/\}/g) || []).length;
                const openBrackets = (jsonStr.match(/\[/g) || []).length;
                const closeBrackets = (jsonStr.match(/\]/g) || []).length;

                // Add missing closing braces/brackets
                for (let i = 0; i < openBrackets - closeBrackets; i++) {
                    jsonStr += ']';
                }
                for (let i = 0; i < openBraces - closeBraces; i++) {
                    jsonStr += '}';
                }

                extractedBatch = JSON.parse(jsonStr);
            } else {
                // Last resort: try parsing the entire cleaned content
                extractedBatch = JSON.parse(cleanedContent);
            }
        } catch (jsonError) {
            console.warn(`JSON parsing error for profile extraction (${modelUsed}):`, jsonError.message);
            console.warn(`Cleaned content (first 500 chars): ${cleanedContent.substring(0, 500)}...`);

            // Try to extract partial data by looking for individual profiles
            try {
                const profileMatches = content.match(/"name"\s*:\s*"[^"]*"/g);
                if (profileMatches && profileMatches.length > 0) {
                    console.log(`Found ${profileMatches.length} profile name matches, attempting partial extraction`);

                    // Create a minimal response with empty profiles array
                    extractedBatch = { profiles: [] };

                    // Try to extract what we can from the partial response
                    const partialProfiles = [];
                    const nameMatches = content.match(/"name"\s*:\s*"([^"]*)"/g);
                    const titleMatches = content.match(/"title"\s*:\s*"([^"]*)"/g);
                    const companyMatches = content.match(/"company"\s*:\s*"([^"]*)"/g);

                    if (nameMatches) {
                        nameMatches.forEach((match, index) => {
                            const name = match.match(/"name"\s*:\s*"([^"]*)"/)[1];
                            const title = titleMatches && titleMatches[index] ?
                                titleMatches[index].match(/"title"\s*:\s*"([^"]*)"/)[1] : '';
                            const company = companyMatches && companyMatches[index] ?
                                companyMatches[index].match(/"company"\s*:\s*"([^"]*)"/)[1] : '';

                            partialProfiles.push({
                                name: name,
                                title: title,
                                company: company,
                                location: '',
                                industry: ''
                            });
                        });

                        extractedBatch.profiles = partialProfiles;
                        console.log(`Extracted ${partialProfiles.length} partial profiles`);
                    }
                } else {
                    extractedBatch = { profiles: [] };
                }
            } catch (partialError) {
                console.warn('Partial extraction also failed:', partialError.message);
                extractedBatch = { profiles: [] };
            }
        }

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

        console.log(`Extracted batch profile data using ${modelUsed}:`, extractedBatch);

        return extractedBatch.profiles || [];

    } catch (error) {
        console.error('Error extracting batch profile data:', error);

        // Handle Gemini API errors - PROPERLY THROW THEM for fallback to OpenAI
        if (error.status === 503) {
            console.error('Gemini service is overloaded (503) - throwing error for OpenAI fallback');
            throw new Error(`Gemini service overloaded: ${error.message}`);
        } else if (error.status === 429) {
            console.error('Gemini rate limit exceeded (429) - throwing error for OpenAI fallback');
            throw new Error(`Gemini rate limited: ${error.message}`);
        } else if (error.status === 401) {
            console.error('Invalid Gemini API key (401) - throwing error for OpenAI fallback');
            throw new Error(`Gemini authentication failed: ${error.message}`);
        } else if (error.status === 400) {
            console.error('Bad request to Gemini API (400) - throwing error for OpenAI fallback');
            throw new Error(`Gemini bad request: ${error.message}`);
        } else {
            // For any other error, also throw it to trigger OpenAI fallback
            console.error('Unknown Gemini error - throwing error for OpenAI fallback');
            throw new Error(`Gemini error: ${error.message || error}`);
        }
    }
};
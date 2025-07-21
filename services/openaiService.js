const axios = require('axios');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Check if API key is available
if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is not set in environment variables');
}

// Helper function to validate API key format
const isValidOpenAIKey = (key) => {
  if (!key || typeof key !== 'string') return false;

  const oldFormat = /^sk-[a-zA-Z0-9]{32,}$/;
  const newFormat = /^sk-proj-[a-zA-Z0-9\-_]{80,}$/;

  return oldFormat.test(key) || newFormat.test(key);
};


// Helper function to sanitize API key for logging
const sanitizeApiKey = (apiKey) => {
  if (!apiKey) return 'undefined or null';
  if (typeof apiKey !== 'string') return 'invalid type';
  if (apiKey.length < 8) return 'too short';

  return `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`;
};

// Extract profile data from LinkedIn URL
exports.extractProfileDataFromUrl = async (url) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Extracting profile data from URL: ${url}`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    // Simulate a Google search result for the LinkedIn URL
    const title = `LinkedIn Profile | ${url}`;
    const snippet = `Professional profile on LinkedIn. View the profile to see more details.`;

    // Call OpenAI API to extract profile information
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Extract LinkedIn profile information from the provided data.

Instructions:
1. Return a JSON object with these fields:
   - name: The person's full name (first and last)
   - title: Their current job title
   - company: The company they currently work at
   - location: Their location if available

2. For the name:
   - Return ONLY the first name and last name in "First Last" format
   - If you cannot identify a name, return an empty string

3. For the company:
   - Return ONLY the company name, without any descriptors or locations
   - Ignore universities, schools, and locations UNLESS they are clearly the employer
   - If you can't determine the company with confidence, return an empty string
   - Prioritize current employment (ignore "former" positions)

4. Return valid JSON only - no additional text or explanations`
          },
          {
            role: 'user',
            content: `URL: ${url}
Title: ${title}
Snippet: ${snippet}`
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    const content = response.data.choices[0].message.content;
    const extractedData = JSON.parse(content);

    console.log('Extracted profile data:', extractedData);

    return {
      name: extractedData.name || '',
      title: extractedData.title || '',
      company: extractedData.company || '',
      location: extractedData.location || '',
      skills: [],
      experience: [],
      education: []
    };
  } catch (error) {
    console.error('Error extracting profile data from URL:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    // Return empty data on error
    return {
      name: '',
      title: '',
      company: '',
      location: '',
      skills: [],
      experience: [],
      education: []
    };
  }
};

// Analyze profile text
exports.analyzeProfileText = async (text) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log('Analyzing profile text');

    // Call OpenAI API to analyze the text
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Analyze the provided LinkedIn profile text and extract structured information.

Instructions:
1. Return a JSON object with these fields:
   - name: The person's full name
   - title: Their current job title
   - company: The company they currently work at
   - location: Their location
   - skills: Array of skills mentioned
   - experience: Array of work experiences, each with title, company, duration
   - education: Array of education entries, each with school, degree, field

2. Return valid JSON only - no additional text or explanations`
          },
          {
            role: 'user',
            content: text
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    const content = response.data.choices[0].message.content;
    const analysis = JSON.parse(content);

    console.log('Profile analysis completed');

    return analysis;
  } catch (error) {
    console.error('Error analyzing profile text:', error);
    throw error;
  }
};

// Extract profile data from title and snippet
exports.extractProfileData = async (title, description) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Extracting profile data from title, description and snippet`);
    console.log(`Title: ${title}`);
    console.log(`Description: ${description}`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    // Call OpenAI API to extract profile information
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Extract LinkedIn profile information from the provided data.

Instructions:
1. Return a JSON object with these fields:
   - name: The person's full name (first and last)
   - title: Their current job title
   - company: The company they currently work at
   - location: Their location if available

2. For the name:
   - Return ONLY the first name and last name in "First Last" format
   - If you cannot identify a name, return an empty string

3. For the company:
   - Return ONLY the company name, without any descriptors or locations
   - Ignore universities, schools, and locations UNLESS they are clearly the employer
   - If you can't determine the company with confidence, return an empty string
   - Prioritize current employment (ignore "former" positions)

4. For the location:
   - Return ONLY the city and state, if available
   - If you cannot determine the location with confidence, return an empty string
   - location can also be present in the description with other languages than english

5. Return valid JSON only - no additional text or explanations`
          },
          {
            role: 'user',
            content: `Title: ${title}
Description: ${description}`
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    const content = response.data.choices[0].message.content;
    const extractedData = JSON.parse(content);

    console.log('Extracted profile data:', extractedData);

    return {
      name: extractedData.name || '',
      title: extractedData.title || '',
      company: extractedData.company || '',
      location: extractedData.location || '',
      skills: [],
      experience: [],
      education: []
    };
  } catch (error) {
    console.error('Error extracting profile data from title and snippet:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    // Return empty data on error
    return {
      name: '',
      title: '',
      company: '',
      location: '',
      skills: [],
      experience: [],
      education: []
    };
  }
};

// New batch extraction function for multiple profiles
// New batch extraction function for multiple profiles
exports.extractProfilesDataBatch = async (profiles, industries = [], titleFilters = [], locationFilters = []) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Extracting profile data batch for ${profiles.length} profiles`);
    console.log(`Using OpenAI API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

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

7. Return a JSON array called "profiles" with one object per profile in the same order as input.
8. Return valid JSON only - no additional text or explanations.

Here are the profiles to analyze:

${profilesContent}`;

    // Call OpenAI API to extract profile information for batch
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: prompt
          },
          {
            role: 'user',
            content: profilesContent
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    const content = response.data.choices[0].message.content;

    console.log('Raw OpenAI response for profile extraction:', content.substring(0, 500));

    // Enhanced JSON parsing with better error handling (similar to Gemini service)
    let extractedBatch;
    try {
      // First, clean the response - remove any leading text like "json"
      let cleanedContent = content.trim();

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
      console.warn('JSON parsing error for profile extraction:', jsonError.message);
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
        const locationFromDescription = profilesWithLocation[index]?._extractedLocation;
        if (locationFromDescription && locationFromDescription.length > 0) {
          return {
            ...profile,
            location: locationFromDescription
          };
        }
        return profile;
      });
    }

    console.log('Extracted batch profile data:', extractedBatch);

    return extractedBatch.profiles || [];

  } catch (error) {
    console.error('Error extracting batch profile data:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    // Return empty array on error
    return [];
  }
};


// Parse job requirements from natural language query
exports.parseJobRequirements = async (query) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Parsing job requirements from query: ${query}`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    const systemPrompt = `
    You are a multilingual assistant trained to extract job-related data from user queries.
    
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
    6. Only include fields in the JSON if they are non-empty** (e.g., skip 'skills' if no skills are detected).
    Always respond with valid JSON.
    
    Example:
    {
      "location": "Stockholm",
      "titles": ["Java Developer", "Backend Engineer"],
      "industries": ["SaaS"],
      "skills": ["Java", "Spring Boot"]
    },
    {
      "location": "Berlin",
      "titles": ["Backend Developer", "Software Engineer"],
      "industries": ["SaaS"]
    }
    `.trim();


    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const parsedRequirements = JSON.parse(content);

    console.log('Parsed job requirements:', parsedRequirements);

    return {
      ...parsedRequirements
    };
  } catch (error) {
    console.error('Error parsing job requirements:', error);

    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data?.error?.message) {
        message = `OpenAI API error: ${error.response.data.error.message}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    return {
      locations: [],
      titles: [],
      industries: [],
      skills: [],
    };
  }
};


// Analyze profile against criteria
exports.analyzeProfileAgainstCriteria = async (profile, criteria) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log('Analyzing profile against criteria');
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    // Call OpenAI API to analyze the profile against criteria
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an AI assistant that evaluates LinkedIn profiles against specific job criteria.

Instructions:
1. Analyze the provided LinkedIn profile data against the given criteria.
2. Return a JSON object with these fields:
   - score: A relevance score from 1-100 (higher is better)
   - description: A brief explanation of why this score was given, highlighting how the profile matches or doesn't match the criteria

3. When scoring:
   - 90-100: Perfect match, exceeds all criteria
   - 70-89: Strong match, meets most criteria
   - 50-69: Moderate match, meets some criteria
   - 30-49: Weak match, meets few criteria
   - 1-29: Poor match, meets almost none of the criteria

4. Constraints:
   - Return only a valid JSON object
   - Do not include any additional commentary, markdown, or explanations outside the JSON`
          },
          {
            role: 'user',
            content: `Profile Data:\n${JSON.stringify(profile, null, 2)}\n\nCriteria:\n${criteria}`
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    const content = response.data.choices[0].message.content;
    const analysis = JSON.parse(content);

    console.log('Profile analysis completed');

    return analysis;
  } catch (error) {
    console.error('Error analyzing profile against criteria:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    throw error;
  }
};


// Add this new function to analyze multiple profiles in a single API call
// exports.analyzeProfilesBatchAgainstCriteria = async (profiles, criteria) => {
//   try {
//     if (!OPENAI_API_KEY) {
//       throw new Error('OpenAI API key is not configured');
//     }

//     if (!isValidOpenAIKey(OPENAI_API_KEY)) {
//       throw new Error('Invalid OpenAI API key format');
//     }

//     console.log(`Analyzing batch of ${profiles.length} profiles against criteria`);
//     console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);
//     const currentDate = new Date().toISOString().split('T')[0];

//     // Add helper to format experience
//     const calculateExperienceSummary = (experienceArray) => {
//       const today = new Date();

//       const formatDuration = (months) => {
//         const years = Math.floor(months / 12);
//         const remainingMonths = Math.round(months % 12);
//         let parts = [];
//         if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`);
//         if (remainingMonths > 0) parts.push(`${remainingMonths} month${remainingMonths > 1 ? 's' : ''}`);
//         return parts.join(' ') || 'Less than a month';
//       };

//       const result = experienceArray.map(exp => {
//         const start = new Date(exp.started);
//         const end = exp.ended ? new Date(exp.ended) : today;
//         const diffInMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
//         const position = exp.position || 'Unknown Position';
//         const company = exp.company || 'Unknown Company';
//         const duration = formatDuration(diffInMonths);
//         return `${position} at ${company}: ${duration}`;
//       });

//       return result.join('\n');
//     };

//     // Enrich each profile with experienceSummary before sending to OpenAI
//     const enrichedProfiles = profiles.map(profile => ({
//       ...profile,
//       experienceSummary: calculateExperienceSummary(profile.experience || [])
//     }));

//     const response = await axios.post(
//       'https://api.openai.com/v1/chat/completions',
//       {
//         model: 'gpt-4o-mini',
//         temperature: 0.2,
//         messages: [
//           {
//             role: 'system',
//             content: `You are an AI assistant that evaluates LinkedIn profiles against specific job criteria.

//             Profile's Experience Summary: 
//         Instructions:
//         1. Today's date is ${currentDate}.
//         2. You will receive an array of profiles and an array of evaluation criteria.
//         3. For EACH profile:
//            - Check how well the profile satisfies EACH individual criterion.
//            - Focus more on the durations if there are any in the criterias.
//            - Use the "experienceSummary" field which summarizes positions, companies, and durations.
//            - Also consider, calculate and analyze all the experiences with their summary of the profile whether it is from current experience or past.
//            - Provide a description summarizing why the profile got that criterion matched or if the criteria doesn't match then explain why exactly it didn't matched.
//         4. Return a JSON array called "profiles" where each element is an object like:
//           {
//             profileId: <index of the profile in the input array starting from 1>,
//             breakdown: [
//               { criterion: "Criterion 1 text", met: true/false },
//               ...
//             ],
//             description: "Brief summary explaining the criterion met and context"
//           }
//         5. Do not include any markdown, commentary, or anything outside the JSON.
//         6. Be concise and clear in your scoring.`
//           },
//           {
//             role: 'user',
//             content: `Profiles:\n${JSON.stringify(enrichedProfiles, null, 2)}\n\nCriteria:\n${JSON.stringify(criteria, null, 2)}`
//           }
//         ],
//         response_format: { type: "json_object" }
//       },
//       {
//         headers: {
//           'Authorization': `Bearer ${OPENAI_API_KEY}`,
//           'Content-Type': 'application/json'
//         }
//       }
//     );

//     // Parse the response
//     const content = response.data.choices[0].message.content;
//     console.log('Raw response content from OpenAI:', content);

//     const analysisResults = JSON.parse(content);

//     console.log('Batch profile analysis completed');

//     return analysisResults;
//   } catch (error) {
//     console.error('Error analyzing profiles batch against criteria:', error);

//     if (error.response) {
//       const status = error.response.status;
//       let message = 'Unknown OpenAI API error';

//       if (status === 401) {
//         message = 'Invalid or expired OpenAI API key';
//       } else if (status === 429) {
//         message = 'OpenAI rate limit exceeded';
//       } else if (status === 400) {
//         message = 'Bad request to OpenAI API';
//       } else if (error.response.data && error.response.data.error) {
//         message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
//       }

//       console.error(`OpenAI API error (${status}): ${message}`);
//     }

//     throw error;
//   }
// };

exports.analyzeProfilesBatchAgainstCriteria = async (profiles, criteria) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Analyzing batch of ${profiles.length} profiles against criteria`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);
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
    const systemMessage = `
You are an AI assistant that evaluates LinkedIn profiles against specific job criteria.

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
7. Be concise and clear in your scoring.
    `.trim();

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: systemMessage
          },
          {
            role: 'user',
            content: `Profiles:\n${JSON.stringify(enrichedProfiles, null, 2)}\n\nCriteria:\n${JSON.stringify(criteria, null, 2)}`
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    console.log('Raw response content from OpenAI:', content);

    const analysisResults = JSON.parse(content);

    console.log('Batch profile analysis completed');

    return analysisResults;
  } catch (error) {
    console.error('Error analyzing profiles batch against criteria:', error);

    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    throw error;
  }
};

// Convert industry input to the most relevant predefined industry
exports.convertToRelevantIndustry = async (industryInput) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    if (!industryInput || typeof industryInput !== 'string') {
      return industryInput; // Return as-is if invalid input
    }

    console.log(`Converting industry input: ${industryInput}`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    const predefinedIndustries = [
      'Defense & Space',
      'Computer Hardware',
      'Computer Software',
      'Computer Networking',
      'Internet',
      'Semiconductors',
      'Telecommunications',
      'Law Practice',
      'Legal Services',
      'Management Consulting',
      'Biotechnology',
      'Medical Practice',
      'Hospital & Health Care',
      'Pharmaceuticals',
      'Veterinary',
      'Medical Devices',
      'Cosmetics',
      'Apparel & Fashion',
      'Sporting Goods',
      'Tobacco',
      'Supermarkets',
      'Food Production',
      'Consumer Electronics',
      'Consumer Goods',
      'Furniture',
      'Retail',
      'Entertainment',
      'Gambling & Casinos',
      'Leisure, Travel & Tourism',
      'Hospitality',
      'Restaurants',
      'Sports',
      'Food & Beverages',
      'Motion Pictures and Film',
      'Broadcast Media',
      'Museums and Institutions',
      'Fine Art',
      'Performing Arts',
      'Recreational Facilities and Services',
      'Banking',
      'Insurance',
      'Financial Services',
      'Real Estate',
      'Investment Banking',
      'Investment Management',
      'Accounting',
      'Construction',
      'Building Materials',
      'Architecture & Planning',
      'Civil Engineering',
      'Aviation & Aerospace',
      'Automotive',
      'Chemicals',
      'Machinery',
      'Mining & Metals',
      'Oil & Energy',
      'Shipbuilding',
      'Utilities',
      'Textiles',
      'Paper & Forest Products',
      'Railroad Manufacture',
      'Farming',
      'Ranching',
      'Dairy',
      'Fishery',
      'Primary/Secondary Education',
      'Higher Education',
      'Education Management',
      'Research',
      'Military',
      'Legislative Office',
      'Judiciary',
      'International Affairs',
      'Government Administration',
      'Executive Office',
      'Law Enforcement',
      'Public Safety',
      'Public Policy',
      'Marketing and Advertising',
      'Newspapers',
      'Publishing',
      'Printing',
      'Information Services',
      'Libraries',
      'Environmental Services',
      'Package/Freight Delivery',
      'Individual & Family Services',
      'Religious Institutions',
      'Civic & Social Organization',
      'Consumer Services',
      'Transportation/Trucking/Railroad',
      'Warehousing',
      'Airlines/Aviation',
      'Maritime',
      'Information Technology and Services',
      'Market Research',
      'Public Relations and Communications',
      'Design',
      'Nonprofit Organization Management',
      'Fund-Raising',
      'Program Development',
      'Writing and Editing',
      'Staffing and Recruiting',
      'Professional Training & Coaching',
      'Venture Capital & Private Equity',
      'Political Organization',
      'Translation and Localization',
      'Computer Games',
      'Events Services',
      'Arts and Crafts',
      'Electrical/Electronic Manufacturing',
      'Online Media',
      'Nanotechnology',
      'Music',
      'Logistics and Supply Chain',
      'Plastics',
      'Computer & Network Security',
      'Wireless',
      'Alternative Dispute Resolution',
      'Security and Investigations',
      'Facilities Services',
      'Outsourcing/Offshoring',
      'Health, Wellness and Fitness',
      'Alternative Medicine',
      'Media Production',
      'Animation',
      'Commercial Real Estate',
      'Capital Markets',
      'Think Tanks',
      'Philanthropy',
      'E-Learning',
      'Wholesale',
      'Import and Export',
      'Mechanical or Industrial Engineering',
      'Photography',
      'Human Resources',
      'Business Supplies and Equipment',
      'Mental Health Care',
      'Graphic Design',
      'International Trade and Development',
      'Wine and Spirits',
      'Luxury Goods & Jewelry',
      'Renewables & Environment',
      'Glass, Ceramics & Concrete',
      'Packaging and Containers',
      'Industrial Automation',
      'Government Relations'
    ];

    // Call OpenAI API to find the most relevant industry
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an industry classification assistant. Your task is to match user input to the most relevant industry from a predefined list.

Instructions:
1. Analyze the input industry/term and find the MOST RELEVANT match from the predefined industries list.
2. Consider synonyms, related terms, and industry classifications (e.g., "Tech" → "Computer Software", "Fintech" → "Financial Services", "Healthcare" → "Hospital & Health Care").
3. If the input is already an exact match from the list, return it as-is.
4. If no close match exists, return the original input unchanged.
5. Return ONLY the matched industry name - no explanations or additional text.
6. Be case-sensitive to the predefined list format.

Predefined Industries List:
${predefinedIndustries.join('\n')}

Examples:
- "Tech" → "Computer Software"
- "Fintech" → "Financial Services" 
- "Healthcare" → "Hospital & Health Care"
- "SaaS" → "Computer Software"
- "EdTech" → "E-Learning"
- "Automotive Industry" → "Automotive"`
          },
          {
            role: 'user',
            content: `Industry input: ${industryInput}`
          }
        ],
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    const convertedIndustry = response.data.choices[0].message.content.trim();

    console.log(`Converted industry: ${industryInput} → ${convertedIndustry}`);

    // Validate that the response is from our predefined list
    if (predefinedIndustries.includes(convertedIndustry)) {
      return convertedIndustry;
    } else {
      // If OpenAI returned something not in our list, return the original input
      console.warn(`OpenAI returned industry not in predefined list: ${convertedIndustry}. Using original: ${industryInput}`);
      return industryInput;
    }

  } catch (error) {
    console.error('Error converting industry:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    // Return original input on error
    return industryInput;
  }
};

// Generate industry variations for search queries
exports.generateIndustryVariations = async (industry, searchEngine = 'google') => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Generating industry variations for: ${industry} (${searchEngine})`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    // Define different prompts for different search engines
    let systemPrompt;

    if (searchEngine === 'brave') {
      systemPrompt = `You are a search expert specializing in LinkedIn profile discovery using concise, high-signal industry terms.
    
    Your task is to generate 3-4 tightly relevant, single-word variations for a given industry that improve search precision.
    
    Instructions:
    1. Return only **single words** — no spaces, slashes, or hyphens.
    2. Include **abbreviations**, **skill keywords**, **job-function tags**, and **niche terms**.
    3. Think like a LinkedIn recruiter: Use terms you'd expect in a person's **headline**, **job title**, or **skills section**.
    4. Avoid generic terms like "business", "solutions", "services", or "technology" unless absolutely core to the field.
    5. Return ONLY a JSON array of strings (no additional text or explanations)
    
    Examples:
    - "SaaS" → ["saas", "software", "platforms", "cloud", "tech", "subscription"]
    - "Fintech" → ["fintech", "banking", "payments", "crypto", "finance", "wallets"]
    - "Media" → ["media", "advertising", "broadcast", "publishing", "editorial", "content"]
    `;
    }
    else {
      systemPrompt = `You are a LinkedIn profile search expert helping generate powerful industry keyword variations for search queries.
    
    Your goal is to return 3-4 variations of a given industry term that reflect how professionals describe their background on LinkedIn.
    
    Instructions:
    1. Include **realistic multi-word phrases**, **abbreviations**, and **job-field jargon** commonly used on LinkedIn.
    2. Prioritize terms used in **headlines**, **job titles**, **About sections**, or **company blurbs**.
    3. Avoid generic filler words like "services", "solutions", or "technology" unless core to the industry.
    4. Return ONLY a JSON array of strings (no additional text or explanations)
    5. Think of **what people say they work in**, not just what the industry is called.
    
    Examples:
    - "SaaS" → ["saas", "software as a service", "cloud software", "software development", "b2b software", "enterprise tech"]
    - "Fintech" → ["fintech", "financial technology", "banking tech", "payments", "digital finance", "crypto platforms"]
    - "Media" → ["media", "digital media", "advertising", "content strategy", "broadcasting", "publishing"]
    `;
    }


    // Call OpenAI API to generate industry variations
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: `Generate 3-4 industry variations for: ${industry}`
          }
        ],
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    // const content = response.data.choices[0].message.content;
    // const result = JSON.parse(content);

    // Extract the array from the result (handle different possible response formats)
    let variations = [];
    const content = response.data.choices[0].message.content.trim();

    // Optional: try to clean up common wrapping like markdown code blocks
    const clean = content.replace(/^```(json)?|```$/g, '').trim();

    const result = JSON.parse(clean);

    if (Array.isArray(result.variations)) {
      variations = result.variations;
    } else if (Array.isArray(result.industry_variations)) {
      variations = result.industry_variations;
    } else if (Array.isArray(result.terms)) {
      variations = result.terms;
    } else if (Array.isArray(result)) {
      variations = result;
    } else {
      // Fallback: try to find any array in the response
      const firstArray = Object.values(result).find(value => Array.isArray(value));
      if (firstArray) {
        variations = firstArray;
      } else {
        throw new Error('Could not extract variations array from OpenAI response');
      }
    }

    console.log(`Generated industry variations:`, variations);

    // Ensure we have at least the original industry term
    if (!variations.includes(industry.toLowerCase())) {
      variations.unshift(industry.toLowerCase());
    }

    // Limit to 6 variations to avoid too many queries
    return variations.slice(0, 6);

  } catch (error) {
    console.error('Error generating industry variations:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    // Fallback: return the original industry with some generic variations
    console.log(`Falling back to basic variations for: ${industry}`);
    return [industry.toLowerCase(), 'tech', 'technology', 'business', 'services'];
  }
};

// Extract LinkedIn profiles from CSV data using specific prompt
exports.extractProfilesFromCsvData = async (csvData, industries = []) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Extracting LinkedIn profiles from ${csvData.length} CSV rows`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);

    // Process in batches to avoid OpenAI response size limits
    const batchSize = 100; // Process 50 profiles at a time
    const batches = [];

    for (let i = 0; i < csvData.length; i += batchSize) {
      batches.push(csvData.slice(i, i + batchSize));
    }

    console.log(`Processing ${csvData.length} profiles in ${batches.length} batches of ${batchSize}`);

    // Prepare industries string for prompt
    const industriesString = industries.length > 0 ? industries.join(', ') : 'None';
    console.log('Industries for matching:', industriesString);

    // Use the exact prompt provided by the user
    const systemPrompt = `Extract LinkedIn profile information from the provided data.
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
   - Accept alternate language equivalents of "Location", such as "Plats" (Swedish), "Ort" (German), "Lieu" (French), "Ubicación" (Spanish), etc., followed by a colon or dash (e.g., "Ort: Berlin", "Lieu-Paris").
   - If no such explicit "Location:" phrase is found, then infer the location from the most recent or current job/summary context (e.g., recent roles in the 'og:description', current job listings in snippet, etc.).
   - Do **not** extract locations that are part of past roles, education, or experience unless clearly marked as current.
   - Return ONLY the city and country or region (e.g., "London, United Kingdom" or "Toronto, Canada").
   - If no location is confidently determined using either method, return an empty string.

5. For the industry:
   - First, try to match with one of the provided values in ${industriesString} using reasoning.
   - Consider:
    - The person's job title (e.g., "Product Manager" → "software")
    - Keywords or context in the snippet (e.g., "cloud platform", "banking systems", "e-commerce")
    - The nature of the current employer if recognizable (e.g., "Shopify" → "e-commerce")
    - If no clear match is found using the above, infer the actual industry by:
    - Looking at the language in their description
    - Reasoning about the employer's domain
    - Using general knowledge about the company or role, similar to how you'd reason with a web search result
    - Return the best-fitting industry. If no clear industry is supported, return an empty string ""

6. Return a JSON array called "profiles" with one object per profile in the same order as input.
7. Return valid JSON only - no additional text or explanations`;

    let allExtractedProfiles = [];

    // Process each batch
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} profiles`);

      try {
        // Prepare the user content for this batch
        const profilesContent = batch.map((profile, index) => {
          const globalIndex = batchIndex * batchSize + index + 1;
          return `Profile ${globalIndex}:
Title: ${profile.title}
Snippet: ${profile.snippet}`;
        }).join('\n\n');

        // Call OpenAI API for this batch
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: systemPrompt
              },
              {
                role: 'user',
                content: profilesContent
              }
            ],
            response_format: { type: "json_object" }
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        // Parse the response
        const content = response.data.choices[0].message.content;

        try {
          const extractedBatch = JSON.parse(content);
          const batchProfiles = extractedBatch.profiles || [];

          console.log(`Batch ${batchIndex + 1} extracted ${batchProfiles.length} profiles`);
          allExtractedProfiles.push(...batchProfiles);

        } catch (jsonError) {
          console.error(`JSON parsing error for batch ${batchIndex + 1}:`, jsonError.message);
          console.error('Response content (first 500 chars):', content.substring(0, 500));

          // Try to extract partial data or skip this batch
          console.log(`Skipping batch ${batchIndex + 1} due to JSON parsing error`);
          continue;
        }

        // Add delay between batches to avoid rate limiting
        if (batchIndex < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
        }

      } catch (batchError) {
        console.error(`Error processing batch ${batchIndex + 1}:`, batchError.message);

        // If it's a rate limit error, wait longer
        if (batchError.response && batchError.response.status === 429) {
          console.log('Rate limited, waiting 5 seconds before next batch...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // Continue with next batch
        continue;
      }
    }

    console.log(`Extraction completed. Total profiles extracted: ${allExtractedProfiles.length}/${csvData.length}`);

    return allExtractedProfiles;

  } catch (error) {
    console.error('Error extracting profiles from CSV data:', error);

    // Handle OpenAI API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    // Return empty array on error
    return [];
  }
};

// Filter profiles from CSV data based on title, location, and industries using OpenAI
exports.filterProfilesFromCsv = async (profiles, filters) => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key is not configured');
    }

    if (!isValidOpenAIKey(OPENAI_API_KEY)) {
      throw new Error('Invalid OpenAI API key format');
    }

    console.log(`Filtering ${profiles.length} profiles from CSV using OpenAI`);
    console.log(`Using API key: ${sanitizeApiKey(OPENAI_API_KEY)}`);
    console.log('Filters:', filters);

    // Process in batches to avoid API limits
    const batchSize = 50; // Similar to Claude implementation
    const batches = [];

    for (let i = 0; i < profiles.length; i += batchSize) {
      batches.push(profiles.slice(i, i + batchSize));
    }

    let allFilteredProfiles = [];
    const maxRetries = 3;
    let baseDelay = 1000; // Start with 1 second
    let adaptiveDelay = 1000; // 1 second between batches
    let consecutive429s = 0;

    console.log(`Processing ${batches.length} batches of ${batchSize} profiles each`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`Processing batch ${i + 1}/${batches.length} with ${batch.length} profiles`);

      let retryCount = 0;
      let success = false;

      while (!success && retryCount < maxRetries) {
        try {
          // Prepare the profile content for OpenAI
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

          // System message for OpenAI
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
            'https://api.openai.com/v1/chat/completions',
            {
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: systemMessage
                },
                {
                  role: 'user',
                  content: `${profilesContent}\n\nFilters:${filtersText}`
                }
              ],
              response_format: { type: "json_object" },
              temperature: 0.1
            },
            {
              headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );

          const content = response.data.choices[0].message.content;

          // Parse JSON response
          let batchResults = null;
          try {
            batchResults = JSON.parse(content);
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
            console.log(`OpenAI API rate limited (429) for batch ${i + 1}, attempt ${retryCount}/${maxRetries}`);
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
          } else if (error.response && error.response.status === 503) {
            console.log(`OpenAI API service unavailable (503) for batch ${i + 1}, attempt ${retryCount}/${maxRetries}`);

            if (retryCount < maxRetries) {
              const delay = baseDelay * Math.pow(3, retryCount - 1); // Longer delays for 503
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
          adaptiveDelay = Math.min(adaptiveDelay * 1.5, 10000); // Max 10 seconds
          console.log(`Increased delay to ${adaptiveDelay}ms due to frequent rate limiting`);
        } else if (consecutive429s === 0) {
          adaptiveDelay = Math.max(adaptiveDelay * 0.9, 1000); // Min 1 second
        }

        console.log(`Waiting ${adaptiveDelay}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
      }
    }

    console.log(`Filtering completed: ${allFilteredProfiles.length} profiles matched all filters`);
    return allFilteredProfiles;

  } catch (error) {
    console.error('Error filtering profiles from CSV using OpenAI:', error);

    if (error.response) {
      const status = error.response.status;
      let message = 'Unknown OpenAI API error';

      if (status === 401) {
        message = 'Invalid or expired OpenAI API key';
      } else if (status === 429) {
        message = 'OpenAI rate limit exceeded - consider reducing request frequency';
      } else if (status === 503) {
        message = 'OpenAI service is temporarily unavailable - try again later';
      } else if (status === 400) {
        message = 'Bad request to OpenAI API';
      } else if (error.response.data && error.response.data.error) {
        message = `OpenAI API error: ${error.response.data.error.message || error.response.data.error}`;
      }

      console.error(`OpenAI API error (${status}): ${message}`);
    }

    throw error;
  }
};

// Convert industry to ContactOut's accepted industry values
exports.convertToContactOutIndustry = async (industryInput) => {
  try {
    const contactOutIndustries = [
      'Defense & Space', 'Computer Hardware', 'Computer Software', 'Computer Networking', 'Internet', 'Semiconductors', 'Telecommunications',
      'Law Practice', 'Legal Services', 'Management Consulting', 'Biotechnology', 'Medical Practice', 'Hospital & Health Care', 'Pharmaceuticals',
      'Veterinary', 'Medical Device', 'Cosmetics', 'Apparel & Fashion', 'Sporting Goods', 'Tobacco', 'Supermarkets', 'Food Production',
      'Consumer Electronics', 'Consumer Goods', 'Furniture', 'Retail', 'Entertainment', 'Gambling & Casinos', 'Leisure, Travel & Tourism',
      'Hospitality', 'Restaurants', 'Sports', 'Food & Beverages', 'Motion Pictures & Film', 'Broadcast Media', 'Museums & Institutions',
      'Fine Art', 'Performing Arts', 'Recreational Facilities & Services', 'Banking', 'Insurance', 'Financial Services', 'Real Estate',
      'Investment Banking', 'Investment Management', 'Accounting', 'Construction', 'Building Materials', 'Architecture & Planning',
      'Civil Engineering', 'Aviation & Aerospace', 'Automotive', 'Chemicals', 'Machinery', 'Mining & Metals', 'Oil & Energy',
      'Shipbuilding', 'Utilities', 'Textiles', 'Paper & Forest Products', 'Railroad Manufacture', 'Farming', 'Ranching', 'Dairy',
      'Fishery', 'Primary/Secondary Education', 'Higher Education', 'Education Management', 'Research', 'Military', 'Legislative Office',
      'Judiciary', 'International Affairs', 'Government Administration', 'Executive Office', 'Law Enforcement', 'Public Safety',
      'Public Policy', 'Marketing & Advertising', 'Newspapers', 'Publishing', 'Printing', 'Information Services', 'Libraries',
      'Environmental Services', 'Package/Freight Delivery', 'Individual & Family Services', 'Religious Institutions',
      'Civic & Social Organization', 'Consumer Services', 'Transportation/Trucking/Railroad', 'Warehousing', 'Airlines/Aviation',
      'Maritime', 'Information Technology & Services', 'Market Research', 'Public Relations & Communications', 'Design',
      'Non-profit Organization Management', 'Fundraising', 'Program Development', 'Writing & Editing', 'Staffing & Recruiting',
      'Professional Training & Coaching', 'Venture Capital & Private Equity', 'Political Organization', 'Translation & Localization',
      'Computer Games', 'Events Services', 'Arts & Crafts', 'Electrical & Electronic Manufacturing', 'Online Media', 'Nanotechnology',
      'Music', 'Logistics & Supply Chain', 'Plastics', 'Computer & Network Security', 'Wireless', 'Alternative Dispute Resolution',
      'Security & Investigations', 'Facilities Services', 'Outsourcing/Offshoring', 'Health, Wellness & Fitness', 'Alternative Medicine',
      'Media Production', 'Animation', 'Commercial Real Estate', 'Capital Markets', 'Think Tanks', 'Philanthropy', 'E-learning',
      'Wholesale', 'Import & Export', 'Mechanical Or Industrial Engineering', 'Photography', 'Human Resources', 'Business Supplies & Equipment',
      'Mental Health Care', 'Graphic Design', 'International Trade & Development', 'Wine & Spirits', 'Luxury Goods & Jewelry',
      'Renewables & Environment', 'Glass, Ceramics & Concrete', 'Packaging & Containers', 'Industrial Automation', 'Government Relations'
    ];

    const prompt = `Convert the following industry term to the most relevant ContactOut industry category.

Input industry: "${industryInput}"

ContactOut accepted industries:
${contactOutIndustries.join(', ')}

Rules:
1. Return ONLY the exact industry name from the ContactOut list above
2. Choose the most semantically similar and relevant match
3. If the input is "SaaS" or "Software as a Service", return "Computer Software"
4. If the input is "Fintech" or "Financial Technology", return "Financial Services"
5. If the input is "Edtech" or "Education Technology", return "E-learning"
6. If the input is "Healthtech" or "Healthcare Technology", return "Hospital & Health Care"
7. If no close match exists, return "Information Technology & Services" as the default

Industry:`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 50,
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const convertedIndustry = response.data.choices[0].message.content.trim();

    // Validate that the returned industry is in our accepted list
    if (contactOutIndustries.includes(convertedIndustry)) {
      console.log(`ContactOut industry conversion: ${industryInput} → ${convertedIndustry}`);
      return convertedIndustry;
    } else {
      console.warn(`OpenAI returned invalid ContactOut industry: ${convertedIndustry}, using default`);
      return 'Information Technology & Services';
    }

  } catch (error) {
    console.error('Error converting industry for ContactOut:', error);
    return 'Information Technology & Services'; // Default fallback
  }
};

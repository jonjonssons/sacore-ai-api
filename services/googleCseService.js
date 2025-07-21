const axios = require('axios');
const { BadRequestError } = require('../errors');

const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

// Search LinkedIn profiles using Google CSE
exports.searchLinkedInProfiles = async (query, start = 1, retryCount = 0) => {
  const maxRetries = 3;
  const baseDelay = 1000;
  try {
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
      throw new Error('Google CSE configuration missing');
    }

    // Ensure the query includes LinkedIn
    let searchQuery = query;
    if (!searchQuery.includes('site:linkedin.com/in/')) {
      searchQuery = `site:linkedin.com/in/ ${searchQuery}`;
    }

    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: GOOGLE_API_KEY,
        cx: GOOGLE_CSE_ID,
        q: searchQuery,
        start: start,
        num: 10 // Max allowed by Google CSE
      }
    });

    // Process and return results
    const results = response.data.items || [];
    const totalResults = response.data.searchInformation?.totalResults || 0;

    return {
      results: results.map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        formattedUrl: item.formattedUrl,
        pagemap: item.pagemap
      })),
      pagination: {
        currentPage: Math.floor(start / 10) + 1,
        totalResults: parseInt(totalResults),
        hasNextPage: start + 10 <= 100 && start + 10 <= parseInt(totalResults) // Google CSE limits to 100 results
      }
    };
  } catch (error) {
    if (error.response && error.response.status === 429 && retryCount < maxRetries) {
      // Exponential backoff: wait longer with each retry
      const delay = baseDelay * Math.pow(2, retryCount);
      console.log(`Rate limited. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);

      await new Promise(resolve => setTimeout(resolve, delay));
      return exports.searchLinkedInProfiles(query, start, retryCount + 1);
    }

    console.error('Google CSE search error:', error.message);
    return {
      error: true,
      status: error.response?.status || 500,
      message: error.message,
      details: error.response?.data
    };
  }
};

exports.searchBingLinkedInProfiles = async (query, start = 1) => {
  try {
    if (!process.env.BING_API_KEY) {
      throw new Error('Bing API key configuration missing');
    }

    // Ensure the query includes LinkedIn
    let searchQuery = query;
    if (!searchQuery.includes('site:linkedin.com/in/')) {
      searchQuery = `site:linkedin.com/in/ ${searchQuery}`;
    }

    // Convert start parameter to offset (Bing uses 0-based offset)
    const offset = start - 1;

    const response = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.BING_API_KEY,
        'Accept': 'application/json'
      },
      params: {
        q: searchQuery,
        offset: offset,
        count: 10, // Number of results per page (max 50)
        responseFilter: 'Webpages', // Focus on web results only
        safeSearch: 'Moderate',
        textDecorations: false,
        textFormat: 'Raw'
      }
    });

    // Process and return results
    const webPages = response.data.webPages || {};
    const results = webPages.value || [];
    const totalResults = webPages.totalEstimatedMatches || 0;

    return {
      results: results.map(item => ({
        title: item.name,
        link: item.url,
        snippet: item.snippet,
        formattedUrl: item.displayUrl,
        dateLastCrawled: item.dateLastCrawled,
        language: item.language,
        isFamilyFriendly: item.isFamilyFriendly
      })),
      pagination: {
        currentPage: Math.floor(offset / 10) + 1,
        totalResults: parseInt(totalResults),
        hasNextPage: offset + 10 < parseInt(totalResults) && offset + 10 < 1000 // Bing typically limits to ~1000 results
      }
    };
  } catch (error) {
    console.error('Bing Search API error:', error);

    // Instead of throwing errors, return an error object
    // This allows the calling code to handle the error gracefully
    if (error.response) {
      // Handle specific HTTP error responses
      if (error.response.status === 429) {
        return {
          error: true,
          message: 'Rate limit exceeded. Please try again later.',
          status: 429
        };
      } else if (error.response.status === 401) {
        return {
          error: true,
          message: 'Invalid API key. Please check your Bing API key configuration.',
          status: 401
        };
      } else if (error.response.status === 400) {
        return {
          error: true,
          message: 'Invalid search request. Please check your search parameters.',
          status: 400,
          details: error.response.data?.error?.message || 'Bad Request'
        };
      } else if (error.response.status === 403) {
        return {
          error: true,
          message: 'API quota exceeded or access denied.',
          status: 403
        };
      } else {
        return {
          error: true,
          message: `API error: ${error.response.status}`,
          status: error.response.status,
          details: error.response.data?.error?.message || 'Unknown API error'
        };
      }
    }

    // For network errors, timeouts, etc.
    return {
      error: true,
      message: 'Failed to search LinkedIn profiles',
      details: error.message || 'Unknown error',
      status: 500
    };
  }
};

exports.searchBraveLinkedInProfiles = async (query, page = 1) => {
  let searchQuery = query;

  // Brave API uses offset 0-9 (not 0,20,40,60)
  // Each offset represents a "page" of results
  let offset = (page - 1); // Page 1 = offset 0, Page 2 = offset 1, etc.

  // Validate that we don't exceed Brave's offset limit
  if (offset > 9) {
    return {
      error: true,
      message: 'Page number exceeds Brave Search API limits. Maximum 10 pages available.',
      status: 400,
      details: `Requested page ${page} (offset ${offset}) exceeds maximum offset of 9.`,
      maxPages: 10
    };
  }

  try {
    if (!process.env.BRAVE_API_KEY) {
      throw new Error('Brave API key configuration missing');
    }

    // Clean the query and ensure single site: prefix
    // searchQuery = searchQuery.replace(/site:linkedin\.com\/in\/?\s*/g, '').trim();
    // searchQuery = searchQuery.replace(/\s+AND\s+/g, ' ').trim();
    // searchQuery = searchQuery.replace(/"+/g, '"').trim();
    // searchQuery = searchQuery.replace(/"\s*"/g, '" "').trim();

    // Add single site: prefix
    searchQuery = `site:linkedin.com/in/ ${searchQuery}`;

    console.log(`  → Brave API call: "${searchQuery}", page: ${page}, offset: ${offset}`);

    const requestParams = {
      q: searchQuery,
      offset: offset,        // 0-9 (represents page number - 1)
      count: 20,            // Results per page (Brave maximum)
      search_lang: 'en',
      country: 'US'
    };

    // Add optional parameters only for first page
    if (offset === 0) {
      requestParams.safesearch = 'moderate';
      requestParams.spellcheck = true;
    }

    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      params: requestParams,
      timeout: 15000
    });

    const results = response.data.web?.results || [];
    const totalResults = response.data.web?.totalResults || 0;

    // Calculate pagination info correctly
    const hasNextPage = page < 10 && results.length === 20;

    return {
      results: results.map(item => {
        const titleParts = item.title ? item.title.split(' - ') : [];
        const namepart = titleParts[0] || '';
        const names = namepart.split(' ');
        const firstName = names[0] || '';
        const lastName = names.slice(1).join(' ') || '';

        return {
          title: item.title,
          link: item.url,
          snippet: item.description,
          formattedUrl: item.url,
          published: item.published,
          thumbnail: item.thumbnail,
          language: item.language,
          family_friendly: item.family_friendly,
          pagemap: {
            metatags: [{
              'profile:first_name': firstName,
              'profile:last_name': lastName,
              'og:description': item.description || ''
            }]
          }
        };
      }),
      pagination: {
        currentPage: page,
        totalResults: parseInt(totalResults),
        hasNextPage: hasNextPage,
        offset: offset,
        count: results.length,
        maxPages: 10,
        resultsPerPage: 20
      },
      query: {
        original: query,
        searched: searchQuery,
        altered: response.data.query?.altered || false,
        corrected: response.data.query?.corrected || false
      }
    };

  } catch (error) {
    console.error('Brave Search API error:', error);

    if (error.response) {
      console.error('Brave API response data:', error.response.data);

      const errorMappings = {
        422: {
          message: 'Invalid search request. Please check your search parameters.',
          details: error.response.data?.error || 'Unprocessable Entity'
        },
        429: {
          message: 'Rate limit exceeded. Please try again later.',
          details: error.response.data?.message || 'Too Many Requests'
        },
        400: {
          message: 'Invalid search request. Please check your search parameters.',
          details: error.response.data?.message || 'Bad Request'
        },
        401: {
          message: 'Invalid API key. Please check your Brave API configuration.',
          details: error.response.data?.message || 'Unauthorized'
        },
        403: {
          message: 'API access forbidden. Please check your subscription status.',
          details: error.response.data?.message || 'Forbidden'
        }
      };

      const errorInfo = errorMappings[error.response.status] || {
        message: `API error: ${error.response.status}`,
        details: error.response.data?.message || 'Unknown API error'
      };

      return {
        error: true,
        message: errorInfo.message,
        status: error.response.status,
        details: errorInfo.details,
        query: searchQuery,
        offset: offset
      };
    }

    return {
      error: true,
      message: 'Failed to search LinkedIn profiles',
      details: error.message || 'Unknown error',
      status: 500
    };
  }
};
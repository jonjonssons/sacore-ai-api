
const { normalizeLinkedInUrl } = require('../utils/linkedinHelpers');
const profileService = require('./profileService');
const contactOutService = require('./contactOutService');

exports.enrichProfile = async (url) => {
  try {
    // Get existing profile data
    const profile = await profileService.getProfileByUrl(url);

    // Try SignalHire first
    let enrichedData = {
      email: "",
      phone: "",
      additionalInfo: {}
    };

    // Try ContactOut as fallback
    console.log('SignalHire enrichProfile placeholder - falling back to ContactOut...');
    try {
      const contactOutResult = await contactOutService.enrichProfile(url);
      if (contactOutResult.success && contactOutResult.profile) {
        console.log('ContactOut enrichment successful as fallback');
        enrichedData = {
          email: contactOutResult.profile.contactInfo?.workEmails?.[0] || contactOutResult.profile.contactInfo?.emails?.[0] || "",
          phone: contactOutResult.profile.contactInfo?.phones?.[0] || "",
          additionalInfo: {
            contactOutData: contactOutResult.profile,
            enrichmentSource: 'contactout_fallback'
          }
        };
      }
    } catch (contactOutError) {
      console.warn('ContactOut fallback also failed:', contactOutError.message);
    }

    // Combine existing profile with enriched data
    const enrichedProfile = {
      ...profile,
      ...enrichedData
    };

    // Save the enriched profile
    await profileService.saveProfile(enrichedProfile);

    return enrichedProfile;
  } catch (error) {
    console.error('Error enriching profile with SignalHire/ContactOut:', error);
    throw error;
  }
};

/**
 * Service for interacting with SignalHire API
 */

// API configuration
const SIGNALHIRE_API_KEY = process.env.SIGNALHIRE_API_KEY;

// Check available credits
exports.checkCredits = async () => {
  try {
    const response = await fetch('https://www.signalhire.com/api/v1/credits?withoutContacts=true', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': SIGNALHIRE_API_KEY,
        'apikey': SIGNALHIRE_API_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`SignalHire API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error checking SignalHire credits:', error);
    throw error;
  }
};

// Search for profile by LinkedIn URL
exports.searchProfile = async (linkedinUrl, callbackUrl) => {
  const requestPayload = {
    items: [linkedinUrl],
    withoutContacts: true,
    callbackUrl
  };

  const response = await fetch('https://www.signalhire.com/api/v1/candidate/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': SIGNALHIRE_API_KEY,
      'apikey': SIGNALHIRE_API_KEY
    },
    body: JSON.stringify(requestPayload)
  });

  if (response.status === 201) {
    const data = await response.json();
    if (!data?.requestId) throw new Error('Missing requestId in SignalHire response');
    return data;  // contains requestId, pollingUrl, message
  } else {
    const errorText = await response.text();
    throw new Error(`SignalHire API error: ${response.status} - ${errorText}`);
  }
};

// Get profile by ID
exports.getProfileById = async (profileId) => {
  try {
    const response = await fetch(`https://www.signalhire.com/api/v1/candidate/${profileId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': SIGNALHIRE_API_KEY,
        'apikey': SIGNALHIRE_API_KEY
      }
    });

    if (!response.ok) {
      console.warn(`SignalHire API failed for profile ${profileId}: ${response.status}`);

      // If SignalHire fails, try ContactOut fallback if we have a LinkedIn URL
      // Note: This requires the LinkedIn URL to be available from somewhere
      throw new Error(`SignalHire API error: ${response.status}`);
    }

    const data = await response.json();

    // Check if SignalHire returned meaningful data
    if (!data || !data.fullName) {
      console.warn(`SignalHire returned incomplete data for profile ${profileId}`);

      // Try ContactOut fallback if available
      // This would require extracting LinkedIn URL from SignalHire response or having it stored elsewhere
      if (data.social && Array.isArray(data.social)) {
        const linkedinSocial = data.social.find(s => s.type === 'li' || s.type === 'linkedin');
        if (linkedinSocial && linkedinSocial.link) {
          console.log(`Attempting ContactOut fallback for profile ${profileId} using LinkedIn URL: ${linkedinSocial.link}`);
          try {
            const contactOutResult = await contactOutService.enrichProfile(linkedinSocial.link);
            if (contactOutResult.success && contactOutResult.profile) {
              console.log('ContactOut fallback successful for getProfileById');

              // Transform ContactOut data to SignalHire format
              return {
                ...data,
                fullName: contactOutResult.profile.fullName,
                experience: contactOutResult.profile.experience,
                education: contactOutResult.profile.education,
                skills: contactOutResult.profile.skills,
                location: contactOutResult.profile.location,
                industry: contactOutResult.profile.industry,
                // Add ContactOut specific data
                contactOutEnrichment: contactOutResult.profile,
                enrichmentSource: 'contactout_fallback'
              };
            }
          } catch (contactOutError) {
            console.warn('ContactOut fallback failed for getProfileById:', contactOutError.message);
          }
        }
      }
    }

    return data;
  } catch (error) {
    console.error('Error getting profile by ID from SignalHire:', error);
    throw error;
  }
};

// Search for multiple profiles by LinkedIn URLs (batch operation)
exports.searchProfiles = async (linkedinUrls, callbackUrl, customParameters = {}, withoutContacts = false) => {
  // Normalize all LinkedIn URLs
  const normalizedUrls = linkedinUrls.map(url => normalizeLinkedInUrl(url));

  const requestPayload = {
    items: linkedinUrls,
    withoutContacts: withoutContacts,
    callbackUrl,
    customParameters
  };

  const response = await fetch('https://www.signalhire.com/api/v1/candidate/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': SIGNALHIRE_API_KEY,
      'apikey': SIGNALHIRE_API_KEY
    },
    body: JSON.stringify(requestPayload)
  });

  if (response.status === 201) {
    const data = await response.json();
    if (!data?.requestId) throw new Error('Missing requestId in SignalHire response');
    return data;  // contains requestId, pollingUrl, message
  } else {
    const errorText = await response.text();
    throw new Error(`SignalHire API error: ${response.status} - ${errorText}`);
  }
};

// Add this new method for searching profiles by criteria
exports.searchProfilesByCriteria = async (searchCriteria) => {
  try {
    const requestPayload = {
      currentTitle: searchCriteria.title,
      location: searchCriteria.location,
      keywords: searchCriteria.keywords || '',
      industry: searchCriteria.industry || '',
      size: searchCriteria.size
    };
    Object.keys(requestPayload).forEach(k => {
      if (!requestPayload[k]) delete requestPayload[k];
    });

    const response = await fetch('https://www.signalhire.com/api/v1/candidate/searchByQuery', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SIGNALHIRE_API_KEY
      },
      body: JSON.stringify(requestPayload)
    });

    const data = await response.json();
    console.log('SignalHire raw:', JSON.stringify(data, null, 2));

    const rawResults = data.results ?? data.candidates ?? data.profiles ?? data.data ?? [];
    const total = data.total ?? data.count ?? rawResults.length;

    return {
      success: true,
      results: data,
      // total,
      // pagination: data.pagination || {}
    };

  } catch (error) {
    console.error('Error searching profiles with SignalHire:', error);
    return { success: false, error: error.message, results: [] };
  }
};

// Add this new method for scroll search (pagination)
exports.scrollSearch = async (requestId, scrollId) => {
  try {
    const requestPayload = {
      scrollId: scrollId
    };

    const response = await fetch(`https://www.signalhire.com/api/v1/candidate/scrollSearch/${requestId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SIGNALHIRE_API_KEY
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SignalHire scroll search API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('SignalHire scroll search raw:', JSON.stringify(data, null, 2));

    return {
      success: true,
      results: data
    };

  } catch (error) {
    console.error('Error in SignalHire scroll search:', error);
    return { success: false, error: error.message, results: [] };
  }
};

// Add this new method for enrichment with comprehensive fallback
exports.enrichProfileWithFallback = async (linkedinUrl) => {
  console.log(`Starting enrichment with fallback for: ${linkedinUrl}`);

  try {
    // First, try SignalHire enrichment
    console.log('Attempting SignalHire enrichment...');

    // Since the actual SignalHire enrichProfile is a placeholder, we'll simulate failure
    // In real implementation, you would call the actual SignalHire API here
    const signalHireSuccess = false; // Simulating SignalHire failure/unavailability

    if (!signalHireSuccess) {
      console.log('SignalHire enrichment failed or unavailable, trying ContactOut fallback...');

      try {
        const contactOutResult = await contactOutService.enrichProfile(linkedinUrl);

        if (contactOutResult.success && contactOutResult.profile) {
          console.log('ContactOut fallback enrichment successful');

          return {
            success: true,
            source: 'contactout',
            profile: contactOutResult.profile,
            enrichmentMethod: 'contactout_fallback',
            originalUrl: linkedinUrl
          };
        } else {
          console.warn('ContactOut fallback returned unsuccessful result');
        }
      } catch (contactOutError) {
        console.error('ContactOut fallback failed:', contactOutError.message);

        return {
          success: false,
          source: 'none',
          error: 'Both SignalHire and ContactOut enrichment failed',
          signalHireError: 'Not available or failed',
          contactOutError: contactOutError.message,
          originalUrl: linkedinUrl
        };
      }
    }

    // If SignalHire succeeds (in real implementation)
    // return signalHireResult;

  } catch (error) {
    console.error('Error in enrichProfileWithFallback:', error);

    return {
      success: false,
      source: 'none',
      error: 'Enrichment process failed',
      details: error.message,
      originalUrl: linkedinUrl
    };
  }
};

// Batch enrichment with fallback support
exports.batchEnrichProfilesWithFallback = async (linkedinUrls, options = {}) => {
  const { batchSize = 5, includeContactOutFallback = true } = options;

  console.log(`Starting batch enrichment with fallback for ${linkedinUrls.length} profiles`);

  const results = [];

  for (let i = 0; i < linkedinUrls.length; i += batchSize) {
    const batch = linkedinUrls.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(linkedinUrls.length / batchSize)}: ${batch.length} profiles`);

    const batchPromises = batch.map(async (url) => {
      try {
        return await this.enrichProfileWithFallback(url);
      } catch (error) {
        return {
          success: false,
          source: 'none',
          error: 'Batch enrichment failed',
          details: error.message,
          originalUrl: url
        };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);

    batchResults.forEach((result, index) => {
      const linkedinUrl = batch[index];
      if (result.status === 'fulfilled') {
        results.push({
          linkedinUrl,
          ...result.value
        });
      } else {
        results.push({
          linkedinUrl,
          success: false,
          source: 'none',
          error: 'Promise rejected',
          details: result.reason
        });
      }
    });

    // Add delay between batches to avoid rate limiting
    if (i + batchSize < linkedinUrls.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const successful = results.filter(r => r.success).length;
  const contactOutFallbacks = results.filter(r => r.success && r.source === 'contactout').length;
  const failed = results.length - successful;

  console.log(`Batch enrichment completed: ${successful} successful (${contactOutFallbacks} via ContactOut fallback), ${failed} failed`);

  return {
    success: true,
    results: results,
    summary: {
      total: results.length,
      successful,
      failed,
      contactOutFallbacks,
      signalHireSuccess: successful - contactOutFallbacks
    }
  };
};

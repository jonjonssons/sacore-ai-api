const googleCseService = require('../services/googleCseService');
const creditService = require('../services/creditService');
const usageService = require('../services/usageService');
const openaiService = require('../services/openaiService');
const claudeService = require('../services/claudeService');
const geminiService = require('../services/geminiService');
const signalHireService = require('../services/signalHireService');
const icypeasService = require('../services/icypeasService');
const contactOutService = require('../services/contactOutService');
const apolloService = require('../services/apolloService');
const { StatusCodes } = require('http-status-codes');
const { BadRequestError } = require('../errors');
const { default: pLimit } = require('p-limit');
const SearchHistory = require('../models/SearchHistory');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

// Parse job requirements from natural language query
exports.parseJobRequirements = async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide a search query'
      });
    }

    // Call the OpenAI service to parse the job requirements
    const parsedRequirements = await openaiService.parseJobRequirements(query);

    // Save the search query to search history for the authenticated user
    const userId = req.user.userId;
    const newSearchHistory = new SearchHistory({
      userId,
      query
    });
    await newSearchHistory.save();

    // Return the parsed requirements
    res.status(StatusCodes.OK).json({
      success: true,
      data: parsedRequirements
    });
  } catch (error) {
    console.error('Error parsing job requirements:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to parse job requirements',
      details: error.message
    });
  }
};

// Search LinkedIn profiles
// Search LinkedIn profiles - fetch all results at once
// Revised searchLinkedInProfiles function with dynamic query generation from filters

exports.searchLinkedInProfiles = async (req, res) => {
  console.log('📝 DEBUG - req.body:', JSON.stringify(req.body, null, 2));
  console.log('📝 DEBUG - req.body.filters type:', typeof req.body.filters);
  console.log('📝 DEBUG - req.body.filters value:', req.body.filters);
  console.log('📝 DEBUG - req.file:', req.file ? 'File present' : 'No file');

  let filters = [];

  if (typeof req.body.filters === 'string') {
    console.log('📝 DEBUG - Parsing filters as string');
    try {
      filters = JSON.parse(req.body.filters);
      console.log('📝 DEBUG - Parsed filters:', filters);
    } catch (e) {
      console.log('📝 DEBUG - JSON parse error:', e.message);
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid filters format. Expected JSON array.',
        receivedType: typeof req.body.filters,
        receivedValue: req.body.filters
      });
    }
  } else if (Array.isArray(req.body.filters)) {
    console.log('📝 DEBUG - Filters already array');
    filters = req.body.filters;
  } else {
    console.log('📝 DEBUG - Filters not string or array, setting to empty');
    filters = [];
  }

  console.log('📝 DEBUG - Final filters:', filters);
  console.log('📝 DEBUG - Is array?', Array.isArray(filters));
  console.log('📝 DEBUG - Length:', filters.length);

  // Convert string boolean values to actual booleans
  const includeSignalHire = req.body.includeSignalHire === 'true' || req.body.includeSignalHire === true;
  const includeBrave = req.body.includeBrave === 'true' || req.body.includeBrave === true;
  const includeCsvImport = req.body.includeCsvImport === 'true' || req.body.includeCsvImport === true;
  const includeIcypeas = req.body.includeIcypeas === 'true' || req.body.includeIcypeas === true;
  const includeContactOut = req.body.includeContactOut === 'true' || req.body.includeContactOut === true;
  const includeGoogle = req.body.includeGoogle === 'true' || req.body.includeGoogle === true;

  console.log('📝 DEBUG - Raw boolean values from request:', {
    includeGoogle: req.body.includeGoogle,
    includeBrave: req.body.includeBrave,
    includeCsvImport: req.body.includeCsvImport,
    includeSignalHire: req.body.includeSignalHire,
    includeIcypeas: req.body.includeIcypeas,
    includeContactOut: req.body.includeContactOut
  });

  console.log('📝 DEBUG - Search services enabled:', {
    includeGoogle,
    includeBrave,
    includeCsvImport,
    includeSignalHire,
    includeIcypeas,
    includeContactOut
  });

  // Ensure we have at least one search service enabled
  if (!includeGoogle && !includeBrave && !includeCsvImport) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please enable at least one search service (includeGoogle, includeBrave, or includeCsvImport)'
    });
  }

  if (!Array.isArray(filters) || filters.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: 'Please provide an array of filters' });
  }

  const getFilterValues = (field) => filters
    .filter(f => f.field === field)
    .map(f => f.value);

  // Extract filter values by category
  const roles = getFilterValues('title');
  const industries = getFilterValues('industry'); // e.g., "Fintech", "SaaS"
  const locations = getFilterValues('location');

  // Get all other filter types (skills, etc.)
  const otherFilters = filters.filter(f =>
    !['title', 'industry', 'location'].includes(f.field)
  );

  // Ensure we have at least one location as per client requirement
  if (locations.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide at least one location filter'
    });
  }

  // Ensure we have roles and industries for the new query strategy
  if (roles.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide at least one role/title filter'
    });
  }

  if (industries.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide at least one industry filter'
    });
  }

  try {
    // ============= CSV IMPORT PROCESSING (NEW FEATURE) =============
    let csvResults = [];
    let csvMeta = {};

    if (includeCsvImport && req.file) {
      console.log('Processing CSV import alongside regular search...');

      try {
        let csvData = [];

        // Parse uploaded file
        const fileExtension = path.extname(req.file.originalname).toLowerCase();

        if (fileExtension === '.csv') {
          csvData = await parseCsvBuffer(req.file.buffer);
        } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
          csvData = await parseExcelBuffer(req.file.buffer);
        } else {
          console.warn('Unsupported file format for CSV import, skipping CSV processing');
        }

        if (csvData.length > 0) {
          console.log('Available CSV fields:', Object.keys(csvData[0]));
          console.log(`Processing ${csvData.length} CSV rows with Gemini AI analysis...`);

          // Prepare filters for Gemini AI analysis
          const titleFilters = roles.map(r => r.toLowerCase().trim());
          const locationFilters = locations.map(l => l.toLowerCase().trim());
          const industryFilters = industries.map(i => i.toLowerCase().trim());

          const aiFilters = {
            title: titleFilters.join(', '),
            location: locationFilters.join(', '),
            industries: industryFilters
          };

          console.log('Using Gemini AI to analyze CSV data with filters:', aiFilters);

          // Use Gemini AI to filter and extract profiles
          let filteredProfiles = [];
          try {
            filteredProfiles = await geminiService.filterProfilesFromCsv(csvData, aiFilters);
            console.log(`Gemini AI filtering completed: ${filteredProfiles.length} profiles matched filters`);
          } catch (geminiError) {
            console.error('Gemini AI analysis failed for CSV import:', geminiError);
            // Continue with regular search even if CSV fails
            filteredProfiles = [];
          }

          // Transform Gemini results to search result format (same as other providers)
          csvResults = filteredProfiles.map((profile, index) => {
            // Calculate relevance score based on Gemini's analysis
            let score = 90; // Base score for AI-matched profiles

            // Bonus for having complete data
            if (profile.name && profile.title && profile.company && profile.location) {
              score += 10;
            }

            // Bonus for having LinkedIn URL if available in original CSV
            const originalRow = csvData.find(row =>
              Object.values(row).some(val =>
                val && typeof val === 'string' && val.toLowerCase().includes('linkedin')
              )
            );
            if (originalRow) {
              score += 10;
            }

            return {
              title: `${profile.name || 'Unknown'} - ${profile.title || 'Professional'} - ${profile.company || 'Company'}`,
              link: profile.linkedinUrl || '', // Use extracted LinkedIn URL if available
              snippet: `${profile.name || 'Unknown'} • ${profile.location || ''} • ${profile.title || ''} at ${profile.company || ''}`,
              pagemap: {
                metatags: [{
                  'profile:first_name': profile.name ? profile.name.split(' ')[0] || '' : '',
                  'profile:last_name': profile.name ? profile.name.split(' ').slice(1).join(' ') || '' : '',
                  'og:description': `${profile.name || 'Unknown'} • ${profile.location || ''} • ${profile.title || ''}`
                }]
              },
              extractedTitle: profile.title || '',
              extractedCompany: profile.company || '',
              extractedLocation: profile.location || '',
              extractedIndustry: profile.industry || '',
              fullName: profile.name || 'Unknown',
              linkedinUrl: profile.linkedinUrl || '', // Use extracted LinkedIn URL
              email: profile.email || '', // Use extracted email address
              relevanceScore: `3/3`, // CSV data is AI-filtered so gets max score
              originalRelevanceScore: score,
              source: 'csv_import',
              csvData: {
                name: profile.name || '',
                title: profile.title || '',
                company: profile.company || '',
                location: profile.location || '',
                industry: profile.industry || '',
                linkedinUrl: profile.linkedinUrl || '',
                email: profile.email || ''
              },
              matchedFilters: {
                title: titleFilters.filter(filter =>
                  profile.title && profile.title.toLowerCase().includes(filter.toLowerCase())
                ),
                location: locationFilters.filter(filter =>
                  profile.location && profile.location.toLowerCase().includes(filter.toLowerCase())
                ),
                industry: industryFilters.filter(filter =>
                  profile.industry && profile.industry.toLowerCase().includes(filter.toLowerCase())
                )
              },
              aiAnalyzed: true,
              geminiMatch: true
            };
          });

          // Sort CSV results by relevance score
          csvResults.sort((a, b) => b.originalRelevanceScore - a.originalRelevanceScore);

          csvMeta = {
            totalRecordsInCsv: csvData.length,
            totalMatches: filteredProfiles.length,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            processingNotes: 'CSV data analyzed using Gemini AI for intelligent filtering - supports any CSV structure',
            aiProcessing: 'gemini',
            batchesProcessed: Math.ceil(filteredProfiles.length / 40)
          };

          console.log(`CSV import processed: ${csvResults.length} matches from ${csvData.length} records using Gemini AI`);
        }
      } catch (csvError) {
        console.error('Error processing CSV import:', csvError);
        // Continue with regular search even if CSV fails
      }
    }
    // ============= REGULAR SEARCH PROCESSING (EXISTING LOGIC) =============
    // Generate enhanced queries with OpenAI-generated industry variations
    const queries = [];
    const location = locations[0]; // Use the first location only

    // Generate industry variations for both Google and Brave with different prompts
    console.log(`Generating industry variations for ${industries.length} industries using OpenAI...`);

    // Generate variations for Google (multi-word allowed)
    const googleVariationsPromises = industries.map(industry =>
      openaiService.generateIndustryVariations(industry, 'google')
    );

    // Generate variations for Brave (single-word only)
    const braveVariationsPromises = industries.map(industry =>
      openaiService.generateIndustryVariations(industry, 'brave')
    );

    // Wait for all industry variations to be generated
    const [googleIndustryVariations, braveIndustryVariations] = await Promise.all([
      Promise.all(googleVariationsPromises),
      Promise.all(braveVariationsPromises)
    ]);

    // Create maps for both search engines
    const googleIndustryVariationsMap = {};
    const braveIndustryVariationsMap = {};

    industries.forEach((industry, index) => {
      googleIndustryVariationsMap[industry] = googleIndustryVariations[index];
      braveIndustryVariationsMap[industry] = braveIndustryVariations[index];
    });

    console.log('Google industry variations map:', googleIndustryVariationsMap);
    console.log('Brave industry variations map:', braveIndustryVariationsMap);

    // Generate role + location + industry variation combinations for Google
    for (const role of roles) {
      if (!role) continue;

      for (const industry of industries) {
        if (!industry) continue;

        // Get both Google and Brave variations for this industry
        const googleVariations = googleIndustryVariationsMap[industry] || [industry.toLowerCase()];
        const braveVariations = braveIndustryVariationsMap[industry] || [industry.toLowerCase()];

        // Combine both Google and Brave variations for Google search
        const allVariationsForGoogle = [...new Set([...googleVariations, ...braveVariations])];

        // Create queries for each industry variation
        for (const industryVariation of allVariationsForGoogle) {
          // Always use format: site:linkedin.com/in intitle:"role" "role" "location" "industry_variation"
          const query = `site:linkedin.com/in intitle:"${role.toLowerCase()}" "${role.toLowerCase()}" "${location.toLowerCase()}" "${industryVariation}"`;
          queries.push(query);
        }
      }
    }

    console.log(`Generated ${queries.length} enhanced queries with OpenAI industry variations:`, queries);

    // ✅ Collect all industry variations for extraction (combine both Google and Brave variations)
    const allIndustryVariationsForExtraction = [];
    industries.forEach(industry => {
      const googleVariations = googleIndustryVariationsMap[industry] || [industry.toLowerCase()];
      const braveVariations = braveIndustryVariationsMap[industry] || [industry.toLowerCase()];
      allIndustryVariationsForExtraction.push(...googleVariations, ...braveVariations);
    });

    // Remove duplicates and include original industries
    const uniqueIndustryVariations = [...new Set([...allIndustryVariationsForExtraction, ...industries])];
    console.log('All industry variations for extraction:', uniqueIndustryVariations);

    // Generate Brave search queries (space-separated format)
    const braveQueries = [];
    if (includeBrave) {
      for (const role of roles) {
        if (!role) continue;

        for (const industry of industries) {
          if (!industry) continue;

          // Get OpenAI-generated variations for this industry (Brave format - single words)
          const industryVariations = braveIndustryVariationsMap[industry] || [industry.toLowerCase()];

          // Create Brave queries for each industry variation
          for (const industryVariation of industryVariations) {
            // Use space-separated format for Brave
            const braveQuery = `site:linkedin.com/in/ intitle:"${role.toLowerCase()}" ${role.toLowerCase()} ${location.toLowerCase()} ${industryVariation}`;
            braveQueries.push(braveQuery);
          }
        }
      }

      // Limit Brave queries to control API usage
      const maxBraveQueries = 10;
      const limitedBraveQueries = braveQueries.slice(0, maxBraveQueries);
      braveQueries.length = 0; // Clear original array
      braveQueries.push(...limitedBraveQueries);

      console.log(`Generated ${limitedBraveQueries.length} Brave search queries:`, braveQueries);
    }

    const maxPages = 10; // Limit per tier
    const allSearchPromises = [];
    let signalHireResults = [];
    let braveResults = [];

    const totalTieredSearches = queries.length * 6;
    // Check subscription limits before processing
    // const limitCheck = await usageService.checkSearchLimits(req.user.userId);
    // console.log('Search limits check:', limitCheck);

    // Check subscription limits before processing (skip for special user)
    const specialUserIds = [
      '687f290cdbaa807b7a3940b9',
      '687f386adbaa807b7a39416d',
      '687f93926c2df025fa30a761'
    ];

    if (!specialUserIds.includes(req.user.userId)) {
      const limitCheck = await usageService.checkSearchLimits(req.user.userId);
      console.log('Search limits check:', limitCheck);
    } else {
      console.log('Skipping search limits check for special user:', req.user.userId);
    }


    // Record the search usage (skip for special user)
    // if (req.user.userId !== specialUserId) {
    //   await usageService.recordSearch(req.user.userId);
    if (!specialUserIds.includes(req.user.userId)) {
      await usageService.recordSearch(req.user.userId);
      // Base charge: 5 credits for Google CSE search
      // let totalCredits = 20;

      // // Additional 3 credits if SignalHire is included
      // // if (includeSignalHire) {
      // //   totalCredits += 3;
      // // }

      // await creditService.consumeCredits(req.user.userId, 'SEARCH', totalCredits);
    } else {
      console.log('Skipping usage recording and credit consumption for special user:', req.user.userId);
    }

    // Search usage will be recorded after successful results are obtained

    // Calculate credits based on included services
    let totalCredits = 0;

    // Base charge: 20 credits for Google CSE search (if included)
    if (includeGoogle || includeBrave) {
      totalCredits += 50;
    }

    // Additional 3 credits if SignalHire is included
    // if (includeSignalHire) {
    //   totalCredits += 3;
    // }

    // Only consume credits if at least one service is enabled
    // if (totalCredits > 0) {
    //   await creditService.consumeCredits(req.user.userId, 'SEARCH', totalCredits);
    // }

    // Google CSE Search (conditional based on includeGoogle)
    if (includeGoogle) {
      for (const query of queries) {
        for (let page = 1; page <= maxPages; page++) {
          const startFrom = (page - 1) * 10 + 1;

          const searchPromise = googleCseService.searchLinkedInProfiles(query, startFrom)
            .then(results => {
              if (!results.error && Array.isArray(results.results)) {
                return results.results.map(result => ({
                  ...result,
                  relevanceScore: 100,
                  query,
                  page,
                  source: 'google'
                }));
              }
              return [];
            })
            .catch(err => {
              console.error(`Failed query: "${query}" on page ${page}`, err);
              return [];
            });

          allSearchPromises.push(searchPromise);
        }
      }
    }

    // Brave Search (if enabled)
    if (includeBrave && braveQueries.length > 0) {
      try {
        console.log(`Starting Brave search with ${braveQueries.length} queries...`);
        const maxBravePages = 10;
        const queryStats = {};

        // Process Brave queries sequentially with delays
        for (const braveQuery of braveQueries) {
          console.log(`Processing Brave query: ${braveQuery}`);
          queryStats[braveQuery] = { pages: 0, results: 0, stopped: false };

          // Search pages sequentially for each query
          for (let page = 1; page <= maxBravePages; page++) {
            try {
              // Add delay between requests to avoid rate limiting
              if (page > 1) {
                await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
              }

              const result = await googleCseService.searchBraveLinkedInProfiles(braveQuery, page);

              if (result.error) {
                console.log(`✗ Brave search failed for "${braveQuery}" page ${page}:`, result.message);
                if (result.status === 429) {
                  console.log(`  → Rate limited, waiting 2 seconds...`);
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  continue; // Retry this page
                }
                if (result.status >= 400 && result.status < 500) {
                  console.log(`  → Client error, stopping pagination for this query`);
                  queryStats[braveQuery].stopped = true;
                  break;
                }
                continue; // Skip this page but continue with next
              }

              const results = result.results || [];
              const resultCount = results.length;

              console.log(`✓ Brave found ${resultCount} results for "${braveQuery}" page ${page}`);

              queryStats[braveQuery].pages++;
              queryStats[braveQuery].results += resultCount;

              // Add results with metadata
              const enrichedResults = results.map(item => ({
                ...item,
                relevanceScore: 100,
                query: braveQuery,
                page,
                source: 'brave'
              }));

              braveResults.push(...enrichedResults);

              // Continue pagination logic
              if (resultCount < 10 && page >= 3) {
                console.log(`  → Low result count (${resultCount}) on page ${page}, stopping pagination for "${braveQuery}"`);
                queryStats[braveQuery].stopped = true;
                break;
              }

              if (resultCount === 0 && page > 1) {
                console.log(`  → No results on page ${page}, stopping pagination for "${braveQuery}"`);
                queryStats[braveQuery].stopped = true;
                break;
              }

            } catch (err) {
              console.error(`Error searching Brave "${braveQuery}" page ${page}:`, err.message);
              // Continue to next page
            }
          }
        }

        // Log Brave search statistics
        console.log('\n=== Brave Query Statistics ===');
        Object.entries(queryStats).forEach(([query, stats]) => {
          console.log(`"${query}": ${stats.results} results from ${stats.pages} pages ${stats.stopped ? '(stopped early)' : '(completed)'}`);
        });

        console.log(`Brave search completed. Found ${braveResults.length} total results.`);

      } catch (braveError) {
        console.error('Brave search failed:', braveError);
        // Continue with other results even if Brave fails
      }
    }

    // Convert industry to the most relevant predefined industry if provided (needed for SignalHire and IcyPeas)
    let convertedIndustry = undefined;
    if ((includeSignalHire || includeIcypeas) && industries.length > 0) {
      convertedIndustry = await openaiService.convertToRelevantIndustry(industries[0]);
      console.log(`Industry conversion: ${industries[0]} → ${convertedIndustry}`);
    }

    // SignalHire Search (if enabled)
    if (includeSignalHire && roles.length > 0) {
      try {

        const signalHireSearchCriteria = {
          title: roles[0], // Use first role
          location: location,
          industry: convertedIndustry,
          size: 100 // Maximum SignalHire results per page
        };

        console.log('SignalHire search criteria:', signalHireSearchCriteria);

        const signalHireResponse = await signalHireService.searchProfilesByCriteria(signalHireSearchCriteria);

        if (signalHireResponse.success && signalHireResponse.results && signalHireResponse.results.profiles) {
          let allSignalHireProfiles = [...signalHireResponse.results.profiles];

          // Get additional pages using scroll search if scrollId is available
          if (signalHireResponse.results.scrollId && signalHireResponse.results.requestId && allSignalHireProfiles.length < 500) {
            let currentScrollId = signalHireResponse.results.scrollId;
            const requestId = signalHireResponse.results.requestId;
            let page = 1;

            // Continue until no more pages
            while (currentScrollId && allSignalHireProfiles.length < 500) {
              try {
                console.log(`Fetching SignalHire page ${page + 1} with scrollId:`, currentScrollId);

                const scrollResponse = await signalHireService.scrollSearch(requestId, currentScrollId);

                if (scrollResponse.success && scrollResponse.results && scrollResponse.results.profiles && scrollResponse.results.profiles.length > 0) {
                  // Add profiles but respect the 500 limit
                  const remainingSlots = 500 - allSignalHireProfiles.length;
                  const profilesToAdd = scrollResponse.results.profiles.slice(0, remainingSlots);

                  allSignalHireProfiles = allSignalHireProfiles.concat(profilesToAdd);
                  console.log(`Added ${profilesToAdd.length} profiles from page ${page + 1}. Total: ${allSignalHireProfiles.length}`);

                  // If we reached 500 profiles, stop searching
                  if (allSignalHireProfiles.length >= 500) {
                    console.log('Reached 500 SignalHire profiles limit, stopping pagination');
                    break;
                  }

                  // Update scrollId for next page
                  if (scrollResponse.results.scrollId) {
                    currentScrollId = scrollResponse.results.scrollId;
                  } else {
                    // No more pages available
                    console.log('No more scrollId available, reached last page');
                    break;
                  }
                } else {
                  // No more results or error
                  console.log('No more profiles available or empty response');
                  break;
                }

                page++;
              } catch (scrollError) {
                console.error(`SignalHire scroll search page ${page + 1} failed:`, scrollError);
                break; // Stop pagination on error
              }
            }
          }
          // Ensure we don't exceed 500 profiles (safety check)
          if (allSignalHireProfiles.length > 500) {
            allSignalHireProfiles = allSignalHireProfiles.slice(0, 500);
            console.log('Trimmed SignalHire profiles to 500 limit');
          }
          console.log(`Final SignalHire profiles count: ${allSignalHireProfiles.length}`);


          // Convert all SignalHire profiles to our standard format
          signalHireResults = allSignalHireProfiles.map(profile => ({
            // Convert SignalHire format to our standard format
            title: `${profile.fullName || 'Unknown'} - ${profile.experience?.[0]?.title || 'Professional'} - ${profile.experience?.[0]?.company || 'Company'}`,
            link: '',
            snippet: `${profile.fullName || 'Unknown'} • ${profile.location} • ${profile.experience?.[0]?.title || ''} at ${profile.experience?.[0]?.company || ''}`,
            pagemap: {
              metatags: [{
                'profile:first_name': profile.fullName ? profile.fullName.split(' ')[0] || '' : '',
                'profile:last_name': profile.fullName ? profile.fullName.split(' ').slice(1).join(' ') || '' : '',
                'og:description': `${profile.fullName || 'Unknown'} • ${profile.location} • ${profile.experience?.[0]?.title || ''}`
              }]
            },
            // Add SignalHire specific data
            signalHireData: {
              uid: profile.uid,
              fullName: profile.fullName,
              location: profile.location,
              experience: profile.experience || [],
              skills: profile.skills || [],
              contactsFetched: profile.contactsFetched
            },
            relevanceScore: 100,
            source: 'signalhire'
          }));
        }
      } catch (signalHireError) {
        console.error('SignalHire search failed:', signalHireError);
        // Continue with Google results even if SignalHire fails
      }
    }

    let icypeasResults = [];
    if (includeIcypeas && roles.length > 0) {
      let icypeasLimit = 200; // Default limit
      if (includeSignalHire) {
        const remaining = 500 - signalHireResults.length;
        icypeasLimit = Math.max(0, Math.min(remaining, 200)); // Cap at Icypeas max limit of 200
        console.log(`SignalHire returned ${signalHireResults.length} profiles. Fetching up to ${icypeasLimit} from IcyPeas (max 200).`);
      }

      if (icypeasLimit > 0) {
        try {
          const icypeasSearchCriteria = {
            title: roles[0], // Use first role
            location: location,
            keywords: convertedIndustry || (industries.length > 0 ? industries[0] : undefined), // Use converted industry if available
            size: icypeasLimit // Maximum IcyPeas results per request
          };

          console.log('IcyPeas search criteria:', icypeasSearchCriteria);

          const icypeasResponse = await icypeasService.searchProfilesByCriteria(icypeasSearchCriteria);

          if (icypeasResponse.success && icypeasResponse.results && icypeasResponse.results.profiles) {
            let allIcypeasProfiles = [...icypeasResponse.results.profiles];

            // IcyPeas might not have scroll search like SignalHire, but you can try pagination
            // if (icypeasResponse.results.total > 100) {
            //   try {
            //     const page2Response = await icypeasService.getNextPage(icypeasSearchCriteria, 2);
            //     if (page2Response.success && page2Response.results.profiles) {
            //       allIcypeasProfiles = allIcypeasProfiles.concat(page2Response.results.profiles);
            //     }
            //   } catch (paginationError) {
            //     console.error('IcyPeas pagination failed:', paginationError);
            //   }
            // }

            // Limit to the calculated limit
            if (allIcypeasProfiles.length > icypeasLimit) {
              allIcypeasProfiles = allIcypeasProfiles.slice(0, icypeasLimit);
              console.log(`Trimmed IcyPeas profiles to ${icypeasLimit} limit`);
            }

            console.log(`Final IcyPeas profiles count: ${allIcypeasProfiles.length}`);

            // Convert IcyPeas profiles to our standard format
            icypeasResults = allIcypeasProfiles.map(profile => ({
              // Convert IcyPeas format to our standard format
              title: `${profile.fullName} - ${profile.experience?.[0]?.title || 'Professional'} - ${profile.experience?.[0]?.company || 'Company'}`,
              link: profile.icypeasData.profileUrl || '',
              snippet: `${profile.fullName} • ${profile.location} • ${profile.experience?.[0]?.title || ''} at ${profile.experience?.[0]?.company || ''}`,
              pagemap: {
                metatags: [{
                  'profile:first_name': profile.icypeasData.firstname || '',
                  'profile:last_name': profile.icypeasData.lastname || '',
                  'og:description': `${profile.fullName} • ${profile.location} • ${profile.experience?.[0]?.title || ''}`
                }]
              },
              // Add IcyPeas specific data
              icypeasData: profile.icypeasData,
              relevanceScore: 100,
              source: 'icypeas'
            }));
          }
        } catch (icypeasError) {
          console.error('IcyPeas search failed:', icypeasError);
          // Continue with other results even if IcyPeas fails
        }
      } else {
        console.log('Skipping IcyPeas search as SignalHire already returned 500 or more results.');
      }
    }

    let contactOutResults = [];
    if (includeContactOut && roles.length > 0) {
      try {
        // Convert industry to ContactOut's accepted industry values
        let convertedContactOutIndustry = undefined;
        if (industries.length > 0) {
          convertedContactOutIndustry = await openaiService.convertToContactOutIndustry(industries[0]);
          console.log(`ContactOut industry conversion: ${industries[0]} → ${convertedContactOutIndustry}`);
        }

        const contactOutSearchCriteria = {
          title: roles[0], // Use first role
          location: location,
          industry: convertedContactOutIndustry, // Use converted industry
          size: 25 // ContactOut default page size
        };

        console.log('ContactOut search criteria:', contactOutSearchCriteria);

        const contactOutResponse = await contactOutService.searchProfilesByCriteria(contactOutSearchCriteria);

        if (contactOutResponse.success && contactOutResponse.results && contactOutResponse.results.profiles) {
          let allContactOutProfiles = [...contactOutResponse.results.profiles];

          // Try to get additional pages if available
          if (contactOutResponse.results.hasMore && allContactOutProfiles.length < 600) {
            try {
              const multiPageResponse = await contactOutService.getMultiplePages(contactOutSearchCriteria, 24); // 24 pages * 25 results/page = 600
              if (multiPageResponse.success && multiPageResponse.results.profiles) {
                allContactOutProfiles = multiPageResponse.results.profiles;
              }
            } catch (paginationError) {
              console.error('ContactOut pagination failed:', paginationError);
            }
          }

          // Limit to 600 profiles
          if (allContactOutProfiles.length > 600) {
            allContactOutProfiles = allContactOutProfiles.slice(0, 600);
            console.log('Trimmed ContactOut profiles to 600 limit');
          }

          console.log(`Final ContactOut profiles count: ${allContactOutProfiles.length}`);

          // Convert ContactOut profiles to our standard format
          contactOutResults = allContactOutProfiles.map(profile => ({
            // Convert ContactOut format to our standard format
            title: `${profile.fullName} - ${profile.title || 'Professional'} - ${profile.company?.name || 'Company'}`,
            link: profile.linkedInUrl || '',
            snippet: `${profile.fullName} • ${profile.location} • ${profile.title || ''} at ${profile.company?.name || ''}`,
            pagemap: {
              metatags: [{
                'profile:first_name': profile.fullName ? profile.fullName.split(' ')[0] || '' : '',
                'profile:last_name': profile.fullName ? profile.fullName.split(' ').slice(1).join(' ') || '' : '',
                'og:description': `${profile.fullName} • ${profile.location} • ${profile.title || ''}`
              }]
            },
            // Include the transformed fields directly
            fullName: profile.fullName,
            title: profile.title,
            location: profile.location,
            industry: profile.industry,
            company: profile.company,
            linkedInUrl: profile.linkedInUrl,
            liVanity: profile.liVanity,
            // Add ContactOut specific data
            contactOutData: profile.contactOutData,
            relevanceScore: 100,
            source: 'contactout'
          }));
        }
      } catch (contactOutError) {
        console.error('ContactOut search failed:', contactOutError);
        // Continue with other results even if ContactOut fails
      }
    }

    // Helper function to normalize names
    const normalizeName = (name) => {
      if (!name || typeof name !== 'string') return '';

      return name
        .toLowerCase()
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .replace(/\b(jr|sr|iii|ii|iv)\b/g, '') // Remove suffixes
        .replace(/\b(mr|mrs|ms|dr|prof)\b/g, '') // Remove titles
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
    };

    // Helper function to normalize company names
    const normalizeCompany = (company) => {
      if (!company || typeof company !== 'string') return '';

      return company
        .toLowerCase()
        .replace(/\b(inc|ltd|llc|corp|corporation|company|co|ab|group|gmbh|sa)\b/g, '') // Remove corp suffixes
        .replace(/[^\w\s]/g, '') // Remove punctuation
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
    };

    const normalizeLinkedInUrl = (url) => {
      if (!url || typeof url !== 'string') return null;

      // Extract just the profile identifier
      const match = url.match(/linkedin\.com\/in\/([^/?]+)/i);
      if (match) {
        return match[1].toLowerCase().replace(/\/$/, ''); // Remove trailing slash
      }
      return null;
    };

    const resultsArrays = await Promise.all(allSearchPromises);
    const googleResults = resultsArrays.flat();

    // Combine Google, SignalHire, and Brave results
    const allResults = [...googleResults, ...signalHireResults, ...braveResults, ...csvResults, ...icypeasResults, ...contactOutResults];

    const seen = new Set();
    const linkedInUrlMap = new Map(); // Track by LinkedIn URL
    const nameCompanyMap = new Map(); // Track by name+company

    const uniqueResults = allResults.filter(result => {
      // Extract and normalize potential identifiers
      let linkedinUrl = null;
      let fullName = '';
      let company = '';

      if (result.source === 'csv_import') {
        linkedinUrl = normalizeLinkedInUrl(result.csvData.linkedinUrl);
        fullName = normalizeName(result.csvData.name);
        company = normalizeCompany(result.csvData.company);
      } else if (result.source === 'signalhire') {
        fullName = normalizeName(result.signalHireData.fullName || '');
        company = normalizeCompany(result.signalHireData.experience?.[0]?.company || '');
        // SignalHire usually doesn't have LinkedIn URLs
      } else if (result.source === 'contactout') {
        linkedinUrl = normalizeLinkedInUrl(result.linkedInUrl);
        fullName = normalizeName(result.fullName || '');
        company = normalizeCompany(result.company?.name || '');
      } else {
        // Google/Brave results
        linkedinUrl = normalizeLinkedInUrl(result.link);
        fullName = normalizeName(result.fullName ||
          `${result.pagemap?.metatags?.[0]?.['profile:first_name'] || ''} ${result.pagemap?.metatags?.[0]?.['profile:last_name'] || ''}`.trim()
        );
        company = normalizeCompany(result.extractedCompany || '');
      }

      // Strategy 1: Check LinkedIn URL (most reliable)
      if (linkedinUrl) {
        if (linkedInUrlMap.has(linkedinUrl)) {
          console.log(`🔍 DUPLICATE by LinkedIn URL: ${linkedinUrl} (${result.source})`);
          return false; // Duplicate found
        }
        linkedInUrlMap.set(linkedinUrl, result);
      }

      // Strategy 2: Check Name + Company combination (fallback)
      if (fullName && company) {
        const nameCompanyKey = `${fullName}|${company}`;
        if (nameCompanyMap.has(nameCompanyKey)) {
          console.log(`🔍 DUPLICATE by Name+Company: ${nameCompanyKey} (${result.source})`);
          return false; // Duplicate found
        }
        nameCompanyMap.set(nameCompanyKey, result);
      }

      // Strategy 3: Fallback to original logic for edge cases
      let uniqueId;
      if (result.source === 'signalhire') {
        uniqueId = `signalhire_${result.signalHireData.uid}`;
      } else if (result.source === 'csv_import') {
        uniqueId = `csv_${result.csvData.name}_${result.csvData.company}_${result.csvData.title}`;
      } else if (result.source === 'icypeas') {
        // Use IcyPeas profile URL or UID as unique identifier
        uniqueId = `icypeas_${result.icypeasData.profileUrl?.split('/').pop() || result.uid}`;
      } else if (result.source === 'contactout') {
        // Use ContactOut LinkedIn URL or full name as unique identifier
        uniqueId = `contactout_${result.liVanity || result.fullName || result.linkedInUrl}`;
      } else {
        uniqueId = result.link;
      }

      if (seen.has(uniqueId)) {
        console.log(`🔍 DUPLICATE by fallback ID: ${uniqueId} (${result.source})`);
        return false;
      }
      seen.add(uniqueId);

      return true; // Keep this result
    });

    // Separate results by source for different processing
    const googleResultsOnly = uniqueResults.filter(result => result.source === 'google');
    const signalHireResultsOnly = uniqueResults.filter(result => result.source === 'signalhire');
    const braveResultsOnly = uniqueResults.filter(result => result.source === 'brave');
    const csvResultsOnly = uniqueResults.filter(result => result.source === 'csv_import');
    const icypeasResultsOnly = uniqueResults.filter(result => result.source === 'icypeas');
    const contactOutResultsOnly = uniqueResults.filter(result => result.source === 'contactout');

    // Process Google results with OpenAI extraction
    let processedGoogleResults = [];
    if (googleResultsOnly.length > 0) {
      const batchSize = 40;
      const concurrencyLimit = 8;

      const batches = [];
      for (let i = 0; i < googleResultsOnly.length; i += batchSize) {
        batches.push(googleResultsOnly.slice(i, i + batchSize));
      }

      // Parallelize with concurrency control
      const limit = pLimit(concurrencyLimit);

      const batchPromises = batches.map((batch, batchIndex) =>
        limit(async () => {
          // Add delay between batches to avoid rate limiting
          if (batchIndex > 0) {
            await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 second delay
          }

          let extractedBatch = [];

          try {
            // Try Gemini first
            console.log(`Processing Google batch ${batchIndex + 1} with Gemini service...`);
            extractedBatch = await geminiService.extractProfilesDataBatch(batch, industries, roles, locations);
          } catch (geminiError) {
            console.warn(`Gemini service failed for Google batch ${batchIndex + 1}, falling back to OpenAI:`, geminiError.message);

            try {
              // Fallback to OpenAI
              console.log(`Fallback: Processing Google batch ${batchIndex + 1} with OpenAI service...`);
              extractedBatch = await openaiService.extractProfilesDataBatch(batch, industries, roles, locations);
            } catch (openaiError) {
              console.error(`Both Gemini and OpenAI failed for Google batch ${batchIndex + 1}:`, openaiError.message);
              // Return empty array for this batch to continue processing other batches
              extractedBatch = [];
            }
          }

          return batch.map((result, i) => {
            const extracted = extractedBatch[i] || {};

            return {
              ...result,
              extractedTitle: extracted.title || '',
              extractedCompany: extracted.company || '',
              extractedLocation: extracted.location || (() => {
                const ogDesc = result.pagemap?.metatags?.[0]?.['og:description'] || '';
                const snippet = result.snippet || '';

                // Try og:description first
                let locationMatch = ogDesc.match(/(?:Location|Plats)\s*[:：]?\s*([^·\n]+)/i);
                if (locationMatch && locationMatch[1]) {
                  return locationMatch[1].trim();
                }

                // Fallback to snippet
                locationMatch = snippet.match(/(?:Location|Plats)\s*[:：]?\s*([^·\n]+)/i);
                if (locationMatch && locationMatch[1]) {
                  return locationMatch[1].trim();
                }

                return '';
              })(),
              extractedIndustry: extracted.industry || '',
              fullName: `${result.pagemap?.metatags?.[0]?.['profile:first_name'] || ''} ${result.pagemap?.metatags?.[0]?.['profile:last_name'] || ''}`.trim(),
              linkedinUrl: result.link.replace(/`/g, '').trim()
            };
          });
        })
      );

      const enrichedResultsBatches = await Promise.all(batchPromises);
      processedGoogleResults = enrichedResultsBatches.flat();
    }

    // Process Brave results with OpenAI extraction (similar to Google)
    let processedBraveResults = [];
    if (braveResultsOnly.length > 0) {
      const batchSize = 40;
      const concurrencyLimit = 8;

      const batches = [];
      for (let i = 0; i < braveResultsOnly.length; i += batchSize) {
        batches.push(braveResultsOnly.slice(i, i + batchSize));
      }

      // Parallelize with concurrency control
      const limit = pLimit(concurrencyLimit);

      const batchPromises = batches.map((batch, batchIndex) =>
        limit(async () => {
          // Add delay between batches to avoid rate limiting
          if (batchIndex > 0) {
            await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 second delay
          }

          console.log('🔍 DEBUG: Industries being passed for Brave results:', uniqueIndustryVariations);

          let extractedBatch = [];

          try {
            // Try Gemini first
            console.log(`Processing Brave batch ${batchIndex + 1} with Gemini service...`);
            extractedBatch = await geminiService.extractProfilesDataBatch(batch, uniqueIndustryVariations, roles, locations);
          } catch (geminiError) {
            console.warn(`Gemini service failed for Brave batch ${batchIndex + 1}, falling back to OpenAI:`, geminiError.message);

            try {
              // Fallback to OpenAI
              console.log(`Fallback: Processing Brave batch ${batchIndex + 1} with OpenAI service...`);
              extractedBatch = await openaiService.extractProfilesDataBatch(batch, uniqueIndustryVariations, roles, locations);
            } catch (openaiError) {
              console.error(`Both Gemini and OpenAI failed for Brave batch ${batchIndex + 1}:`, openaiError.message);
              // Return empty array for this batch to continue processing other batches
              extractedBatch = [];
            }
          }

          return batch.map((result, i) => {
            const extracted = extractedBatch[i] || {};

            return {
              ...result,
              extractedTitle: extracted.title || '',
              extractedCompany: extracted.company || '',
              extractedLocation: extracted.location || (() => {
                const ogDesc = result.pagemap?.metatags?.[0]?.['og:description'] || '';
                const snippet = result.snippet || '';

                // Try og:description first
                let locationMatch = ogDesc.match(/(?:Location|Plats)\s*[:：]?\s*([^·\n]+)/i);
                if (locationMatch && locationMatch[1]) {
                  return locationMatch[1].trim();
                }

                // Fallback to snippet
                locationMatch = snippet.match(/(?:Location|Plats)\s*[:：]?\s*([^·\n]+)/i);
                if (locationMatch && locationMatch[1]) {
                  return locationMatch[1].trim();
                }

                return '';
              })(),
              extractedIndustry: extracted.industry || '',
              fullName: `${result.pagemap?.metatags?.[0]?.['profile:first_name'] || ''} ${result.pagemap?.metatags?.[0]?.['profile:last_name'] || ''}`.trim(),
              linkedinUrl: result.link.replace(/`/g, '').trim()
            };
          });
        })
      );

      const enrichedResultsBatches = await Promise.all(batchPromises);
      processedBraveResults = enrichedResultsBatches.flat();
    }

    // Create combined CSV file with Google and Brave results for OpenAI analysis
    // const combinedGoogleBraveResults = [...googleResultsOnly, ...braveResultsOnly];
    // if (combinedGoogleBraveResults.length > 0) {
    //   createSimpleOpenAIAnalysisCSV(combinedGoogleBraveResults, 'main');
    // }

    // Process SignalHire results (no OpenAI needed, use existing structured data)
    const processedSignalHireResults = signalHireResultsOnly.map(result => ({
      ...result,
      extractedTitle: result.signalHireData.experience?.[0]?.title || '',
      extractedCompany: result.signalHireData.experience?.[0]?.company || '',
      extractedLocation: result.signalHireData.location || '',
      extractedIndustry: industries.length > 0 ? industries[0] : '',
      fullName: result.signalHireData.fullName || 'Unknown',
      linkedinUrl: ''
    }));

    const processedIcypeasResults = icypeasResultsOnly.map(result => ({
      ...result,
      extractedTitle: result.icypeasData.lastJobTitle || '',
      extractedCompany: result.icypeasData.lastCompanyName || '',
      extractedLocation: result.icypeasData.address || '',
      extractedIndustry: result.icypeasData.lastCompanyIndustry || (industries.length > 0 ? industries[0] : ''),
      fullName: result.icypeasData.firstname + ' ' + result.icypeasData.lastname,
      linkedinUrl: result.icypeasData.profileUrl || ''
    }));

    const processedContactOutResults = contactOutResultsOnly.map(result => ({
      ...result,
      extractedTitle: result.title || '',
      extractedCompany: result.company?.name || '',
      extractedLocation: result.location || '',
      extractedIndustry: result.industry || (industries.length > 0 ? industries[0] : ''),
      fullName: result.fullName || 'Unknown',
      linkedinUrl: result.linkedInUrl || ''
    }));

    // Combine all processed results
    let enrichedResults = [...processedGoogleResults, ...processedBraveResults, ...processedSignalHireResults, ...csvResultsOnly, ...processedIcypeasResults, ...processedContactOutResults];

    // Add heuristic industry assignment based on filters and profile content
    // Use uniqueIndustryVariations to properly match Brave results that used industry variations
    const industryFilters = new Set(uniqueIndustryVariations.map(i => i.toLowerCase()));

    enrichedResults = enrichedResults.map(result => {
      let extractedIndustry = result.industry || result.extractedIndustry || '';

      if (Array.isArray(extractedIndustry)) {
        extractedIndustry = extractedIndustry.join(', ');
      }

      // ENHANCED INDUSTRY MATCHING LOGIC
      // First, check if any of the original search industries match the extracted industry
      const originalSearchIndustries = industries; // e.g., ["Enterprise Software"]
      let finalIndustry = extractedIndustry;

      if (extractedIndustry) {
        const lowercaseExtracted = extractedIndustry.toLowerCase();

        // Check if extracted industry contains any of the original search industries
        const matchedSearchIndustry = originalSearchIndustries.find(searchIndustry => {
          const lowercaseSearch = searchIndustry.toLowerCase();

          // Exact match
          if (lowercaseExtracted === lowercaseSearch) {
            return true;
          }

          // Check if extracted contains the search industry
          if (lowercaseExtracted.includes(lowercaseSearch)) {
            return true;
          }

          // Check if search industry contains extracted (for cases like "software" matching "Enterprise Software")
          if (lowercaseSearch.includes(lowercaseExtracted)) {
            return true;
          }

          // Check for key terms - if search is "Enterprise Software" and extracted contains "software"
          const searchWords = lowercaseSearch.split(' ');
          const extractedWords = lowercaseExtracted.split(/[,\s]+/);

          const hasSignificantOverlap = searchWords.some(searchWord =>
            searchWord.length > 3 && extractedWords.some(extractedWord =>
              extractedWord.includes(searchWord) || searchWord.includes(extractedWord)
            )
          );

          return hasSignificantOverlap;
        });

        if (matchedSearchIndustry) {
          finalIndustry = matchedSearchIndustry;
        }
      }

      // If no direct match found, proceed with existing heuristic logic
      if (!finalIndustry || finalIndustry === extractedIndustry) {
        // Check if any industry filter matches snippet, title, or description
        const industrySources = [
          result.snippet || '',
          result.extractedTitle || '',
          result.pagemap?.metatags?.[0]?.['og:description'] || ''
        ].map(s => s.toLowerCase());

        industryFilters.forEach(industryFilter => {
          if (industryFilter && !finalIndustry.toLowerCase().includes(industryFilter)) {
            for (const source of industrySources) {
              if (source.includes(industryFilter)) {
                // Find the original search industry that matches this filter
                const matchingOriginalIndustry = originalSearchIndustries.find(orig =>
                  orig.toLowerCase().includes(industryFilter) ||
                  industryFilter.includes(orig.toLowerCase())
                );

                if (matchingOriginalIndustry) {
                  finalIndustry = matchingOriginalIndustry;
                } else {
                  finalIndustry = finalIndustry ? finalIndustry + ', ' + industryFilter : industryFilter;
                }
                break;
              }
            }
          }
        });
      }

      return {
        ...result,
        extractedIndustry: finalIndustry
      };
    });

    // Updated scoring system as per client requirements
    const resultsWithFractionalScores = enrichedResults.map(result => {
      // Calculate matched filters by category
      const matchedCategories = calculateMatchedCategories(result, filters, uniqueIndustryVariations, industries);

      // Total categories is 3 (location, title, industry) plus any additional filter types
      const additionalFilterTypes = new Set(otherFilters.map(f => f.field));
      const totalCategories = 3 + additionalFilterTypes.size;

      // Calculate the fractional score
      // Use matchedCategoriesValue to determine matched categories based on actual matched values
      const matchedCategoriesWithValues = {
        matched: 0,
        total: totalCategories,
        details: {}
      };

      // For each filter type, determine which specific values matched
      Object.keys(matchedCategories.details).forEach(fieldType => {
        // Get all filter values for this field type
        const filterValues = filters
          .filter(f => f.field === fieldType)
          .map(f => f.value);

        const matchedValues = [];

        for (const value of filterValues) {
          if (!value.trim()) continue;

          const lowercaseValue = value.toLowerCase();
          let valueMatched = false;

          if (fieldType === 'location') {
            // Location matching logic
            const locationSources = [
              result.extractedLocation
            ];

            for (const source of locationSources) {
              if (source && typeof source === 'string') {
                const normalizedSource = source.toLowerCase().normalize();
                const normalizedValue = lowercaseValue.normalize();
                if (normalizedSource === normalizedValue ||
                  new RegExp(`\\b${normalizedValue}\\b`).test(normalizedSource)) {
                  valueMatched = true;
                  break;
                }
              }
            }
          }
          else if (fieldType === 'title') {
            // Title matching logic
            const titleSources = [
              result.extractedTitle,
              getFieldValue(result, 'title'),
              (result.title || '').split(' - ')[1],
              result.snippet,
              result.pagemap?.metatags?.[0]?.['og:description']
            ];

            for (const source of titleSources) {
              if (source && typeof source === 'string') {
                if (source.toLowerCase().includes(lowercaseValue) ||
                  checkRelatedTerms(source.toLowerCase(), lowercaseValue)) {
                  valueMatched = true;
                  break;
                }
              }
            }
          }
          else if (fieldType === 'industry') {
            // Enhanced industry matching logic using uniqueIndustryVariations
            if (result.extractedIndustry && typeof result.extractedIndustry === 'string') {
              const extractedIndustry = result.extractedIndustry.toLowerCase();

              // Check if extracted industry matches any variation that corresponds to the original search industry
              const matchedVariations = uniqueIndustryVariations.filter(variation => {
                const lowerVariation = variation.toLowerCase();
                return extractedIndustry.includes(lowerVariation) ||
                  lowerVariation.includes(extractedIndustry) ||
                  extractedIndustry.split(/[,\s]+/).some(word =>
                    word.trim() && lowerVariation.includes(word.trim())
                  );
              });

              // If we found matching variations, check if any correspond to the current search industry
              if (matchedVariations.length > 0) {
                // Find which original industry this variation belongs to
                const originalIndustry = industries.find(origIndustry => {
                  const lowerOrigIndustry = origIndustry.toLowerCase();
                  return lowerOrigIndustry === lowercaseValue ||
                    matchedVariations.some(variation =>
                      variation.toLowerCase() === lowerOrigIndustry ||
                      // Check if this variation was generated from the original industry
                      (googleIndustryVariationsMap[origIndustry] &&
                        googleIndustryVariationsMap[origIndustry].includes(variation)) ||
                      (braveIndustryVariationsMap[origIndustry] &&
                        braveIndustryVariationsMap[origIndustry].includes(variation))
                    );
                });

                if (originalIndustry && originalIndustry.toLowerCase() === lowercaseValue) {
                  valueMatched = true;
                }
              }
            }
          }
          else {
            // Other field types
            const otherSources = [
              getFieldValue(result, fieldType),
              result.snippet,
              result.pagemap?.metatags?.[0]?.['og:description']
            ];

            for (const source of otherSources) {
              if (source && typeof source === 'string' &&
                source.toLowerCase().includes(lowercaseValue)) {
                valueMatched = true;
                break;
              }
            }
          }

          // If this specific value matched, add it to the list
          if (valueMatched) {
            matchedValues.push(value);
          }
        }

        // Store only the values that actually matched
        matchedCategoriesWithValues.details[fieldType] = matchedValues;

        // Increment matched count if matchedValues is not empty
        if (matchedValues.length > 0) {
          matchedCategoriesWithValues.matched++;
        }
      });

      // Boost SignalHire results slightly in relevance
      const sourceBoost = result.source === 'signalhire' ? 0.1 : 0;

      return {
        ...result,
        originalRelevanceScore: result.relevanceScore,
        relevanceScore: `${matchedCategoriesWithValues.matched}/${matchedCategoriesWithValues.total}`,
        matchedCategories: matchedCategoriesWithValues.details, // For debugging
        matchedCategoriesValue: matchedCategoriesWithValues,
        sourceBoost
      };
    });

    // Sort by location match first, then fractional relevance score, then source boost
    const locationFilter = filters.find(f => f.field === 'location');
    if (locationFilter) {
      const locationValue = locationFilter.value.toLowerCase();

      // Helper function to check if locationValue is contained in extractedLocation with some flexibility
      const locationMatchScore = (extractedLocation) => {
        if (!extractedLocation || typeof extractedLocation !== 'string') return 0;
        const loc = extractedLocation.toLowerCase();

        if (loc === locationValue) return 3; // exact match highest
        if (loc.includes(locationValue)) return 2; // contains locationValue
        // Check for common variations like "Greater Stockholm"
        if (locationValue.includes('stockholm') && loc.includes('stockholm')) return 1;
        return 0;
      };

      resultsWithFractionalScores.sort((a, b) => {
        const aLocScore = locationMatchScore(a.extractedLocation);
        const bLocScore = locationMatchScore(b.extractedLocation);

        if (bLocScore !== aLocScore) {
          return bLocScore - aLocScore; // higher location match score first
        }

        // If location match score equal, sort by fractional relevance score
        const [aNum, aTotal] = a.relevanceScore.split('/').map(Number);
        const [bNum, bTotal] = b.relevanceScore.split('/').map(Number);

        const aFraction = aNum / aTotal + (a.sourceBoost || 0);
        const bFraction = bNum / bTotal + (b.sourceBoost || 0);

        if (bFraction !== aFraction) {
          return bFraction - aFraction;
        }

        return b.originalRelevanceScore - a.originalRelevanceScore;
      });
    } else {
      // No location filter, sort by fractional relevance score only
      resultsWithFractionalScores.sort((a, b) => {
        const [aNum, aTotal] = a.relevanceScore.split('/').map(Number);
        const [bNum, bTotal] = b.relevanceScore.split('/').map(Number);

        const aFraction = aNum / aTotal + (a.sourceBoost || 0);
        const bFraction = bNum / bTotal + (b.sourceBoost || 0);

        if (bFraction !== aFraction) {
          return bFraction - aFraction;
        }

        return b.originalRelevanceScore - a.originalRelevanceScore;
      });
    }

    // Filter results to only include those with 3/3 relevanceScore
    // const filteredResults = resultsWithFractionalScores;

    const filteredResults = resultsWithFractionalScores.filter(result =>
      result.relevanceScore === "3/3"
    );

    // Filter out results with empty links
    const finalResults = filteredResults.filter(result =>
      result.source === 'csv_import' ||
      result.source === 'signalhire' ||
      result.source === 'icypeas' ||
      result.source === 'contactout' ||
      (result.link && result.link.trim() !== "")
    );
    // Only consume credits and record search usage after successful search operations
    if (finalResults.length > 0) {
      await creditService.consumeCredits(req.user.userId, 'SEARCH', totalCredits);
      await usageService.recordSearch(req.user.userId);
    }

    console.log(`Filtered results: ${filteredResults.length}/${resultsWithFractionalScores.length} results with 3/3 relevance score`);
    console.log(`Final results: ${finalResults.length}/${filteredResults.length} results after removing empty LinkedIn URLs`);

    res.status(StatusCodes.OK).json({
      results: finalResults,
      usage: await usageService.getSearchUsage(req.user.userId),
      meta: {
        totalResults: finalResults.length,
        totalResultsBeforeFilter: resultsWithFractionalScores.length,
        resultsAfterRelevanceFilter: filteredResults.length,
        totalFetched: allResults.length,
        uniqueResults: uniqueResults.length,
        googleResults: googleResults.length,
        braveResults: braveResults.length,
        signalHireResults: signalHireResults.length,
        icypeasResults: icypeasResults.length,
        contactOutResults: contactOutResults.length,
        csvImportResults: csvResults.length,
        csvResultsInFinal: finalResults.filter(r => r.source === 'csv_import').length,
        queriesUsed: queries.length,
        braveQueriesUsed: includeBrave ? braveQueries.length : 0,
        totalTiers: totalTieredSearches,
        filters: filters,
        includeSignalHire,
        includeBrave,
        includeIcypeas,
        includeContactOut,
        includeCsvImport,
        csvImportMeta: csvMeta
      }
    });
  } catch (error) {
    console.error('Error in searchLinkedInProfiles:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Search processing failed',
      details: error.message
    });
  }
};

exports.importCsv = async (req, res) => {
  try {
    let filters = [];
    let csvData = [];

    if (typeof req.body.filters === 'string') {
      try {
        filters = JSON.parse(req.body.filters);
      } catch (e) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Invalid filters format. Expected JSON array.'
        });
      }
    } else if (Array.isArray(req.body.filters)) {
      filters = req.body.filters;
    } else {
      filters = [];
    }

    // Check if filters are provided
    if (!Array.isArray(filters) || filters.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide filters for title, location, and industry'
      });
    }

    // Extract filter values by category
    const getFilterValues = (field) => filters
      .filter(f => f.field === field)
      .map(f => f.value.toLowerCase().trim())
      .filter(v => v.length > 0);

    const titleFilters = getFilterValues('title');
    const locationFilters = getFilterValues('location');
    const industryFilters = getFilterValues('industry');

    // Ensure we have all three required filter types
    if (titleFilters.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide at least one title filter'
      });
    }

    if (locationFilters.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide at least one location filter'
      });
    }

    if (industryFilters.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide at least one industry filter'
      });
    }

    // Handle different input methods
    if (req.file) {
      // FILE UPLOAD: Process uploaded file
      console.log('Processing uploaded file:', req.file.originalname);

      try {
        const fileExtension = path.extname(req.file.originalname).toLowerCase();

        if (fileExtension === '.csv') {
          // Parse CSV file
          csvData = await parseCsvBuffer(req.file.buffer);
        } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
          // Parse Excel file
          csvData = await parseExcelBuffer(req.file.buffer);
        } else {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'Unsupported file format. Please upload CSV or XLSX files.'
          });
        }
      } catch (parseError) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Failed to parse uploaded file',
          details: parseError.message
        });
      }

    } else if (req.body.csv && req.body.csv.data) {
      // JSON DATA: Process data from request body (existing functionality)
      const { csv } = req.body;

      try {
        if (typeof csv.data === 'string') {
          // Parse CSV string
          csvData = await parseCsvString(csv.data);
        } else if (Array.isArray(csv.data)) {
          // Data is already parsed as array of objects
          csvData = csv.data.map(row => {
            const normalizedRow = {};
            Object.keys(row).forEach(key => {
              normalizedRow[key.toLowerCase()] = (row[key] || '').toString().trim();
            });
            return normalizedRow;
          });
        } else {
          return res.status(StatusCodes.BAD_REQUEST).json({
            error: 'Invalid CSV data format. Expected string or array of objects.'
          });
        }
      } catch (parseError) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Failed to parse CSV data',
          details: parseError.message
        });
      }

    } else {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide either a CSV/XLSX file upload or CSV data in the request body'
      });
    }

    if (csvData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'No data found in the provided CSV/XLSX'
      });
    }

    // Validate required fields
    // const requiredFields = ['name', 'title', 'company', 'location', 'industry', 'linkedinurl'];
    // const sampleRow = csvData[0];
    // const availableFields = Object.keys(sampleRow).map(key => key.toLowerCase());

    // const missingFields = requiredFields.filter(required => {
    //   return !availableFields.some(available => {
    //     const normalize = (str) => str.toLowerCase().replace(/\s+/g, '');
    //     return normalize(available) === normalize(required);
    //   });
    // });


    // if (missingFields.length > 0) {
    //   return res.status(StatusCodes.BAD_REQUEST).json({
    //     error: `Missing required fields: ${missingFields.join(', ')}`,
    //     availableFields: Object.keys(sampleRow),
    //     requiredFields: requiredFields
    //   });
    // }

    // Skip strict field validation - let Gemini AI handle any CSV structure
    console.log('Available CSV fields:', Object.keys(csvData[0]));
    console.log(`Processing ${csvData.length} rows with flexible Gemini AI analysis...`);

    // Prepare filters for Gemini AI analysis
    const aiFilters = {
      title: titleFilters.join(', '),
      location: locationFilters.join(', '),
      industries: industryFilters
    };

    console.log('Using Gemini AI to analyze CSV data with filters:', aiFilters);

    // Pass raw CSV data directly to Gemini (not title/snippet format)
    let filteredProfiles = [];
    try {
      filteredProfiles = await geminiService.filterProfilesFromCsv(csvData, aiFilters);
      console.log(`Gemini AI filtering completed: ${filteredProfiles.length} profiles matched filters`);
    } catch (geminiError) {
      console.error('Gemini AI analysis failed:', geminiError);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'AI analysis failed',
        details: geminiError.message
      });
    }

    // Transform Gemini results to match other data providers format
    const transformedResults = filteredProfiles.map((profile, index) => {
      // Calculate relevance score based on Gemini's analysis
      let score = 90; // Base score for AI-matched profiles

      // Bonus for having complete data
      if (profile.name && profile.title && profile.company && profile.location) {
        score += 10;
      }

      return {
        // Standard search result format (like Google/Brave results)
        title: `${profile.name || 'Unknown'} - ${profile.title || 'Professional'} - ${profile.company || 'Company'}`,
        link: profile.linkedinUrl || '', // CSV typically doesn't have LinkedIn URLs
        snippet: `${profile.name || 'Unknown'} • ${profile.location || ''} • ${profile.title || ''} at ${profile.company || ''}`,
        pagemap: {
          metatags: [{
            'profile:first_name': profile.name ? profile.name.split(' ')[0] || '' : '',
            'profile:last_name': profile.name ? profile.name.split(' ').slice(1).join(' ') || '' : '',
            'og:description': `${profile.name || 'Unknown'} • ${profile.location || ''} • ${profile.title || ''}`
          }]
        },

        // Extracted fields (standardized across all providers)
        extractedTitle: profile.title || '',
        extractedCompany: profile.company || '',
        extractedLocation: profile.location || '',
        extractedIndustry: profile.industry || '',
        fullName: profile.name || 'Unknown',
        linkedinUrl: profile.linkedinUrl || '', // CSV import typically doesn't have LinkedIn URLs
        email: profile.email || '',
        // Scoring and metadata
        relevanceScore: `3/3`, // CSV data is AI-filtered so gets max score
        originalRelevanceScore: score,
        source: 'csv_import',

        // Source-specific data (like signalHireData, icypeasData)
        csvData: {
          name: profile.name || '',
          title: profile.title || '',
          company: profile.company || '',
          location: profile.location || '',
          industry: profile.industry || '',
          linkedinUrl: profile.linkedinUrl || '',
          email: profile.email || ''
        },

        // Matched filters info
        matchedFilters: {
          title: titleFilters.filter(filter =>
            profile.title && profile.title.toLowerCase().includes(filter.toLowerCase())
          ),
          location: locationFilters.filter(filter =>
            profile.location && profile.location.toLowerCase().includes(filter.toLowerCase())
          ),
          industry: industryFilters.filter(filter =>
            profile.industry && profile.industry.toLowerCase().includes(filter.toLowerCase())
          )
        },

        // Additional metadata
        aiAnalyzed: true,
        geminiMatch: true,
        batchIndex: Math.floor(index / 40) + 1, // Since we use 40 profiles per batch
        profileIndex: index + 1
      };
    });

    // Sort results by relevance score (highest first)
    transformedResults.sort((a, b) => b.originalRelevanceScore - a.originalRelevanceScore);

    // Return the response in the same format as other data providers
    res.status(StatusCodes.OK).json({
      success: true,
      results: transformedResults, // Changed from 'profiles' to 'results' to match other providers
      meta: {
        totalRecordsInCsv: csvData.length,
        totalMatches: filteredProfiles.length,
        totalResults: transformedResults.length,
        filterCriteria: {
          titles: titleFilters,
          locations: locationFilters,
          industries: industryFilters
        },
        dataSource: req.file ? 'file_upload' : 'csv',
        fileName: req.file ? req.file.originalname : undefined,
        fileSize: req.file ? req.file.size : undefined,
        processingNotes: 'CSV data analyzed using Gemini AI for intelligent filtering - supports any CSV structure',
        aiProcessing: 'gemini',
        batchesProcessed: Math.ceil(filteredProfiles.length / 40),
        averageRelevanceScore: transformedResults.length > 0 ?
          (transformedResults.reduce((sum, r) => sum + r.originalRelevanceScore, 0) / transformedResults.length).toFixed(1) : 0
      }
    });

  } catch (error) {
    console.error('Error in importCsv:', error);

    // Handle specific error types
    if (error.name === 'ForbiddenError') {
      return res.status(StatusCodes.FORBIDDEN).json({
        error: error.message
      });
    }

    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to process CSV import',
      details: error.message
    });
  }
};

// Helper functions for file parsing
async function parseCsvBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from(buffer.toString());

    stream
      .pipe(csv())
      .on('data', (data) => {
        const normalizedData = {};
        Object.keys(data).forEach(key => {
          normalizedData[key.toLowerCase()] = data[key].trim();
        });
        results.push(normalizedData);
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

async function parseExcelBuffer(buffer) {
  try {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(worksheet);

    return jsonData.map(row => {
      const normalizedRow = {};
      Object.keys(row).forEach(key => {
        normalizedRow[key.toLowerCase()] = (row[key] || '').toString().trim();
      });
      return normalizedRow;
    });
  } catch (error) {
    throw new Error(`Failed to parse Excel file: ${error.message}`);
  }
}

async function parseCsvString(csvString) {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from(csvString);

    stream
      .pipe(csv())
      .on('data', (data) => {
        const normalizedData = {};
        Object.keys(data).forEach(key => {
          normalizedData[key.toLowerCase()] = data[key].trim();
        });
        results.push(normalizedData);
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

function calculateMatchedCategories(result, filters, uniqueIndustryVariations = [], originalIndustries = []) {
  if (!filters || !Array.isArray(filters) || filters.length === 0) {
    return { matched: 0, total: 0, details: {} };
  }

  const filtersByType = {};
  filters.forEach(filter => {
    if (!filter.field || !filter.value) return;

    if (!filtersByType[filter.field]) {
      filtersByType[filter.field] = [];
    }

    filtersByType[filter.field].push(filter.value);
  });

  const matchedCategoryDetails = {};
  let matchedCategoryCount = 0;

  Object.keys(filtersByType).forEach(fieldType => {
    const values = filtersByType[fieldType];
    let categoryMatched = false;

    for (const value of values) {
      if (!value.trim()) continue;

      const lowercaseValue = value.trim().toLowerCase();

      if (fieldType === 'location') {
        // Match location only against extractedLocation, ignore other sources
        if (result.extractedLocation && typeof result.extractedLocation === 'string') {
          const normalizedExtracted = result.extractedLocation.toLowerCase().normalize();
          const normalizedValue = lowercaseValue.normalize();
          if (normalizedExtracted.includes(normalizedValue)) {
            categoryMatched = true;
          }
        }
      }
      else if (fieldType === 'title') {
        // Use extractedTitle primarily for title matching
        const titleSources = [
          result.extractedTitle,
          getFieldValue(result, 'title'),
          (result.title || '').split(' - ')[1],
          result.snippet,
          result.pagemap?.metatags?.[0]?.['og:description']
        ];

        for (const source of titleSources) {
          if (source && typeof source === 'string') {
            if (source.toLowerCase().includes(lowercaseValue) ||
              checkRelatedTerms(source.toLowerCase(), lowercaseValue)) {
              categoryMatched = true;
              break;
            }
          }
        }
      }
      else if (fieldType === 'industry') {
        // Enhanced industry matching using uniqueIndustryVariations
        if (result.extractedIndustry && typeof result.extractedIndustry === 'string') {
          const normalizedExtracted = result.extractedIndustry.toLowerCase().normalize();
          const normalizedValue = lowercaseValue.normalize();

          // First check direct match
          if (normalizedExtracted.includes(normalizedValue)) {
            categoryMatched = true;
          } else if (uniqueIndustryVariations.length > 0) {
            // Check if extracted industry matches any variation in uniqueIndustryVariations
            const matchedVariations = uniqueIndustryVariations.filter(variation => {
              const lowerVariation = variation.toLowerCase();
              return normalizedExtracted.includes(lowerVariation) ||
                lowerVariation.includes(normalizedExtracted) ||
                normalizedExtracted.split(/[,\s]+/).some(word =>
                  word.trim() && lowerVariation.includes(word.trim())
                );
            });

            // If we found matching variations, check if any correspond to the current search industry
            if (matchedVariations.length > 0) {
              // Check if any matched variation corresponds to the original search industry
              const matchesOriginalIndustry = originalIndustries.some(origIndustry => {
                const lowerOrigIndustry = origIndustry.toLowerCase();
                return lowerOrigIndustry === normalizedValue &&
                  matchedVariations.some(variation =>
                    variation.toLowerCase() === lowerOrigIndustry ||
                    // Also check if the variation is semantically related to the original
                    lowerOrigIndustry.includes(variation.toLowerCase()) ||
                    variation.toLowerCase().includes(lowerOrigIndustry)
                  );
              });

              if (matchesOriginalIndustry) {
                categoryMatched = true;
              }
            }
          }
        }
      }
      else {
        const fieldValue = getFieldValue(result, fieldType);
        if (fieldValue && typeof fieldValue === 'string' &&
          fieldValue.toLowerCase().includes(lowercaseValue)) {
          categoryMatched = true;
          break;
        }

        const otherSources = [
          result.snippet,
          result.pagemap?.metatags?.[0]?.['og:description']
        ];

        for (const source of otherSources) {
          if (source && typeof source === 'string' &&
            source.toLowerCase().includes(lowercaseValue)) {
            categoryMatched = true;
            break;
          }
        }
      }

      if (categoryMatched) break;
    }

    if (categoryMatched) {
      matchedCategoryCount++;
      matchedCategoryDetails[fieldType] = true;
    } else {
      matchedCategoryDetails[fieldType] = false;
    }
  });

  const totalCategories = Object.keys(filtersByType).length;

  return {
    matched: matchedCategoryCount,
    total: totalCategories,
    details: matchedCategoryDetails
  };
}

// Helper function to check for related terms
function checkRelatedTerms(source, value) {
  // Common variations of job titles
  const relatedTerms = {
    'developer': ['develop', 'engineering', 'engineer', 'coder', 'programmer'],
    'engineer': ['engineering', 'developer', 'technical', 'programmer'],
    'manager': ['management', 'director', 'lead', 'head'],
    'analyst': ['analysis', 'analytics', 'analyze'],
    'designer': ['design', 'creative', 'ui', 'ux'],
    'sales': ['selling', 'business development', 'account'],
    'marketing': ['market', 'growth', 'brand'],
    'product': ['production', 'program'],
    'fintech': ['finance', 'financial technology', 'financial services'],
    'saas': ['software as a service', 'cloud', 'software service'],
    'edtech': ['education technology', 'educational', 'learning'],
    'healthtech': ['health', 'healthcare', 'medical'],
    'backend': ['back-end', 'back end', 'server-side'],
    'frontend': ['front-end', 'front end', 'client-side']
  };

  // Check if the value is a key in our related terms dictionary
  for (const [term, variations] of Object.entries(relatedTerms)) {
    if (value.includes(term)) {
      // Check if any of the variations are in the source
      for (const variation of variations) {
        if (source.includes(variation)) {
          return true;
        }
      }
    }

    // Also check the reverse - if the value contains any variation
    // and the source contains the main term
    if (source.includes(term)) {
      for (const variation of variations) {
        if (value.includes(variation)) {
          return true;
        }
      }
    }
  }

  return false;
}

// Helper function to get a field value from a result object (existing function)
function getFieldValue(result, field) {
  // Handle nested fields with dot notation (e.g., "pagemap.metatags.0.profile:first_name")
  if (field.includes('.')) {
    const parts = field.split('.');
    let value = result;

    for (const part of parts) {
      if (value === null || value === undefined) return null;

      // Handle array indices in the path
      if (!isNaN(part)) {
        value = value[parseInt(part)];
      } else {
        value = value[part];
      }
    }

    return value;
  }

  // Direct field access
  return result[field];
}

// Similarly update the getFormattedLinkedInProfiles controller
exports.getFormattedLinkedInProfiles = async (req, res) => {
  const { query, start = 1 } = req.body;

  if (!query) {
    throw new BadRequestError('Please provide a search query');
  }

  // Calculate start parameter for pagination
  const startFrom = (start - 1) * 10 + 1;

  try {
    const results = await googleCseService.searchLinkedInProfiles(query, startFrom);

    // Check if there was an error in the service
    if (results.error) {
      return res.status(results.status || 500).json({
        error: results.message,
        details: results.details
      });
    }

    // Only consume credits after successful search
    await creditService.consumeCredits(req.user.userId, 'SEARCH');

    // Extract and format profile data
    const profileData = results.results.map(result => {
      const metatags = result.pagemap?.metatags?.[0] || {};

      return {
        firstName: metatags['profile:first_name'] || '',
        lastName: metatags['profile:last_name'] || '',
        title: (result.title || '').split(' - ')[1] || '',
        company: ((result.title || '').split(' - ')[2] || '').replace(/ \| LinkedIn$/, '').replace(/ \.{3}$/, ''),
        location: (() => {
          const snippet = result.snippet || '';
          const ogDescription = result.pagemap?.metatags?.[0]?.['og:description'] || '';
          const extract = (text) => {
            return text.includes('Location:') ?
              text
                .split('Location:')[1]
                .split('·')[0]
                .replace(/ \.{3}$/, '')    // remove ' ...'
                .replace(/\.{3}$/, '')     // remove '...'
                .replace(/\u00A0/g, ' ')   // replace non-breaking space with normal space
                .trim() :
              '';
          };
          return extract(snippet) || extract(ogDescription);
        })(),

        linkedinUrl: result.link.replace(/`/g, '').trim(),
        fullName: `${metatags['profile:first_name'] || ''} ${metatags['profile:last_name'] || ''}`.trim(),
        connections: (result.snippet || '').includes('connections') ?
          result.snippet.match(/(\d+)\+\s*connections/)?.[1] || '' : '',
        // Calculate score for sorting based on relevance to query
        score: calculateProfileScore(result, query)
      };
    });

    // Sort profiles by score (highest first)
    profileData.sort((a, b) => b.score - a.score);

    res.status(StatusCodes.OK).json({
      profiles: profileData,
      pagination: results.pagination
    });
  } catch (error) {
    console.error('Error in getFormattedLinkedInProfiles controller:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to process search request',
      details: error.message
    });
  }
};

// Generate search query
exports.generateSearchQueries = async (req, res) => {
  try {
    const { titles = [], locations = [], industries = [], keywords = [] } = req.body;

    // Enforce exactly one location (as per client request)
    const location = locations[0];
    if (!location) {
      return res.status(400).json({ error: "At least one location is required." });
    }

    const queries = [];

    titles.forEach(title => {
      industries.forEach(industry => {
        const baseCombos = [
          `"${location}" AND "${title}" AND "${industry}"`,
          `"${title}" AND "${industry}" AND "${location}"`,
          `"${industry}" AND "${title}" AND "${location}"`
        ];

        baseCombos.forEach(combo => {
          let query = `site:linkedin.com/in ${combo}`;

          // Add any extra keywords
          if (keywords.length > 0) {
            query += ' ' + keywords.map(k => `"${k}"`).join(' ');
          }

          queries.push(query);
        });
      });
    });

    return res.json({ queries });
  } catch (error) {
    console.error("Error generating search queries:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// Bulk search for LinkedIn profiles (300-400 results)
exports.bulkSearchLinkedInProfiles = async (req, res) => {
  const { query, maxResults = 300 } = req.body;

  if (!query) {
    throw new BadRequestError('Please provide a search query');
  }

  // Calculate how many API calls we need (each call gets 10 results)
  // Google CSE has a limit of 100 results (10 pages), so we need to modify the query slightly
  // for each batch to get different results
  const batchSize = 100; // Maximum results per query variant
  const requiredBatches = Math.ceil(maxResults / batchSize);

  // Create query variations to get more diverse results
  const queryVariations = generateQueryVariations(query, requiredBatches);

  let allProfiles = [];
  let totalProcessed = 0;

  // Process each query variation
  for (let i = 0; i < queryVariations.length && allProfiles.length < maxResults; i++) {
    const currentQuery = queryVariations[i];

    // Fetch all pages for this query variation (up to 10 pages per query)
    const maxPages = 10; // Google CSE limit

    for (let page = 1; page <= maxPages && allProfiles.length < maxResults; page++) {
      const start = (page - 1) * 10 + 1;

      try {
        // Get results for this page
        const results = await googleCseService.searchLinkedInProfiles(currentQuery, start);

        if (!results.results || results.results.length === 0) {
          break; // No more results for this query variation
        }

        // Extract profile data
        const profileData = results.results.map(result => {
          const metatags = result.pagemap?.metatags?.[0] || {};

          return {
            firstName: metatags['profile:first_name'] || '',
            lastName: metatags['profile:last_name'] || '',
            title: (result.title || '').split(' - ')[1] || '',
            company: ((result.title || '').split(' - ')[2] || '')
              .split(/:|\|/)[0] // split at colon or pipe, take first part
              .replace(/ \.{3}$/, '') // remove trailing ' ...'
              .trim(),
            location: (result.snippet || '').includes('Location:') ?
              result.snippet.split('Location:')[1]
                .split(/\.{3}|·|"|"/)[0] // stop at ..., ·, or " or "
                .trim()
                .replace(/[\u00A0 ]$/, '') : '',
            linkedinUrl: result.link.replace(/`/g, '').trim(),
            fullName: `${metatags['profile:first_name'] || ''} ${metatags['profile:last_name'] || ''}`.trim(),
            connections: (result.snippet || '').includes('connections') ?
              result.snippet.match(/(\d+)\+\s*connections/)?.[1] || '' : '',
            score: calculateProfileScore(result, query) - (i * 10), // Penalize results from later query variations
            queryVariation: i + 1
          };
        });

        // Add to our collection, avoiding duplicates by LinkedIn URL
        profileData.forEach(profile => {
          if (!allProfiles.some(p => p.linkedinUrl === profile.linkedinUrl)) {
            allProfiles.push(profile);
          }
        });

        totalProcessed += results.results.length;

        // If this page had fewer than 10 results, we've reached the end for this query
        if (results.results.length < 10) {
          break;
        }
      } catch (error) {
        console.error(`Error fetching batch ${i + 1}, page ${page}:`, error);
        // Continue with next page/batch instead of failing completely
        break;
      }
    }
  }

  const minimumScoreThreshold = 70;
  allProfiles = allProfiles.filter(profile => profile.score >= minimumScoreThreshold);

  // Only consume credits after successful searches
  if (allProfiles.length > 0) {
    await creditService.consumeCredits(req.user.userId, 'SEARCH', requiredBatches);
  }

  // Sort profiles by score (highest first)
  allProfiles.sort((a, b) => b.score - a.score);

  // Limit to requested max
  if (allProfiles.length > maxResults) {
    allProfiles = allProfiles.slice(0, maxResults);
  }

  res.status(StatusCodes.OK).json({
    profiles: allProfiles,
    meta: {
      totalProfiles: allProfiles.length,
      totalProcessed,
      requestedMax: maxResults,
      batchesUsed: requiredBatches
    }
  });
};

// Helper function to generate query variations
function generateQueryVariations(baseQuery, count) {
  // Ensure the base query has the LinkedIn site restriction
  let query = baseQuery;
  if (!query.includes('site:linkedin.com/in/')) {
    query = `site:linkedin.com/in/ ${query}`;
  }

  const variations = [query]; // Start with the original query

  // Common LinkedIn profile keywords to add for variation
  const keywords = [
    'experience', 'skills', 'education', 'about', 'professional',
    'background', 'summary', 'expertise', 'certified', 'specialist',
    'senior', 'junior', 'lead', 'manager', 'director', 'head of',
    'consultant', 'freelance', 'contractor', 'full-time', 'part-time'
  ];

  // Generate additional variations by adding keywords
  for (let i = 1; i < count && i < keywords.length; i++) {
    variations.push(`${query} ${keywords[i]}`);
  }

  // If we need more variations than keywords, start combining keywords
  if (count > keywords.length + 1) {
    for (let i = 0; i < keywords.length && variations.length < count; i++) {
      for (let j = i + 1; j < keywords.length && variations.length < count; j++) {
        variations.push(`${query} ${keywords[i]} ${keywords[j]}`);
      }
    }
  }

  return variations.slice(0, count);
}

// Helper function to calculate profile score based on relevance to query
function calculateProfileScore(result, query) {
  let score = 50; // Base score

  // Parse the query to extract key terms
  const queryTerms = query.replace('site:linkedin.com/in/', '')
    .replace(/"/g, '')
    .split(' ')
    .filter(term => term.length > 2);

  // Check title match
  if (result.title) {
    queryTerms.forEach(term => {
      // Exact word boundary match gets higher score
      const regex = new RegExp(`\\b${term.toLowerCase()}\\b`, 'i');
      if (regex.test(result.title.toLowerCase())) {
        score += 30; // Higher score for exact matches
      } else if (result.title.toLowerCase().includes(term.toLowerCase())) {
        score += 15; // Lower score for partial matches
      }
    });
  }

  // Check snippet match
  if (result.snippet) {
    queryTerms.forEach(term => {
      const regex = new RegExp(`\\b${term.toLowerCase()}\\b`, 'i');
      if (regex.test(result.snippet.toLowerCase())) {
        score += 20; // Higher score for exact matches
      } else if (result.snippet.toLowerCase().includes(term.toLowerCase())) {
        score += 10; // Lower score for partial matches
      }
    });
  }

  // Check for profile completeness indicators
  if (result.snippet && result.snippet.includes('connections')) {
    score += 10;

    // More connections = higher score
    const connectionMatch = result.snippet.match(/(\d+)\+\s*connections/);
    if (connectionMatch && connectionMatch[1]) {
      const connections = parseInt(connectionMatch[1]);
      if (connections >= 500) score += 25;
      else if (connections >= 300) score += 15;
      else if (connections >= 100) score += 5;
    }
  }

  // Check for rich metadata
  if (result.pagemap && result.pagemap.metatags &&
    result.pagemap.metatags[0] &&
    result.pagemap.metatags[0]['profile:first_name']) {
    score += 20; // Profile has good metadata
  }

  return score;
}


// Add this new controller function
exports.searchSignalHireProfiles = async (req, res) => {
  try {
    const { title, location, keywords, industry, company, experience, limit = 50, useScrollSearch = true } = req.body;

    if (!title && !location) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide at least one search criteria (title, location, or keywords)'
      });
    }

    // Convert industry to the most relevant predefined industry if provided
    let convertedIndustry = industry;
    if (industry && typeof industry === 'string') {
      convertedIndustry = await openaiService.convertToRelevantIndustry(industry);
      console.log(`Industry conversion: ${industry} → ${convertedIndustry}`);
    }

    const searchCriteria = {
      title,
      location,
      keywords,
      industry: convertedIndustry,
      company,
      experience,
      size: Math.min(limit, 100)
    };

    // Call SignalHire initial search
    const searchResult = await signalHireService.searchProfilesByCriteria(searchCriteria);

    if (!searchResult.success) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'SignalHire search failed',
        details: searchResult.message
      });
    }

    // Only consume credits after successful search
    await creditService.consumeCredits(req.user.userId, 'SEARCH', 3);

    if (!useScrollSearch) {
      // Return just the first page results
      return res.status(StatusCodes.OK).json(searchResult);
    }

    // Use scroll search to get additional pages
    let allProfiles = [];
    if (searchResult.success && searchResult.results && searchResult.results.profiles) {
      allProfiles = [...searchResult.results.profiles];

      // Get additional pages using scroll search if scrollId is available
      if (searchResult.results.scrollId && searchResult.results.requestId) {
        let currentScrollId = searchResult.results.scrollId;
        const requestId = searchResult.results.requestId;
        let page = 1;

        // Continue until no more pages or we reach limit
        while (currentScrollId && allProfiles.length < limit) {
          try {
            console.log(`Fetching SignalHire page ${page + 1} with scrollId:`, currentScrollId);

            const scrollResponse = await signalHireService.scrollSearch(requestId, currentScrollId);

            if (scrollResponse.success && scrollResponse.results && scrollResponse.results.profiles && scrollResponse.results.profiles.length > 0) {
              allProfiles = allProfiles.concat(scrollResponse.results.profiles);
              console.log(`Added ${scrollResponse.results.profiles.length} profiles from page ${page + 1}. Total: ${allProfiles.length}`);

              // Update scrollId for next page
              if (scrollResponse.results.scrollId) {
                currentScrollId = scrollResponse.results.scrollId;
              } else {
                // No more pages available
                console.log('No more scrollId available, reached last page');
                break;
              }
            } else {
              // No more results or error
              console.log('No more profiles available or empty response');
              break;
            }

            page++;
          } catch (scrollError) {
            console.error(`SignalHire scroll search page ${page + 1} failed:`, scrollError);
            break; // Stop pagination on error
          }
        }
      }
    }

    // Return combined results with pagination info
    return res.status(StatusCodes.OK).json({
      success: true,
      results: {
        ...searchResult.results,
        profiles: allProfiles.slice(0, limit),
        totalPages: Math.ceil(allProfiles.length / (searchResult.results.profiles?.length || 1)),
        totalProfiles: allProfiles.length
      },
      meta: {
        usedScrollSearch: useScrollSearch,
        originalProfileCount: searchResult.results.profiles?.length || 0,
        finalProfileCount: allProfiles.length
      }
    });

  } catch (error) {
    console.error('Error in searchSignalHireProfiles:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'SignalHire search processing failed',
      details: error.message
    });
  }
};




// Test Brave LinkedIn profiles search
exports.searchBraveLinkedInProfiles = async (req, res) => {
  const { filters = [], skipOpenAI = false } = req.body;

  if (!Array.isArray(filters) || filters.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide an array of filters'
    });
  }

  const getFilterValues = (field) => filters
    .filter(f => f.field === field)
    .map(f => f.value);

  // Extract filter values by category
  const roles = getFilterValues('title');
  const industries = getFilterValues('industry');
  const locations = getFilterValues('location');

  // Get all other filter types (skills, etc.)
  const otherFilters = filters.filter(f =>
    !['title', 'industry', 'location'].includes(f.field)
  );

  // Ensure we have all three required filters
  if (locations.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide at least one location filter for Brave search'
    });
  }

  if (roles.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide at least one title filter for Brave search'
    });
  }

  if (industries.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Please provide at least one industry filter for Brave search'
    });
  }

  // Generate ONLY role + location + industry combinations
  const queries = [];

  for (const role of roles) {
    if (!role) continue;

    for (const location of locations) {
      if (!location) continue;

      for (const industry of industries) {
        if (!industry) continue;

        // Use space-separated terms without quotes for broader matching
        queries.push(`${role} ${location} ${industry}`);
      }
    }
  }

  // Limit the number of queries to control API usage
  const maxQueries = 10;
  const limitedQueries = queries.slice(0, maxQueries);

  console.log(`Generated ${queries.length} potential queries, using first ${limitedQueries.length} for Brave search`);

  try {
    const maxPagesPerQuery = 10;
    const resultsPerPage = 20;
    const maxResultsPerQuery = maxPagesPerQuery * resultsPerPage;

    // Base charge: 3 credits for Brave search
    let totalCredits = 3;
    await creditService.consumeCredits(req.user.userId, 'SEARCH', totalCredits);

    console.log(`Starting Brave search with ${limitedQueries.length} queries, up to ${maxPagesPerQuery} pages per query...`);

    // FIXED: Sequential processing with proper delay and continuation logic
    const allResults = [];
    const queryStats = {};

    for (const query of limitedQueries) {
      console.log(`Processing query: ${query}`);
      queryStats[query] = { pages: 0, results: 0, stopped: false };

      // Search pages sequentially for each query
      for (let page = 1; page <= maxPagesPerQuery; page++) {
        try {
          // Add delay between requests to avoid rate limiting
          if (page > 1) {
            await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
          }

          const result = await googleCseService.searchBraveLinkedInProfiles(query, page);

          if (result.error) {
            console.log(`✗ Brave search failed for "${query}" page ${page}:`, result.message);
            if (result.status === 429) {
              console.log(`  → Rate limited, waiting 2 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue; // Retry this page
            }
            if (result.status >= 400 && result.status < 500) {
              console.log(`  → Client error, stopping pagination for this query`);
              queryStats[query].stopped = true;
              break;
            }
            continue; // Skip this page but continue with next
          }

          const results = result.results || [];
          const resultCount = results.length;

          console.log(`✓ Brave found ${resultCount} results for "${query}" page ${page}`);

          queryStats[query].pages++;
          queryStats[query].results += resultCount;

          // Add results with metadata
          const enrichedResults = results.map(item => ({
            ...item,
            relevanceScore: 100,
            query,
            page,
            source: 'brave'
          }));

          allResults.push(...enrichedResults);

          // IMPROVED: Continue pagination logic
          // Only stop if we get significantly fewer results than expected
          // AND we're past page 3 (to ensure we get good coverage)
          if (resultCount < 10 && page >= 3) {
            console.log(`  → Low result count (${resultCount}) on page ${page}, stopping pagination for "${query}"`);
            queryStats[query].stopped = true;
            break;
          }

          // If we got 0 results and we're past page 1, stop
          if (resultCount === 0 && page > 1) {
            console.log(`  → No results on page ${page}, stopping pagination for "${query}"`);
            queryStats[query].stopped = true;
            break;
          }

        } catch (err) {
          console.error(`Error searching "${query}" page ${page}:`, err.message);
          // Continue to next page
        }
      }
    }

    // Log statistics
    console.log('\n=== Query Statistics ===');
    Object.entries(queryStats).forEach(([query, stats]) => {
      console.log(`"${query}": ${stats.results} results from ${stats.pages} pages ${stats.stopped ? '(stopped early)' : '(completed)'}`);
    });

    console.log(`\nBrave search completed. Found ${allResults.length} total results.`);

    // Remove duplicates by LinkedIn URL
    const seen = new Set();
    const uniqueResults = allResults.filter(result => {
      const uniqueId = result.link;
      if (seen.has(uniqueId)) return false;
      seen.add(uniqueId);
      return true;
    });

    console.log(`After deduplication: ${uniqueResults.length} unique results`);

    // If skipOpenAI is true, return raw results without processing
    if (skipOpenAI) {
      console.log('Skipping OpenAI processing, returning raw results...');
      return res.status(StatusCodes.OK).json({
        results: uniqueResults,
        meta: {
          searchEngine: 'brave',
          skipOpenAI: true,
          totalResults: uniqueResults.length,
          totalFetched: allResults.length,
          uniqueResults: uniqueResults.length,
          queriesUsed: limitedQueries.length,
          maxPagesPerQuery: maxPagesPerQuery,
          resultsPerPage: resultsPerPage,
          queryStats: queryStats,
          filters: filters,
          message: 'Raw results without OpenAI processing - role+location+industry only',
          searchStrategy: 'Sequential pagination with proper delays and continuation logic'
        }
      });
    }

    // Process results with OpenAI extraction
    let processedResults = [];
    if (uniqueResults.length > 0) {
      // Create CSV file before OpenAI processing for Brave results
      createOpenAIAnalysisCSV(uniqueResults, 'brave', 'test');

      const batchSize = 50;
      const concurrencyLimit = 10;

      const batches = [];
      for (let i = 0; i < uniqueResults.length; i += batchSize) {
        batches.push(uniqueResults.slice(i, i + batchSize));
      }

      // Parallelize with concurrency control
      const limit = pLimit(concurrencyLimit);

      const batchPromises = batches.map(batch =>
        limit(async () => {
          const extractedBatch = await openaiService.extractProfilesDataBatch(batch, industries);
          return batch.map((result, i) => {
            const extracted = extractedBatch[i] || {};

            return {
              ...result,
              extractedTitle: extracted.title || '',
              extractedCompany: extracted.company || '',
              extractedLocation: extracted.location || (() => {
                const ogDesc = result.pagemap?.metatags?.[0]?.['og:description'] || '';
                const snippet = result.snippet || '';

                // Try og:description first
                let locationMatch = ogDesc.match(/(?:Location|Plats)\s*[:：]?\s*([^·\n]+)/i);
                if (locationMatch && locationMatch[1]) {
                  return locationMatch[1].trim();
                }

                // Fallback to snippet
                locationMatch = snippet.match(/(?:Location|Plats)\s*[:：]?\s*([^·\n]+)/i);
                if (locationMatch && locationMatch[1]) {
                  return locationMatch[1].trim();
                }

                return '';
              })(),
              extractedIndustry: extracted.industry || '',
              fullName: `${result.pagemap?.metatags?.[0]?.['profile:first_name'] || ''} ${result.pagemap?.metatags?.[0]?.['profile:last_name'] || ''}`.trim(),
              linkedinUrl: result.link.replace(/`/g, '').trim()
            };
          });
        })
      );

      const enrichedResultsBatches = await Promise.all(batchPromises);
      processedResults = enrichedResultsBatches.flat();
    }

    // Add heuristic industry assignment based on filters and profile content
    const industryFilters = new Set(industries.map(i => i.toLowerCase()));

    const enrichedResults = processedResults.map(result => {
      let extractedIndustry = result.industry || result.extractedIndustry || '';

      if (Array.isArray(extractedIndustry)) {
        extractedIndustry = extractedIndustry.join(', ');
      }

      // ENHANCED INDUSTRY MATCHING LOGIC
      // First, check if any of the original search industries match the extracted industry
      const originalSearchIndustries = industries; // e.g., ["Enterprise Software"]
      let finalIndustry = extractedIndustry;

      if (extractedIndustry) {
        const lowercaseExtracted = extractedIndustry.toLowerCase();

        // Check if extracted industry contains any of the original search industries
        const matchedSearchIndustry = originalSearchIndustries.find(searchIndustry => {
          const lowercaseSearch = searchIndustry.toLowerCase();

          // Exact match
          if (lowercaseExtracted === lowercaseSearch) {
            return true;
          }

          // Check if extracted contains the search industry
          if (lowercaseExtracted.includes(lowercaseSearch)) {
            return true;
          }

          // Check if search industry contains extracted (for cases like "software" matching "Enterprise Software")
          if (lowercaseSearch.includes(lowercaseExtracted)) {
            return true;
          }

          // Check for key terms - if search is "Enterprise Software" and extracted contains "software"
          const searchWords = lowercaseSearch.split(' ');
          const extractedWords = lowercaseExtracted.split(/[,\s]+/);

          const hasSignificantOverlap = searchWords.some(searchWord =>
            searchWord.length > 3 && extractedWords.some(extractedWord =>
              extractedWord.includes(searchWord) || searchWord.includes(extractedWord)
            )
          );

          return hasSignificantOverlap;
        });

        if (matchedSearchIndustry) {
          finalIndustry = matchedSearchIndustry;
        }
      }

      // If no direct match found, proceed with existing heuristic logic
      if (!finalIndustry || finalIndustry === extractedIndustry) {
        // Check if any industry filter matches snippet, title, or description
        const industrySources = [
          result.snippet || '',
          result.extractedTitle || '',
          result.pagemap?.metatags?.[0]?.['og:description'] || ''
        ].map(s => s.toLowerCase());

        industryFilters.forEach(industryFilter => {
          if (industryFilter && !finalIndustry.toLowerCase().includes(industryFilter)) {
            for (const source of industrySources) {
              if (source.includes(industryFilter)) {
                // Find the original search industry that matches this filter
                const matchingOriginalIndustry = originalSearchIndustries.find(orig =>
                  orig.toLowerCase().includes(industryFilter) ||
                  industryFilter.includes(orig.toLowerCase())
                );

                if (matchingOriginalIndustry) {
                  finalIndustry = matchingOriginalIndustry;
                } else {
                  finalIndustry = finalIndustry ? finalIndustry + ', ' + industryFilter : industryFilter;
                }
                break;
              }
            }
          }
        });
      }

      return {
        ...result,
        extractedIndustry: finalIndustry
      };
    });

    // Calculate relevance scores
    const resultsWithFractionalScores = enrichedResults.map(result => {
      const matchedCategories = calculateMatchedCategories(result, filters);
      const additionalFilterTypes = new Set(otherFilters.map(f => f.field));
      const totalCategories = 3 + additionalFilterTypes.size;

      const matchedCategoriesWithValues = {
        matched: 0,
        total: totalCategories,
        details: {}
      };

      // Calculate matched categories
      Object.keys(matchedCategories.details).forEach(fieldType => {
        const filterValues = filters
          .filter(f => f.field === fieldType)
          .map(f => f.value);

        const matchedValues = [];

        for (const value of filterValues) {
          if (!value.trim()) continue;

          const lowercaseValue = value.toLowerCase();
          let valueMatched = false;

          if (fieldType === 'location') {
            const locationSource = result.extractedLocation;
            if (locationSource && typeof locationSource === 'string') {
              const normalizedSource = locationSource.toLowerCase().normalize();
              const normalizedValue = lowercaseValue.normalize();
              if (normalizedSource === normalizedValue || new RegExp(`\\b${normalizedValue}\\b`).test(normalizedSource)) {
                valueMatched = true;
              }
            }
          }
          else if (fieldType === 'title') {
            const titleSources = [
              result.extractedTitle,
              getFieldValue(result, 'title'),
              (result.title || '').split(' - ')[1],
              result.snippet,
              result.pagemap?.metatags?.[0]?.['og:description']
            ];

            for (const source of titleSources) {
              if (source && typeof source === 'string') {
                if (source.toLowerCase().includes(lowercaseValue) ||
                  checkRelatedTerms(source.toLowerCase(), lowercaseValue)) {
                  valueMatched = true;
                  break;
                }
              }
            }
          }
          else if (fieldType === 'industry') {
            if (result.extractedIndustry && typeof result.extractedIndustry === 'string') {
              const normalizedExtracted = result.extractedIndustry.toLowerCase().normalize();
              const normalizedValue = lowercaseValue.normalize();
              if (normalizedExtracted.includes(normalizedValue)) {
                valueMatched = true;
              }
            }
          }

          if (valueMatched) {
            matchedValues.push(value);
          }
        }

        matchedCategoriesWithValues.details[fieldType] = matchedValues;

        if (matchedValues.length > 0) {
          matchedCategoriesWithValues.matched++;
        }
      });

      return {
        ...result,
        originalRelevanceScore: result.relevanceScore,
        relevanceScore: `${matchedCategoriesWithValues.matched}/${matchedCategoriesWithValues.total}`,
        matchedCategories: matchedCategoriesWithValues.details,
        matchedCategoriesValue: matchedCategoriesWithValues,
        sourceBoost: 0
      };
    });

    // Sort by fractional relevance score
    resultsWithFractionalScores.sort((a, b) => {
      const [aNum, aTotal] = a.relevanceScore.split('/').map(Number);
      const [bNum, bTotal] = b.relevanceScore.split('/').map(Number);

      const aFraction = aNum / aTotal;
      const bFraction = bNum / bTotal;

      if (bFraction !== aFraction) {
        return bFraction - aFraction;
      }

      return b.originalRelevanceScore - a.originalRelevanceScore;
    });

    // Filter results to only include those with 3/3 relevanceScore
    const filteredResults = resultsWithFractionalScores.filter(result =>
      result.relevanceScore === "3/3"
    );

    // Filter out results with empty links
    const finalResults = filteredResults.filter(result =>
      result.link && result.link.trim() !== ""
    );

    console.log(`Final filtering: ${filteredResults.length}/${resultsWithFractionalScores.length} results with 3/3 relevance score`);
    console.log(`Final results: ${finalResults.length}/${filteredResults.length} results after removing empty LinkedIn URLs`);

    res.status(StatusCodes.OK).json({
      results: finalResults,
      meta: {
        searchEngine: 'brave',
        totalResults: finalResults.length,
        totalResultsBeforeFilter: resultsWithFractionalScores.length,
        resultsAfterRelevanceFilter: filteredResults.length,
        totalFetched: allResults.length,
        uniqueResults: uniqueResults.length,
        queriesUsed: limitedQueries.length,
        maxPagesPerQuery: maxPagesPerQuery,
        resultsPerPage: resultsPerPage,
        queryStats: queryStats,
        filters: filters,
        searchStrategy: 'Sequential pagination with delays and improved continuation logic'
      }
    });

  } catch (error) {
    console.error('Error in Brave search:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Brave search processing failed',
      details: error.message
    });
  }
};

// Helper function to create simple CSV file with only titles and snippets
const createSimpleOpenAIAnalysisCSV = (profiles, searchType = 'main') => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFileName = `openai-analysis-combined-${searchType}-${timestamp}.csv`;
    const csvFilePath = path.join(__dirname, '..', 'data', 'analysis', csvFileName);

    // Ensure the directory exists
    const dir = path.dirname(csvFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const csvData = profiles.map((profile, index) => ({
      title: profile.title || '',
      snippet: profile.snippet || ''
    }));

    // Convert to CSV format
    const csvHeaders = 'title,snippet\n';
    const csvRows = csvData.map(row =>
      `"${(row.title || '').replace(/"/g, '""')}","${(row.snippet || '').replace(/"/g, '""')}"`
    ).join('\n');

    const csvContent = csvHeaders + csvRows;
    fs.writeFileSync(csvFilePath, csvContent, 'utf8');

    console.log(`Created combined OpenAI analysis CSV file: ${csvFilePath}`);
    console.log(`Saved ${csvData.length} profiles to CSV for ${searchType} analysis`);

    return csvFilePath;
  } catch (error) {
    console.error('Error creating simple OpenAI analysis CSV:', error);
    return null;
  }
};

// Helper function to create CSV file with titles and snippets
const createOpenAIAnalysisCSV = (profiles, source, searchType = 'main') => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFileName = `openai-analysis-${source}-${searchType}-${timestamp}.csv`;
    const csvFilePath = path.join(__dirname, '..', 'data', 'analysis', csvFileName);

    // Ensure the directory exists
    const dir = path.dirname(csvFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const csvData = profiles.map((profile, index) => ({
      profileIndex: index + 1,
      source: source,
      searchType: searchType,
      title: profile.title || '',
      snippet: profile.snippet || '',
      query: profile.query || '',
      page: profile.page || '',
      link: profile.link || '',
      timestamp: new Date().toISOString()
    }));

    // Convert to CSV format
    const csvHeaders = 'Profile Index,Source,Search Type,Title,Snippet,Query,Page,Link,Timestamp\n';
    const csvRows = csvData.map(row =>
      `${row.profileIndex},"${(row.source || '').replace(/"/g, '""')}","${(row.searchType || '').replace(/"/g, '""')}","${(row.title || '').replace(/"/g, '""')}","${(row.snippet || '').replace(/"/g, '""')}","${(row.query || '').replace(/"/g, '""')}","${row.page || ''}","${(row.link || '').replace(/"/g, '""')}","${row.timestamp}"`
    ).join('\n');

    const csvContent = csvHeaders + csvRows;
    fs.writeFileSync(csvFilePath, csvContent, 'utf8');

    console.log(`Created OpenAI analysis CSV file: ${csvFilePath}`);
    console.log(`Saved ${csvData.length} profiles to CSV for ${source} ${searchType} analysis`);

    return csvFilePath;
  } catch (error) {
    console.error('Error creating OpenAI analysis CSV:', error);
    return null;
  }
};

// Extract LinkedIn profiles from CSV using OpenAI
exports.extractProfilesFromCsv = async (req, res) => {
  try {
    let csvData = [];

    // Check if a file was uploaded
    if (!req.file) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please upload a CSV file'
      });
    }

    console.log('Processing uploaded CSV file:', req.file.originalname);

    try {
      const fileExtension = path.extname(req.file.originalname).toLowerCase();

      if (fileExtension === '.csv') {
        // Parse CSV file
        csvData = await parseCsvBuffer(req.file.buffer);
      } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
        // Parse Excel file
        csvData = await parseExcelBuffer(req.file.buffer);
      } else {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Unsupported file format. Please upload CSV or XLSX files.'
        });
      }
    } catch (parseError) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Failed to parse uploaded file',
        details: parseError.message
      });
    }

    if (csvData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'No data found in the provided CSV/XLSX file'
      });
    }

    // Validate that CSV has title and snippet columns
    const sampleRow = csvData[0];
    const availableFields = Object.keys(sampleRow).map(key => key.toLowerCase());

    const hasTitle = availableFields.some(field =>
      field.includes('title') || field === 'title'
    );
    const hasSnippet = availableFields.some(field =>
      field.includes('snippet') || field === 'snippet'
    );

    if (!hasTitle || !hasSnippet) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'CSV must contain both "title" and "snippet" columns',
        availableFields: Object.keys(sampleRow),
        requiredFields: ['title', 'snippet']
      });
    }

    // Normalize field names to get title and snippet
    const normalizedData = csvData.map(row => {
      const normalized = {};

      Object.keys(row).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('title') || lowerKey === 'title') {
          normalized.title = row[key] || '';
        } else if (lowerKey.includes('snippet') || lowerKey === 'snippet') {
          normalized.snippet = row[key] || '';
        }
      });

      return normalized;
    });

    // Filter out rows without title or snippet
    const validData = normalizedData.filter(row =>
      row.title && row.title.trim() !== '' &&
      row.snippet && row.snippet.trim() !== ''
    );

    if (validData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'No valid rows found with both title and snippet data'
      });
    }

    console.log(`Processing ${validData.length} valid rows from CSV`);

    // Get industries from request or use default empty array
    let industries = [];
    if (req.body.industries) {
      if (Array.isArray(req.body.industries)) {
        industries = req.body.industries;
      } else if (typeof req.body.industries === 'string') {
        try {
          // Try to parse as JSON if it's a string that looks like JSON
          if (req.body.industries.trim().startsWith('[')) {
            industries = JSON.parse(req.body.industries);
          } else {
            // Single industry as string
            industries = [req.body.industries];
          }
        } catch (parseError) {
          console.log('Industries parsing error, using as single string:', parseError.message);
          industries = [req.body.industries];
        }
      }
    }

    console.log('Parsed industries:', industries);

    // Process with OpenAI using the exact prompt provided
    try {
      const extractedProfiles = await openaiService.extractProfilesFromCsvData(validData, industries);

      // Create a CSV file with the original data for reference
      createSimpleOpenAIAnalysisCSV(validData, 'csv-extract');

      res.status(StatusCodes.OK).json({
        success: true,
        profiles: extractedProfiles,
        meta: {
          totalRowsInFile: csvData.length,
          validRowsProcessed: validData.length,
          industriesProvided: industries,
          fileName: req.file.originalname,
          fileSize: req.file.size,
          extractedCount: extractedProfiles.length
        }
      });

    } catch (openaiError) {
      console.error('OpenAI processing error:', openaiError);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to process profiles with OpenAI',
        details: openaiError.message
      });
    }

  } catch (error) {
    console.error('Error in extractProfilesFromCsv:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to process CSV file',
      details: error.message
    });
  }
};

// Filter profiles from CSV using Claude API
exports.filterProfilesFromCsv = async (req, res) => {
  try {
    // Check if file is uploaded
    if (!req.file) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'Please upload a CSV or XLSX file'
      });
    }

    const { title, location, industries } = req.body;

    // Parse industries if provided
    let industriesArray = [];
    if (industries) {
      try {
        if (typeof industries === 'string') {
          // Handle different string formats
          if (industries.startsWith('[') && industries.endsWith(']')) {
            industriesArray = JSON.parse(industries);
          } else {
            industriesArray = industries.split(',').map(i => i.trim());
          }
        } else if (Array.isArray(industries)) {
          industriesArray = industries;
        }
      } catch (error) {
        console.error('Error parsing industries:', error);
        industriesArray = [];
      }
    }

    const filters = {
      title: title || '',
      location: location || '',
      industries: industriesArray
    };

    console.log('Filters received:', filters);

    // Parse CSV/XLSX file
    let csvData = [];
    const fileExtension = path.extname(req.file.originalname).toLowerCase();

    if (fileExtension === '.csv') {
      // Parse CSV file
      const csvContent = req.file.buffer.toString('utf8');
      const stream = Readable.from(csvContent);

      await new Promise((resolve, reject) => {
        stream
          .pipe(csv())
          .on('data', (row) => {
            csvData.push(row);
          })
          .on('end', () => {
            resolve();
          })
          .on('error', (error) => {
            reject(error);
          });
      });
    } else if (fileExtension === '.xlsx') {
      // Parse XLSX file
      const workbook = xlsx.read(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      csvData = xlsx.utils.sheet_to_json(worksheet);
    } else {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'Please upload a CSV or XLSX file'
      });
    }

    console.log(`Parsed ${csvData.length} rows from uploaded file`);

    // Validate CSV has required columns
    if (csvData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'The uploaded file is empty or has no data rows'
      });
    }

    // Check for required columns (title and snippet)
    const firstRow = csvData[0];
    const hasTitle = 'title' in firstRow;
    const hasSnippet = 'snippet' in firstRow;

    if (!hasTitle || !hasSnippet) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'CSV file must contain "title" and "snippet" columns'
      });
    }

    // Clean and validate data
    const validProfiles = csvData.filter(row => {
      return row.title && row.title.trim() !== '' &&
        row.snippet && row.snippet.trim() !== '';
    });

    if (validProfiles.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'No valid profiles found in the CSV file'
      });
    }

    console.log(`Found ${validProfiles.length} valid profiles for filtering`);

    // Use Claude API to filter profiles
    const filteredProfiles = await claudeService.filterProfilesFromCsv(validProfiles, filters);

    console.log(`Claude filtering completed: ${filteredProfiles.length} profiles matched filters`);

    // Return the filtered profiles
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        totalProfiles: csvData.length,
        validProfiles: validProfiles.length,
        filteredProfiles: filteredProfiles.length,
        profiles: filteredProfiles,
        filters: filters
      }
    });

  } catch (error) {
    console.error('Error filtering profiles from CSV:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: 'Failed to filter profiles from CSV',
      details: error.message
    });
  }
};

// Filter profiles from CSV using OpenAI API
exports.filterProfilesFromCsvOpenAI = async (req, res) => {
  try {
    // Check if file is uploaded
    if (!req.file) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'Please upload a CSV or XLSX file'
      });
    }

    const { title, location, industries } = req.body;

    // Parse industries if provided
    let industriesArray = [];
    if (industries) {
      try {
        if (typeof industries === 'string') {
          // Handle different string formats
          if (industries.startsWith('[') && industries.endsWith(']')) {
            industriesArray = JSON.parse(industries);
          } else {
            industriesArray = industries.split(',').map(i => i.trim());
          }
        } else if (Array.isArray(industries)) {
          industriesArray = industries;
        }
      } catch (error) {
        console.error('Error parsing industries:', error);
        industriesArray = [];
      }
    }

    const filters = {
      title: title || '',
      location: location || '',
      industries: industriesArray
    };

    console.log('Filters received:', filters);

    // Parse CSV/XLSX file
    let csvData = [];
    const fileExtension = path.extname(req.file.originalname).toLowerCase();

    if (fileExtension === '.csv') {
      // Parse CSV file
      const csvContent = req.file.buffer.toString('utf8');
      const stream = Readable.from(csvContent);

      await new Promise((resolve, reject) => {
        stream
          .pipe(csv())
          .on('data', (row) => {
            csvData.push(row);
          })
          .on('end', () => {
            resolve();
          })
          .on('error', (error) => {
            reject(error);
          });
      });
    } else if (fileExtension === '.xlsx') {
      // Parse XLSX file
      const workbook = xlsx.read(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      csvData = xlsx.utils.sheet_to_json(worksheet);
    } else {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'Please upload a CSV or XLSX file'
      });
    }

    console.log(`Parsed ${csvData.length} rows from uploaded file`);

    // Validate CSV has required columns
    if (csvData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'The uploaded file is empty or has no data rows'
      });
    }

    // Check for required columns (title and snippet)
    const firstRow = csvData[0];
    const hasTitle = 'title' in firstRow;
    const hasSnippet = 'snippet' in firstRow;

    if (!hasTitle || !hasSnippet) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'CSV file must contain "title" and "snippet" columns'
      });
    }

    // Clean and validate data
    const validProfiles = csvData.filter(row => {
      return row.title && row.title.trim() !== '' &&
        row.snippet && row.snippet.trim() !== '';
    });

    if (validProfiles.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'No valid profiles found in the CSV file'
      });
    }

    console.log(`Found ${validProfiles.length} valid profiles for filtering`);

    // Use OpenAI API to filter profiles
    const filteredProfiles = await openaiService.filterProfilesFromCsv(validProfiles, filters);

    console.log(`OpenAI filtering completed: ${filteredProfiles.length} profiles matched filters`);

    // Return the filtered profiles
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        totalProfiles: csvData.length,
        validProfiles: validProfiles.length,
        filteredProfiles: filteredProfiles.length,
        profiles: filteredProfiles,
        filters: filters
      }
    });

  } catch (error) {
    console.error('Error filtering profiles from CSV using OpenAI:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: 'Failed to filter profiles from CSV using OpenAI',
      details: error.message
    });
  }
};

// Filter profiles from CSV using Gemini API
exports.filterProfilesFromCsvGemini = async (req, res) => {
  try {
    // Check if file is uploaded
    if (!req.file) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'Please upload a CSV or XLSX file'
      });
    }

    const { title, location, industries } = req.body;

    // Parse industries if provided
    let industriesArray = [];
    if (industries) {
      try {
        if (typeof industries === 'string') {
          // Handle different string formats
          if (industries.startsWith('[') && industries.endsWith(']')) {
            industriesArray = JSON.parse(industries);
          } else {
            industriesArray = industries.split(',').map(i => i.trim());
          }
        } else if (Array.isArray(industries)) {
          industriesArray = industries;
        }
      } catch (error) {
        console.error('Error parsing industries:', error);
        industriesArray = [];
      }
    }

    const filters = {
      title: title || '',
      location: location || '',
      industries: industriesArray
    };

    console.log('Filters received:', filters);

    // Parse CSV/XLSX file
    let csvData = [];
    const fileExtension = path.extname(req.file.originalname).toLowerCase();

    if (fileExtension === '.csv') {
      // Parse CSV file
      const csvContent = req.file.buffer.toString('utf8');
      const stream = Readable.from(csvContent);

      await new Promise((resolve, reject) => {
        stream
          .pipe(csv())
          .on('data', (row) => {
            csvData.push(row);
          })
          .on('end', () => {
            resolve();
          })
          .on('error', (error) => {
            reject(error);
          });
      });
    } else if (fileExtension === '.xlsx') {
      // Parse XLSX file
      const workbook = xlsx.read(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      csvData = xlsx.utils.sheet_to_json(worksheet);
    } else {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'Please upload a CSV or XLSX file'
      });
    }

    console.log(`Parsed ${csvData.length} rows from uploaded file`);

    // Validate CSV has required columns
    if (csvData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'The uploaded file is empty or has no data rows'
      });
    }

    // Check for required columns (title and snippet)
    const firstRow = csvData[0];
    const hasTitle = 'title' in firstRow;
    const hasSnippet = 'snippet' in firstRow;

    if (!hasTitle || !hasSnippet) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'CSV file must contain "title" and "snippet" columns'
      });
    }

    // Clean and validate data
    const validProfiles = csvData.filter(row => {
      return row.title && row.title.trim() !== '' &&
        row.snippet && row.snippet.trim() !== '';
    });

    if (validProfiles.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        error: 'No valid profiles found in the CSV file'
      });
    }

    console.log(`Found ${validProfiles.length} valid profiles for filtering`);

    // Use Gemini API to filter profiles
    const filteredProfiles = await geminiService.filterProfilesFromCsv(validProfiles, filters);

    console.log(`Gemini filtering completed: ${filteredProfiles.length} profiles matched filters`);

    // Return the filtered profiles
    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        totalProfiles: csvData.length,
        validProfiles: validProfiles.length,
        filteredProfiles: filteredProfiles.length,
        profiles: filteredProfiles,
        filters: filters
      }
    });

  } catch (error) {
    console.error('Error filtering profiles from CSV using Gemini:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: 'Failed to filter profiles from CSV using Gemini',
      details: error.message
    });
  }
};

// Process CSV/XLSX file and return formatted profiles without filters using Gemini AI
exports.processCsvProfiles = async (req, res) => {
  try {
    let csvData = [];
    let sourceMeta = {};

    // Use req.files (from upload.any()) which is an array
    if (req.files && req.files.length > 0) {
      const file = req.files[0]; // Get the first file from the array
      // Logic for handling file upload
      console.log(`Processing uploaded file: ${file.originalname} (${file.size} bytes)`);
      const fileExtension = path.extname(file.originalname).toLowerCase();
      if (fileExtension === '.csv') {
        csvData = await parseCsvBuffer(file.buffer);
      } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
        csvData = await parseExcelBuffer(file.buffer);
      } else {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Unsupported file format. Please upload CSV or XLSX files.'
        });
      }
      sourceMeta = {
        fileName: file.originalname,
        fileSize: file.size,
      };
    } else if (req.body.rawData) {
      // Logic for handling raw text data (this part is correct)
      console.log(`Processing raw text data of length: ${req.body.rawData.length}`);
      if (typeof req.body.rawData !== 'string' || req.body.rawData.trim().length === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ error: 'rawData must be a non-empty string.' });
      }
      try {
        csvData = await parseCsvString(req.body.rawData);
      } catch (parseError) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Failed to parse rawData. Please ensure it is valid CSV format.',
          details: parseError.message
        });
      }
      sourceMeta = {
        inputTextLength: req.body.rawData.length,
      };
    } else {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Please provide either a file upload (as "file") or raw text data (as "rawData").'
      });
    }

    if (csvData.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'No data could be parsed from the provided input.'
      });
    }

    console.log(`Parsed ${csvData.length} rows from the input.`);
    console.log('Available fields from source:', Object.keys(csvData[0]));
    console.log(`Processing ${csvData.length} rows with Gemini AI cleanup...`);

    // Use Gemini AI to clean up and standardize the messy CSV data
    let cleanedProfiles = [];
    try {
      cleanedProfiles = await geminiService.cleanupCsvProfiles(csvData);
      console.log(`Gemini AI cleanup completed: ${cleanedProfiles.length} profiles with valid LinkedIn URLs processed`);
    } catch (geminiError) {
      console.error('Gemini AI cleanup failed:', geminiError);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'AI cleanup failed',
        details: geminiError.message
      });
    }

    // Transform Gemini results to searchLinkedInProfiles format
    const transformedResults = cleanedProfiles.map((profile, index) => {
      let score = 80;
      if (profile.name && profile.title && profile.company && profile.location) score += 15;
      if (profile.linkedinUrl) score += 10;
      if (profile.email) score += 10;
      if (profile.industry) score += 5;

      return {
        title: `${profile.name || 'Unknown'} - ${profile.title || 'Professional'} - ${profile.company || 'Company'}`,
        link: profile.linkedinUrl || '',
        snippet: `${profile.name || 'Unknown'} • ${profile.location || ''} • ${profile.title || ''} at ${profile.company || ''}`,
        pagemap: { metatags: [{ 'profile:first_name': profile.name ? profile.name.split(' ')[0] || '' : '', 'profile:last_name': profile.name ? profile.name.split(' ').slice(1).join(' ') || '' : '', 'og:description': `${profile.name || 'Unknown'} • ${profile.location || ''} • ${profile.title || ''}` }] },
        extractedTitle: profile.title || '',
        extractedCompany: profile.company || '',
        extractedLocation: profile.location || '',
        extractedIndustry: profile.industry || '',
        fullName: profile.name || 'Unknown',
        linkedinUrl: profile.linkedinUrl || '',
        email: profile.email || '',
        relevanceScore: `3/3`,
        originalRelevanceScore: score,
        source: 'csv_processing',
        csvData: { name: profile.name || '', title: profile.title || '', company: profile.company || '', location: profile.location || '', industry: profile.industry || '', linkedinUrl: profile.linkedinUrl || '', email: profile.email || '' },
        aiProcessed: true,
        geminiCleanup: true,
        batchIndex: Math.floor(index / 40) + 1,
        profileIndex: index + 1
      };
    });

    transformedResults.sort((a, b) => b.originalRelevanceScore - a.originalRelevanceScore);

    const response = {
      results: transformedResults,
      meta: {
        totalResults: transformedResults.length,
        totalResultsBeforeFilter: transformedResults.length,
        resultsAfterRelevanceFilter: transformedResults.length,
        totalFetched: csvData.length,
        uniqueResults: transformedResults.length,
        googleResults: 0,
        braveResults: 0,
        signalHireResults: 0,
        icypeasResults: 0,
        contactOutResults: 0,
        csvImportResults: transformedResults.length,
        csvResultsInFinal: transformedResults.length,
        queriesUsed: 0,
        braveQueriesUsed: 0,
        totalTiers: 0,
        filters: [],
        includeSignalHire: false,
        includeBrave: false,
        includeIcypeas: false,
        includeContactOut: false,
        includeCsvImport: true,
        includeGoogle: false,
        csvImportMeta: {
          totalRecordsInCsv: csvData.length,
          totalMatches: cleanedProfiles.length,
          ...sourceMeta,
          processingNotes: 'Data cleaned and standardized using Gemini AI - only returns profiles with valid LinkedIn URLs',
          aiProcessing: 'gemini_cleanup',
          batchesProcessed: Math.ceil(cleanedProfiles.length / 40),
          fieldsExtracted: ['name', 'title', 'company', 'location', 'industry', 'linkedinUrl', 'email'],
          averageCompleteness: transformedResults.length > 0 ? (transformedResults.reduce((sum, r) => sum + r.originalRelevanceScore, 0) / transformedResults.length).toFixed(1) : 0
        }
      }
    };

    console.log(`CSV processing completed: ${transformedResults.length} profiles from ${csvData.length} records`);
    res.status(StatusCodes.OK).json(response);

  } catch (error) {
    console.error('Error processing CSV profiles:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to process CSV profiles',
      details: error.message
    });
  }
};
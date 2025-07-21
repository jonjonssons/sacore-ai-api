/**
 * Routes for profile operations
 */
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();
const { body, param, validationResult } = require('express-validator');
const requestValidator = require('../middleware/requestValidator');
const profileService = require('../services/profileService');
const signalHireService = require('../services/signalHireService');
const evaluationService = require('../services/evaluationService');
const creditService = require('../services/creditService');
const openaiService = require('../services/openaiService');
const linkedinHelpers = require('../utils/linkedinHelpers');
const profileController = require('../controllers/profileController');
const { StatusCodes } = require('http-status-codes');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const ProfileRequest = require('../models/ProfileRequest');
const { authenticateUser, checkCredits } = require('../middleware/authentication');
const { ForbiddenError, UnauthenticatedError } = require('../errors');
const { STATUS_CODES } = require('http');
const { default: pLimit } = require('p-limit');

const router = express.Router();

// Get profile by LinkedIn URL
router.get('/profile/:encodedLinkedInUrl', async (req, res) => {
  try {
    const linkedInUrl = decodeURIComponent(req.params.encodedLinkedInUrl);
    const requestRecord = await profileService.getRequestByUrl(linkedInUrl);

    if (!requestRecord) {
      return res.status(404).json({
        found: false,
        pending: false,
        message: 'No profile data found for this URL.',
        linkedInUrl
      });
    }

    res.json({
      found: requestRecord.status === 'success',
      pending: requestRecord.status === 'pending',
      profileData: requestRecord.data || null,
      linkedInUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch profile data' });
  }
});


// Enrich profile with SignalHire data
router.post(
  '/enrich',
  authenticateUser,
  checkCredits,
  body('linkedinUrl').isURL().withMessage('Valid LinkedIn URL required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrl } = req.body;
      const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;

      // 🔍 Request profile enrichment
      const { requestId } = await signalHireService.searchProfile(linkedinUrl, callbackUrl);

      // ⛽ Only consume credits after successful request
      await creditService.consumeCredits(req.user.userId, 'ENRICHING PROFILE', 1);

      // 📝 Save request to DB
      await profileService.createRequest(requestId, linkedinUrl);

      return res.status(StatusCodes.OK).json({
        success: true,
        requestId,
        message: 'Profile enrichment request sent to SignalHire',
      });
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return res.status(StatusCodes.PAYMENT_REQUIRED).json({
          success: false,
          error: 'Not enough credits to perform this operation',
        });
      }

      if (error instanceof UnauthenticatedError) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          error: 'User authentication failed',
        });
      }

      console.error('❌ Enrichment request failed:', error);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'Failed to send profile enrichment request',
      });
    }
  }
);

// Batch enrich multiple profiles with SignalHire data
router.post('/enrich-batch',
  authenticateUser,
  checkCredits,
  body('linkedinUrls').isArray().withMessage('Array of LinkedIn URLs required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrls } = req.body;

      // Validate LinkedIn URLs
      const invalidUrls = linkedinUrls.filter(url => {
        try {
          new URL(url);
          return false;
        } catch (e) {
          return true;
        }
      });

      if (invalidUrls.length > 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Invalid LinkedIn URLs provided',
          invalidUrls
        });
      }

      const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;

      // Fire the batch to SignalHire
      await signalHireService.searchProfiles(linkedinUrls, callbackUrl);

      // Only consume credits after successful SignalHire request
      await creditService.consumeCredits(req.user.userId, `ENRICHING ${linkedinUrls.length} PROFILES`, (linkedinUrls.length) * 1);

      const results = [];

      for (const linkedinUrl of linkedinUrls) {
        const uniqueRequestId = uuidv4();

        try {
          await profileService.createRequest(uniqueRequestId, linkedinUrl);

          results.push({
            linkedinUrl,
            requestId: uniqueRequestId,
            status: 'pending'
          });
        } catch (error) {
          console.error(`Error storing request for ${linkedinUrl}:`, error);
          results.push({
            linkedinUrl,
            error: error.message,
            status: 'failed'
          });
        }
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        results,
        message: `Processed ${results.length} LinkedIn profiles for enrichment`
      });

    } catch (error) {
      console.error('❌ Batch enrichment request failed:', error);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to process batch profile enrichment request',
        details: error.message
      });
    }
  }
);


// Get profile evaluation
router.get('/evaluation/:url', async (req, res) => {
  try {
    const url = decodeURIComponent(req.params.url);
    console.log(`Checking evaluation for URL: ${url}`);

    // Get evaluation
    const evaluation = evaluationService.getEvaluation(url);
    return res.status(200).json(evaluation);
  } catch (error) {
    console.error('Error checking evaluation:', error);
    return res.status(500).json({ error: 'Internal server error checking evaluation' });
  }
});

// GET /api/request/:requestId
router.get('/request/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;

    // Find the request record in DB by requestId
    const requestRecord = await ProfileRequest.findOne({ requestId });

    if (!requestRecord) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Respond with status and data (could be null if not ready)
    return res.json({
      status: requestRecord.status,
      data: requestRecord.data || null,
    });
  } catch (error) {
    console.error('Error fetching request:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// List all profiles (for admin purposes)
router.get('/', async (req, res) => {
  try {
    const profiles = await profileService.getAllProfiles();
    return res.status(200).json({ profiles });
  } catch (error) {
    console.error('Error listing profiles:', error);
    return res.status(500).json({ error: 'Internal server error listing profiles' });
  }
});

// Analyze profiles against criteria
router.post(
  '/analyze',
  authenticateUser,
  checkCredits,
  body('linkedinUrls').isArray({ min: 1 }).withMessage('Array of LinkedIn URLs is required'),
  body('criteria').isArray({ min: 1 }).withMessage('Criteria array required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrls, criteria } = req.body;

      // Calculate credit cost (1 credit per profile)
      const creditCost = linkedinUrls.length;

      await creditService.consumeCredits(
        req.user.userId,
        `ANALYZING ${linkedinUrls.length} PROFILES`,
        creditCost
      );

      const results = [];
      const BATCH_SIZE = 10;

      const batches = [];
      for (let i = 0; i < linkedinUrls.length; i += BATCH_SIZE) {
        batches.push(linkedinUrls.slice(i, i + BATCH_SIZE));
      }

      for (const batch of batches) {
        const profileDocs = await Promise.all(
          batch.map(async (url) => {
            try {
              return await ProfileRequest.findOne({
                linkedinUrl: url,
                status: 'success'
              });
            } catch (error) {
              console.error(`Error fetching profile ${url}:`, error);
              return null;
            }
          })
        );

        const validProfiles = [];
        const invalidUrlsMap = {};

        profileDocs.forEach((doc, index) => {
          if (!doc || !doc.data) {
            results.push({
              linkedinUrl: batch[index],
              error: 'Profile not found or incomplete',
              status: 'failed'
            });
            invalidUrlsMap[index] = batch[index];
          } else {
            validProfiles.push({
              index,
              linkedinUrl: doc.linkedinUrl,
              fullName: doc.data?.fullName || '',
              data: {
                locations: doc.data.locations || [],
                skills: doc.data.skills || [],
                education: doc.data.education?.map(e => ({
                  faculty: e.faculty,
                  degree: e.degree
                })) || [],
                experience: doc.data.experience?.map(e => ({
                  position: e.position,
                  location: e.location,
                  current: e.current,
                  started: e.started,
                  ended: e.ended,
                  company: e.company,
                  summary: e.summary,
                  industry: e.industry
                })) || [],
                headLine: doc.data.headLine,
                summary: doc.data.summary,
                certification: doc.data.certification?.map(c => ({
                  name: c.name,
                  license: c.license,
                  authority: c.authority
                })) || [],
              }
            });
          }
        });

        if (validProfiles.length > 0) {
          try {
            const batchResult = await openaiService.analyzeProfilesBatchAgainstCriteria(validProfiles, criteria);

            // Only consume credits after successful analysis
            await creditService.consumeCredits(
              req.user.userId,
              `ANALYZING ${validProfiles.length} PROFILES`,
              validProfiles.length
            );

            // Process the batch results
            batchResult.forEach((analysis, index) => {
              const profile = validProfiles[index];
              const breakdown = analysis.breakdown || [];
              const total = breakdown.length;
              const metCount = breakdown.filter(c => c.met).length;
              const calculatedScore = `${metCount}/${total}`;

              results.push({
                linkedinUrl: profile.linkedinUrl,
                name: profile.fullName,
                enrichedData: profile.data,
                analysis: {
                  score: calculatedScore,
                  breakdown,
                  description: analysis.description
                }
              });
            });

          } catch (error) {
            console.error(`Error analyzing batch of profiles:`, error);

            // ✅ Only push failed results if analysis *actually* failed (and results not added above)
            validProfiles.forEach(profile => {
              const alreadyExists = results.find(r => r.linkedinUrl === profile.linkedinUrl);
              if (!alreadyExists) {
                results.push({
                  linkedinUrl: profile.linkedinUrl,
                  error: 'Failed to analyze profile in batch',
                  status: 'failed'
                });
              }
            });
          }
        }
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        results,
        message: `Analyzed ${results.length} profiles against criteria`
      });

    } catch (error) {
      if (error instanceof ForbiddenError) {
        return res.status(StatusCodes.PAYMENT_REQUIRED).json({
          success: false,
          error: 'Not enough credits to perform this operation',
        });
      }

      if (error instanceof UnauthenticatedError) {
        return res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          error: 'User authentication failed',
        });
      }

      console.error('❌ Profile analysis failed:', error);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'Failed to analyze profiles',
        details: error.message
      });
    }
  }
);


// Deep analyze: enrich profiles with SignalHire and analyze with OpenAI based on criteria
router.post(
  '/deep-analyze',
  authenticateUser,
  checkCredits,
  body('criteria').isArray({ min: 1 }).withMessage('Criteria array required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrls = [], profileIds = [], criteria } = req.body;

      // Normalize LinkedIn URLs
      const normalizeLinkedinUrl = (url) => {
        try {
          const parsed = new URL(url);
          const pathname = parsed.pathname.replace(/\/+$/, '');
          return `https://www.linkedin.com${pathname}`;
        } catch {
          return url;
        }
      };
      const normalizedUrls = linkedinUrls.map(normalizeLinkedinUrl);

      const totalCount = normalizedUrls.length + profileIds.length;

      if (totalCount === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'At least one linkedinUrl or profileId must be provided'
        });
      }

      // Consume total credits
      await creditService.consumeCredits(
        req.user.userId,
        `DEEP ANALYZE ${totalCount} PROFILES`,
        totalCount
      );

      const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;
      const BATCH_SIZE = 10;
      const limit = pLimit(3);

      // --- HANDLE PROFILE IDs ENRICHMENT ---
      const existingByIds = await ProfileRequest.find({
        profileId: { $in: profileIds },
        status: 'success'
      });
      const existingProfileSet = new Set(existingByIds.map(p => p.profileId));
      const idsToEnrich = profileIds.filter(id => !existingProfileSet.has(id));

      const profileIdBatches = [];
      for (let i = 0; i < idsToEnrich.length; i += BATCH_SIZE) {
        const batch = idsToEnrich.slice(i, i + BATCH_SIZE);
        profileIdBatches.push(limit(async () => {
          await signalHireService.searchProfiles(batch, callbackUrl);
          await Promise.all(batch.map(id =>
            profileService.createRequest(uuidv4(), null, id).catch(err =>
              console.error(`Error creating request for profileId ${id}`, err)
            )
          ));
        }));
      }

      // --- HANDLE LINKEDIN URLs ENRICHMENT ---
      const existingByUrls = await ProfileRequest.find({
        linkedinUrl: { $in: normalizedUrls },
        status: 'success'
      });
      const existingUrlSet = new Set(existingByUrls.map(p => p.linkedinUrl));
      const urlsToEnrich = normalizedUrls.filter(url => !existingUrlSet.has(url));

      const urlBatches = [];
      for (let i = 0; i < urlsToEnrich.length; i += BATCH_SIZE) {
        const batch = urlsToEnrich.slice(i, i + BATCH_SIZE);
        urlBatches.push(limit(async () => {
          await signalHireService.searchProfiles(batch, callbackUrl);
          await Promise.all(batch.map(url =>
            profileService.createRequest(uuidv4(), url).catch(err =>
              console.error(`Error creating request for URL ${url}`, err)
            )
          ));
        }));
      }

      await Promise.all([...profileIdBatches, ...urlBatches]);

      // Poll function
      const pollEnrichmentCompletion = async (ids, urls, maxRetries = 20, intervalMs = 7000) => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const profileDocs = await ProfileRequest.find({
              $or: [
                { profileId: { $in: ids }, status: 'success' },
                { linkedinUrl: { $in: urls }, status: 'success' }
              ]
            });

            const profileMap = new Map();
            profileDocs.forEach(doc => {
              if (doc.profileId) profileMap.set(doc.profileId, doc);
              if (doc.linkedinUrl) profileMap.set(doc.linkedinUrl, doc);
            });

            const allDone =
              ids.every(id => profileMap.get(id)?.data) &&
              urls.every(url => profileMap.get(url)?.data);


            if (allDone) return profileMap;
          } catch (e) {
            console.error('Polling error:', e);
          }

          await new Promise(res => setTimeout(res, intervalMs));
        }

        const profileDocs = await ProfileRequest.find({
          $or: [
            { profileId: { $in: ids }, status: 'success' },
            { linkedinUrl: { $in: urls }, status: 'success' }
          ]
        });
        const profileMap = new Map();
        profileDocs.forEach(doc => {
          if (doc.profileId) profileMap.set(doc.profileId, doc);
          if (doc.linkedinUrl) profileMap.set(doc.linkedinUrl, doc);
        });
        return profileMap;
      };

      const profileMap = await pollEnrichmentCompletion(profileIds, normalizedUrls);
      const results = [], validProfiles = [];

      [...profileIds, ...normalizedUrls].forEach(key => {
        const doc = profileMap.get(key);
        if (!doc || !doc.data) {
          results.push({
            id: key,
            error: 'Profile not found or incomplete',
            status: 'failed'
          });
        } else {
          validProfiles.push({
            id: key,
            fullName: doc.data?.fullName || '',
            data: JSON.parse(JSON.stringify(doc.data))
          });
        }
      });

      // Run OpenAI analysis
      if (validProfiles.length > 0) {
        try {
          const OPENAI_BATCH_SIZE = 10;
          const openaiBatches = [];

          for (let i = 0; i < validProfiles.length; i += OPENAI_BATCH_SIZE) {
            const batch = validProfiles.slice(i, i + OPENAI_BATCH_SIZE);
            openaiBatches.push(
              openaiService.analyzeProfilesBatchAgainstCriteria(
                batch.map(p => p.data),
                criteria
              )
            );
          }

          const allResults = await Promise.all(openaiBatches);
          const analysisResults = allResults.flatMap(result => result.profiles);

          // Only consume credits after successful analysis
          await creditService.consumeCredits(
            req.user.userId,
            `DEEP ANALYZE ${totalCount} PROFILES`,
            totalCount
          );

          analysisResults.forEach((analysis, idx) => {
            const profile = validProfiles[idx];
            const breakdown = analysis.breakdown || [];
            const score = `${breakdown.filter(c => c.met).length}/${breakdown.length}`;

            results.push({
              id: profile.id,
              name: profile.fullName,
              enrichedData: profile.data,
              analysis: {
                score,
                breakdown,
                description: analysis.description
              }
            });
          });
        } catch (err) {
          console.error('❌ Analysis failed:', err);
          validProfiles.forEach(profile => {
            if (!results.find(r => r.id === profile.id)) {
              results.push({
                id: profile.id,
                error: 'Failed to analyze profile',
                status: 'failed'
              });
            }
          });
        }
      }

      return res.status(StatusCodes.OK).json({
        success: true,
        results,
        message: `Deep analyzed ${results.length} profiles`
      });

    } catch (error) {
      console.error('❌ Deep analyze failed:', error);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'Failed to perform deep analyze',
        details: error.message
      });
    }
  }
);

// Route to delete all ProfileRequest records from the database
router.delete(
  '/profile-requests',
  authenticateUser,
  async (req, res) => {
    try {
      // Delete all ProfileRequest documents
      const result = await ProfileRequest.deleteMany({});
      return res.status(StatusCodes.OK).json({
        success: true,
        message: `Deleted ${result.deletedCount} profile request(s)`,
      });
    } catch (error) {
      console.error('Error deleting profile requests:', error);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: 'Failed to delete profile requests',
      });
    }
  }
);

router.post(
  '/get-emails',
  authenticateUser,
  checkCredits,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrls = [], profileIds = [] } = req.body;

      // Check that at least one input is provided
      const totalCount = linkedinUrls.length + profileIds.length;
      if (totalCount === 0) {
        return res.status(400).json({
          error: 'At least one linkedinUrl or profileId must be provided'
        });
      }

      // Normalize LinkedIn URLs
      const normalizeLinkedinUrl = (url) => {
        try {
          const parsed = new URL(url);
          const pathname = parsed.pathname.replace(/\/+$/, '');
          return `https://www.linkedin.com${pathname}`;
        } catch {
          return url;
        }
      };

      const normalizedUrls = linkedinUrls.map(normalizeLinkedinUrl);

      // Find already enriched profiles by URLs
      const existingByUrls = await ProfileRequest.find({
        linkedinUrl: { $in: normalizedUrls },
        status: 'success'
      });

      // Find already enriched profiles by IDs
      const existingByIds = await ProfileRequest.find({
        profileId: { $in: profileIds },
        status: 'success'
      });

      // For get-emails, we need to check if profiles have contact information
      // If they don't have contacts, we should re-enrich them
      const existingUrlsWithContacts = new Set();
      const existingIdsWithContacts = new Set();

      existingByUrls.forEach(profile => {
        if (profile.data && profile.data.contacts && profile.data.contacts.length > 0) {
          existingUrlsWithContacts.add(profile.linkedinUrl);
        }
      });

      existingByIds.forEach(profile => {
        if (profile.data && profile.data.contacts && profile.data.contacts.length > 0) {
          existingIdsWithContacts.add(profile.profileId);
        }
      });

      // Filter URLs and IDs that need enrichment (those without existing contact data)
      const urlsToEnrich = normalizedUrls.filter(url => !existingUrlsWithContacts.has(url));
      const idsToEnrich = profileIds.filter(id => !existingIdsWithContacts.has(id));

      // Consume credits for the operation - consume for all profiles regardless of existing data
      await creditService.consumeCredits(req.user.userId, `GET EMAILS FOR ${totalCount} PROFILES`, totalCount);

      const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;

      // Batch size for SignalHire enrichment requests
      const BATCH_SIZE = 10;

      // Limit concurrency to 3 batches at a time
      const pLimit = require('p-limit');
      const limit = pLimit.default(3);

      const batchPromises = [];

      // Handle LinkedIn URLs enrichment
      for (let i = 0; i < urlsToEnrich.length; i += BATCH_SIZE) {
        const batch = urlsToEnrich.slice(i, i + BATCH_SIZE);
        batchPromises.push(limit(async () => {
          await signalHireService.searchProfiles(batch, callbackUrl, {}, false);

          // Save requests in DB with status pending concurrently
          const insertPromises = batch.map(linkedinUrl => {
            const uniqueRequestId = require('uuid').v4();
            return ProfileRequest.create({
              requestId: uniqueRequestId,
              linkedinUrl,
              status: 'pending',
              data: null
            }).catch(error => {
              console.error(`Error storing request for ${linkedinUrl}:`, error);
            });
          });
          await Promise.all(insertPromises);
        }));
      }

      // Handle Profile IDs enrichment
      for (let i = 0; i < idsToEnrich.length; i += BATCH_SIZE) {
        const batch = idsToEnrich.slice(i, i + BATCH_SIZE);
        batchPromises.push(limit(async () => {
          await signalHireService.searchProfiles(batch, callbackUrl, {}, false);

          // Save requests in DB with status pending concurrently
          const insertPromises = batch.map(profileId => {
            const uniqueRequestId = require('uuid').v4();
            return ProfileRequest.create({
              requestId: uniqueRequestId,
              profileId,
              status: 'pending',
              data: null
            }).catch(error => {
              console.error(`Error storing request for ${profileId}:`, error);
            });
          });
          await Promise.all(insertPromises);
        }));
      }

      await Promise.all(batchPromises);

      // Polling function to check enrichment completion for both URLs and IDs
      const pollEnrichmentCompletion = async (urls, ids, maxRetries = 30, intervalMs = 5000) => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Find profiles by URLs
            const profileDocsByUrls = await ProfileRequest.find({
              linkedinUrl: { $in: urls },
              status: 'success'
            });

            // Find profiles by IDs
            const profileDocsByIds = await ProfileRequest.find({
              profileId: { $in: ids },
              status: 'success'
            });

            // Map identifiers to profileDocs for quick lookup
            const profileMapByUrl = new Map(profileDocsByUrls.map(doc => [doc.linkedinUrl, doc]));
            const profileMapById = new Map(profileDocsByIds.map(doc => [doc.profileId, doc]));

            // Check if all profiles are present and have data WITH contacts
            const allUrlsCompleted = urls.every(url => {
              const doc = profileMapByUrl.get(url);
              return doc && doc.data && doc.data.contacts && doc.data.contacts.length > 0;
            });

            const allIdsCompleted = ids.every(id => {
              const doc = profileMapById.get(id);
              return doc && doc.data && doc.data.contacts && doc.data.contacts.length > 0;
            });

            if (allUrlsCompleted && allIdsCompleted) {
              // Return profileDocs in the order of urls and ids
              const urlResults = urls.map(url => ({ type: 'url', identifier: url, doc: profileMapByUrl.get(url) }));
              const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: profileMapById.get(id) }));
              return [...urlResults, ...idResults];
            }

            // If we're past the minimum wait time, also accept profiles with data (even if no contacts)
            if (attempt >= 15) { // After 75 seconds, accept any profiles with data
              const allUrlsHaveData = urls.every(url => {
                const doc = profileMapByUrl.get(url);
                return doc && doc.data;
              });

              const allIdsHaveData = ids.every(id => {
                const doc = profileMapById.get(id);
                return doc && doc.data;
              });

              if (allUrlsHaveData && allIdsHaveData) {
                const urlResults = urls.map(url => ({ type: 'url', identifier: url, doc: profileMapByUrl.get(url) }));
                const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: profileMapById.get(id) }));
                return [...urlResults, ...idResults];
              }
            }
          } catch (error) {
            console.error('Error fetching profiles:', error);
          }

          // Wait before next attempt
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        // Return whatever is available after max retries
        try {
          const profileDocsByUrls = await ProfileRequest.find({
            linkedinUrl: { $in: urls },
            status: 'success'
          });

          const profileDocsByIds = await ProfileRequest.find({
            profileId: { $in: ids },
            status: 'success'
          });

          const profileMapByUrl = new Map(profileDocsByUrls.map(doc => [doc.linkedinUrl, doc]));
          const profileMapById = new Map(profileDocsByIds.map(doc => [doc.profileId, doc]));

          const urlResults = urls.map(url => ({ type: 'url', identifier: url, doc: profileMapByUrl.get(url) }));
          const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: profileMapById.get(id) }));
          return [...urlResults, ...idResults];
        } catch (error) {
          console.error('Error fetching profiles after max retries:', error);
          const urlResults = urls.map(url => ({ type: 'url', identifier: url, doc: null }));
          const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: null }));
          return [...urlResults, ...idResults];
        }
      };

      // Poll for enrichment completion
      const profileResults = await pollEnrichmentCompletion(normalizedUrls, profileIds);

      const results = [];

      profileResults.forEach((result) => {
        if (!result.doc || !result.doc.data) {
          results.push({
            identifier: result.identifier,
            linkedinUrl: result.type === 'url' ? result.identifier : null,
            profileId: result.type === 'id' ? result.identifier : null,
            error: 'Profile not found or incomplete',
            status: 'failed'
          });
        } else {
          // Extract email contacts
          const emailContacts = (result.doc.data.contacts || []).filter(contact => contact.type === 'email');

          results.push({
            identifier: result.identifier,
            linkedinUrl: result.type === 'url' ? result.identifier : null,
            profileId: result.type === 'id' ? result.identifier : null,
            emails: emailContacts,
            status: 'success'
          });
        }
      });

      return res.status(200).json({
        success: true,
        results,
        message: `Retrieved email contacts for ${results.length} profiles`
      });

    } catch (error) {
      console.error('Error in /get-emails:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get email contacts',
        details: error.message
      });
    }
  }
);

// Add this new streaming endpoint for get-emails
router.post(
  '/get-emails-stream',
  authenticateUser,
  checkCredits,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrls = [], profileIds = [], profileData = [] } = req.body;

      // Check that at least one input is provided
      const totalCount = linkedinUrls.length + profileIds.length;
      if (totalCount === 0) {
        return res.status(400).json({
          error: 'At least one linkedinUrl or profileId must be provided'
        });
      }

      // Validate profileData if provided (for Icypeas fallback)
      // profileData should be array of objects: [{ linkedinUrl, firstname, lastname, domainOrCompany }]
      // Also supports legacy 'companyname' parameter for backward compatibility
      const profileDataMap = new Map();
      if (profileData && Array.isArray(profileData)) {
        profileData.forEach(data => {
          if (data.linkedinUrl && data.firstname && data.lastname && (data.domainOrCompany || data.companyname)) {
            // Normalize the LinkedIn URL to match the normalized URLs used in processing
            const normalizedUrl = (() => {
              try {
                const parsed = new URL(data.linkedinUrl);
                const pathname = parsed.pathname.replace(/\/+$/, '');
                return `https://www.linkedin.com${pathname}`;
              } catch {
                return data.linkedinUrl;
              }
            })();

            profileDataMap.set(normalizedUrl, {
              firstname: data.firstname,
              lastname: data.lastname,
              domainOrCompany: data.domainOrCompany || data.companyname  // Prefer domainOrCompany, fallback to companyname
            });
          }
        });
      }

      // Calculate credit cost
      // Don't consume credits upfront - only charge for profiles that return emails
      // Track successful email extractions for credit consumption
      let profilesWithEmails = 0;

      // Set up Server-Sent Events
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Send initial status
      res.write(`data: ${JSON.stringify({
        type: 'status',
        message: 'Starting email extraction...',
        total: totalCount,
        completed: 0
      })}\n\n`);

      const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;
      const BATCH_SIZE = 10;

      // Normalize URLs
      const normalizeLinkedinUrl = (url) => {
        try {
          const parsed = new URL(url);
          const pathname = parsed.pathname.replace(/\/+$/, '');
          return `https://www.linkedin.com${pathname}`;
        } catch {
          return url;
        }
      };

      const normalizedUrls = linkedinUrls.map(normalizeLinkedinUrl);

      // Find already enriched profiles by URLs
      const existingByUrls = await ProfileRequest.find({
        linkedinUrl: { $in: normalizedUrls },
        status: 'success'
      });

      // Find already enriched profiles by IDs
      const existingByIds = await ProfileRequest.find({
        profileId: { $in: profileIds },
        status: 'success'
      });

      // For get-emails, we need to check if profiles have contact information
      const existingUrlsWithContacts = new Set();
      const existingIdsWithContacts = new Set();

      existingByUrls.forEach(profile => {
        if (profile.data && profile.data.contacts && profile.data.contacts.length > 0) {
          existingUrlsWithContacts.add(profile.linkedinUrl);
        }
      });

      existingByIds.forEach(profile => {
        if (profile.data && profile.data.contacts && profile.data.contacts.length > 0) {
          existingIdsWithContacts.add(profile.profileId);
        }
      });

      const urlsToEnrich = normalizedUrls.filter(url => !existingUrlsWithContacts.has(url));
      const idsToEnrich = profileIds.filter(id => !existingIdsWithContacts.has(id));

      // Send enrichment status
      res.write(`data: ${JSON.stringify({
        type: 'enrichment_status',
        message: `Sending ${totalCount} profiles for email extraction...`,
        totalProfiles: totalCount,
        urlsToEnrich: urlsToEnrich.length,
        idsToEnrich: idsToEnrich.length
      })}\n\n`);

      // Batch process enrichment requests
      const limit = pLimit(3);
      const batchPromises = [];

      // Handle LinkedIn URLs enrichment
      if (urlsToEnrich.length > 0) {
        for (let i = 0; i < urlsToEnrich.length; i += BATCH_SIZE) {
          const batch = urlsToEnrich.slice(i, i + BATCH_SIZE);
          batchPromises.push(limit(async () => {
            try {
              // Try SignalHire first for email extraction
              await signalHireService.searchProfiles(batch, callbackUrl, {}, false); // withoutContacts: false for email extraction
              await Promise.all(batch.map(linkedinUrl => {
                const uniqueRequestId = uuidv4();
                return ProfileRequest.create({
                  requestId: uniqueRequestId,
                  linkedinUrl,
                  status: 'pending',
                  data: null
                }).catch(error => {
                  console.error(`Error storing request for ${linkedinUrl}:`, error);
                });
              }));
            } catch (signalHireError) {
              console.warn('SignalHire email enrichment batch failed, trying Icypeas fallback:', signalHireError.message);

              // Send status update about fallback
              res.write(`data: ${JSON.stringify({
                type: 'fallback_status',
                message: `SignalHire failed for email extraction (${signalHireError.message}), trying Icypeas fallback for ${batch.length} profiles...`
              })}\n\n`);

              // Fallback to Icypeas enrichment for email extraction
              try {
                const icypeasService = require('../services/icypeasService');

                // Validate LinkedIn URLs before attempting Icypeas
                const validUrls = batch.filter(url => url && url.includes('linkedin.com/in/'));
                const invalidUrls = batch.filter(url => !url || !url.includes('linkedin.com/in/'));

                if (invalidUrls.length > 0) {
                  console.warn(`Skipping ${invalidUrls.length} invalid URLs for Icypeas email enrichment:`, invalidUrls);
                }

                if (validUrls.length === 0) {
                  console.warn('No valid LinkedIn URLs for Icypeas email enrichment fallback');
                  res.write(`data: ${JSON.stringify({
                    type: 'fallback_failed',
                    message: `No valid LinkedIn URLs for Icypeas email enrichment fallback`
                  })}\n\n`);

                  // Create success records with empty contacts for all URLs (no valid URLs for Icypeas)
                  await Promise.all(batch.map(url => {
                    const uniqueRequestId = uuidv4();
                    return ProfileRequest.create({
                      requestId: uniqueRequestId,
                      linkedinUrl: url,
                      status: 'success',
                      data: {
                        fullName: `${profileDataMap.get(url)?.firstname || ''} ${profileDataMap.get(url)?.lastname || ''}`.trim(),
                        contacts: [], // Empty contacts array
                        enrichmentSource: 'icypeas_fallback',
                        fallbackUsed: true,
                        originalError: signalHireError.message,
                        icypeasError: 'No valid LinkedIn URLs for Icypeas fallback',
                        emailEnrichment: true,
                        noEmailsFound: true
                      }
                    }).catch(e => console.error(`DB request failed for ${url}`, e));
                  }));
                  return;
                }

                console.log(`Attempting Icypeas email enrichment for ${validUrls.length} valid URLs`);

                // Process each URL with Icypeas
                const icypeasResults = [];
                for (const url of validUrls) {
                  const profileInfo = profileDataMap.get(url);
                  if (profileInfo) {
                    try {
                      console.log(`Attempting Icypeas email enrichment for ${url} with data:`, profileInfo);
                      const icypeasResult = await icypeasService.enrichProfileWithEmail(
                        profileInfo.firstname,
                        profileInfo.lastname,
                        profileInfo.domainOrCompany
                      );

                      if (icypeasResult.success && icypeasResult.data && icypeasResult.data.emails.length > 0) {
                        icypeasResults.push({
                          success: true,
                          linkedinUrl: url,
                          emails: icypeasResult.data.emails,
                          raw: icypeasResult.data.raw
                        });
                      } else {
                        icypeasResults.push({
                          success: false,
                          linkedinUrl: url,
                          error: icypeasResult.error || 'No emails found'
                        });
                      }
                    } catch (icypeasError) {
                      console.error(`Icypeas enrichment failed for ${url}:`, icypeasError.message);
                      icypeasResults.push({
                        success: false,
                        linkedinUrl: url,
                        error: icypeasError.message
                      });
                    }
                  } else {
                    console.warn(`No profile data provided for Icypeas fallback for URL: ${url}`);
                    icypeasResults.push({
                      success: false,
                      linkedinUrl: url,
                      error: 'No firstname/lastname/domainOrCompany data provided for Icypeas fallback'
                    });
                  }
                }

                const successfulIcypeasResults = icypeasResults.filter(r => r.success);

                if (successfulIcypeasResults.length > 0) {
                  console.log(`Icypeas fallback successful for ${successfulIcypeasResults.length}/${validUrls.length} profiles`);
                  res.write(`data: ${JSON.stringify({
                    type: 'fallback_success',
                    message: `Icypeas email enrichment fallback successful for ${successfulIcypeasResults.length}/${validUrls.length} profiles`
                  })}\n\n`);

                  // Save Icypeas results
                  const savePromises = icypeasResults.map(async (result) => {
                    try {
                      if (result.success && result.emails) {
                        // Create the request first
                        const uniqueRequestId = uuidv4();
                        await ProfileRequest.create({
                          requestId: uniqueRequestId,
                          linkedinUrl: result.linkedinUrl,
                          status: 'success',
                          data: {
                            fullName: `${profileDataMap.get(result.linkedinUrl)?.firstname || ''} ${profileDataMap.get(result.linkedinUrl)?.lastname || ''}`.trim(),
                            // Add contacts array in SignalHire format for compatibility
                            contacts: result.emails.map(emailData => ({
                              type: 'email',
                              email: emailData.email,
                              label: emailData.type || 'professional',
                              verification: emailData.verification || {}
                            })),
                            enrichmentSource: 'icypeas_fallback',
                            fallbackUsed: true,
                            originalError: signalHireError.message,
                            emailEnrichment: true,
                            icypeasData: result.raw
                          }
                        });

                        console.log(`✅ Icypeas email data saved for: ${result.linkedinUrl}`);
                      } else {
                        // Create record for Icypeas failures - mark as success but with empty contacts
                        const uniqueRequestId = uuidv4();
                        await ProfileRequest.create({
                          requestId: uniqueRequestId,
                          linkedinUrl: result.linkedinUrl,
                          status: 'success',
                          data: {
                            fullName: `${profileDataMap.get(result.linkedinUrl)?.firstname || ''} ${profileDataMap.get(result.linkedinUrl)?.lastname || ''}`.trim(),
                            contacts: [], // Empty contacts array to indicate no emails found
                            enrichmentSource: 'icypeas_fallback',
                            fallbackUsed: true,
                            originalError: signalHireError.message,
                            icypeasError: result.error,
                            emailEnrichment: true,
                            noEmailsFound: true
                          }
                        });
                        console.warn(`❌ Icypeas email enrichment failed for ${result.linkedinUrl}: ${result.error}`);
                      }
                    } catch (saveError) {
                      console.error(`💥 Save error for ${result.linkedinUrl}:`, saveError.message);
                      // Try to create a basic request so it doesn't get lost
                      try {
                        const uniqueRequestId = uuidv4();
                        await ProfileRequest.create({
                          requestId: uniqueRequestId,
                          linkedinUrl: result.linkedinUrl,
                          status: 'success',
                          data: {
                            fullName: `${profileDataMap.get(result.linkedinUrl)?.firstname || ''} ${profileDataMap.get(result.linkedinUrl)?.lastname || ''}`.trim(),
                            contacts: [], // Empty contacts array
                            enrichmentSource: 'icypeas_fallback',
                            fallbackUsed: true,
                            originalError: signalHireError.message,
                            icypeasError: 'Database save error occurred',
                            emailEnrichment: true,
                            noEmailsFound: true
                          }
                        });
                      } catch (createError) {
                        console.error(`💥 Failed to create request for ${result.linkedinUrl}:`, createError.message);
                      }
                    }
                  });

                  await Promise.allSettled(savePromises);
                } else {
                  console.warn('Icypeas email enrichment fallback failed for all profiles');
                  res.write(`data: ${JSON.stringify({
                    type: 'fallback_failed',
                    message: `Both SignalHire and Icypeas failed for email enrichment`
                  })}\n\n`);

                  // Create success records with empty contacts for all URLs (no successful Icypeas results)
                  await Promise.allSettled(validUrls.map(url => {
                    const uniqueRequestId = uuidv4();
                    return ProfileRequest.create({
                      requestId: uniqueRequestId,
                      linkedinUrl: url,
                      status: 'success',
                      data: {
                        fullName: `${profileDataMap.get(url)?.firstname || ''} ${profileDataMap.get(url)?.lastname || ''}`.trim(),
                        contacts: [], // Empty contacts array to indicate no emails found
                        enrichmentSource: 'icypeas_fallback',
                        fallbackUsed: true,
                        originalError: signalHireError.message,
                        icypeasError: 'All Icypeas attempts failed',
                        emailEnrichment: true,
                        noEmailsFound: true
                      }
                    }).catch(e => console.error(`DB request failed for ${url}`, e));
                  }));
                }

                // Handle any invalid URLs that were skipped
                if (invalidUrls.length > 0) {
                  const invalidPromises = invalidUrls.map(url => {
                    const uniqueRequestId = uuidv4();
                    return ProfileRequest.create({
                      requestId: uniqueRequestId,
                      linkedinUrl: url,
                      status: 'success',
                      data: {
                        fullName: '', // No name available for invalid URLs
                        contacts: [], // Empty contacts array
                        enrichmentSource: 'icypeas_fallback',
                        fallbackUsed: true,
                        originalError: signalHireError.message,
                        icypeasError: 'Invalid LinkedIn URL format',
                        emailEnrichment: true,
                        noEmailsFound: true
                      }
                    }).catch(e => console.error(`DB request failed for invalid URL ${url}`, e));
                  });
                  await Promise.allSettled(invalidPromises);
                }

              } catch (icypeasError) {
                console.error('Icypeas email enrichment fallback exception:', icypeasError.message);

                // Send error status update
                res.write(`data: ${JSON.stringify({
                  type: 'fallback_failed',
                  message: `Icypeas email enrichment fallback failed: ${icypeasError.message}`
                })}\n\n`);

                // Create success records with empty contacts for exception cases
                await Promise.allSettled(batch.map(url => {
                  const uniqueRequestId = uuidv4();
                  return ProfileRequest.create({
                    requestId: uniqueRequestId,
                    linkedinUrl: url,
                    status: 'success',
                    data: {
                      fullName: `${profileDataMap.get(url)?.firstname || ''} ${profileDataMap.get(url)?.lastname || ''}`.trim(),
                      contacts: [], // Empty contacts array
                      enrichmentSource: 'icypeas_fallback',
                      fallbackUsed: true,
                      originalError: signalHireError.message,
                      icypeasError: icypeasError.message,
                      emailEnrichment: true,
                      noEmailsFound: true
                    }
                  }).catch(e => console.error(`DB request failed for ${url}`, e));
                }));
              }
            }
          }));
        }
      }

      // Handle Profile IDs enrichment
      if (idsToEnrich.length > 0) {
        for (let i = 0; i < idsToEnrich.length; i += BATCH_SIZE) {
          const batch = idsToEnrich.slice(i, i + BATCH_SIZE);
          batchPromises.push(limit(async () => {
            try {
              // Try SignalHire first for email extraction
              await signalHireService.searchProfiles(batch, callbackUrl, {}, false); // withoutContacts: false for email extraction
              await Promise.all(batch.map(profileId => {
                const uniqueRequestId = uuidv4();
                return ProfileRequest.create({
                  requestId: uniqueRequestId,
                  profileId,
                  status: 'pending',
                  data: null
                }).catch(error => {
                  console.error(`Error storing request for ${profileId}:`, error);
                });
              }));
            } catch (signalHireError) {
              console.warn('SignalHire email enrichment failed for profile IDs, fallback not available for IDs:', signalHireError.message);

              // Send status update about ProfileID limitation
              res.write(`data: ${JSON.stringify({
                type: 'fallback_status',
                message: `SignalHire failed for Profile IDs (${signalHireError.message}). Icypeas fallback requires LinkedIn URLs, not Profile IDs.`
              })}\n\n`);

              // Icypeas requires LinkedIn URLs, so we can't fall back for profile IDs
              // Create failed requests so the polling logic can handle timeouts
              const createPromises = batch.map(async (id) => {
                try {
                  const uniqueRequestId = uuidv4();
                  await ProfileRequest.create({
                    requestId: uniqueRequestId,
                    profileId: id,
                    status: 'pending',
                    data: null
                  });
                  console.log(`Created pending request for Profile ID: ${id}`);
                } catch (createError) {
                  console.error(`Failed to create request for Profile ID ${id}:`, createError.message);
                }
              });

              await Promise.allSettled(createPromises);
            }
          }));
        }
      }

      if (batchPromises.length > 0) {
        await Promise.all(batchPromises);

        res.write(`data: ${JSON.stringify({
          type: 'enrichment_complete',
          message: 'Enrichment requests sent, waiting for results...'
        })}\n\n`);
      }

      // Track completed extractions
      let completedCount = 0;
      const processedIdentifiers = new Set();

      // Process each profile as it becomes available
      const processProfileStream = async () => {
        const maxWaitTime = 120000; // 2 minutes total wait time
        const pollInterval = 3000; // Check every 3 seconds
        const startTime = Date.now();

        while (completedCount < totalCount && (Date.now() - startTime) < maxWaitTime) {
          try {
            console.log(`[STREAM] Polling attempt ${Math.floor((Date.now() - startTime) / 1000)}s - Looking for processed profiles...`);

            // Find profiles that have been processed (either with contacts or empty contacts)
            const processedProfiles = await ProfileRequest.find({
              $or: [
                {
                  linkedinUrl: { $in: normalizedUrls },
                  status: 'success',
                  'data.contacts': { $exists: true }
                },
                {
                  profileId: { $in: profileIds },
                  status: 'success',
                  'data.contacts': { $exists: true }
                }
              ]
            });

            const profilesWithContacts = processedProfiles.filter(profile =>
              profile.data.contacts && profile.data.contacts.length > 0
            );
            const profilesWithoutContactsButProcessed = processedProfiles.filter(profile =>
              !profile.data.contacts || profile.data.contacts.length === 0
            );

            console.log(`[STREAM] Found ${profilesWithContacts.length} profiles with contacts and ${profilesWithoutContactsButProcessed.length} profiles without contacts (processed)`);

            // Process profiles with contacts
            for (const profileDoc of profilesWithContacts) {
              const identifier = profileDoc.linkedinUrl || profileDoc.profileId;

              // Check if this profile matches our input and hasn't been processed yet
              let matchesInput = false;
              if (profileDoc.linkedinUrl) {
                matchesInput = normalizedUrls.some(inputUrl => {
                  const normalizedInput = inputUrl.toLowerCase().replace(/\/+$/, '');
                  const normalizedProfile = profileDoc.linkedinUrl.toLowerCase().replace(/\/+$/, '');
                  return normalizedInput === normalizedProfile ||
                    normalizedInput.includes(normalizedProfile.split('/').pop()) ||
                    normalizedProfile.includes(normalizedInput.split('/').pop());
                });
              } else if (profileDoc.profileId) {
                matchesInput = profileIds.includes(profileDoc.profileId);
              }

              if (!matchesInput || processedIdentifiers.has(identifier)) continue;

              processedIdentifiers.add(identifier);
              completedCount++;

              console.log(`[STREAM] Processing profile with contacts: ${identifier}`);

              try {
                // Extract email contacts
                const emailContacts = (profileDoc.data.contacts || []).filter(contact => contact.type === 'email');

                console.log(`[STREAM] Found ${emailContacts.length} emails for ${identifier}`);

                // Track successful email extraction for credit consumption
                if (emailContacts.length > 0) {
                  profilesWithEmails++;
                }

                // Send individual result
                res.write(`data: ${JSON.stringify({
                  type: 'result',
                  identifier: identifier,
                  linkedinUrl: profileDoc.linkedinUrl || null,
                  profileId: profileDoc.profileId || null,
                  emails: emailContacts,
                  fullName: profileDoc.data?.fullName || null,
                  status: 'success',
                  progress: {
                    completed: completedCount,
                    total: totalCount
                  }
                })}\n\n`);

              } catch (processingError) {
                console.error(`Error processing profile ${identifier}:`, processingError);
                res.write(`data: ${JSON.stringify({
                  type: 'result',
                  identifier: identifier,
                  linkedinUrl: profileDoc.linkedinUrl || null,
                  profileId: profileDoc.profileId || null,
                  error: 'Failed to process profile',
                  status: 'failed',
                  progress: {
                    completed: completedCount,
                    total: totalCount
                  }
                })}\n\n`);
              }
            }

            // Process profiles that were processed but have no contacts (like Icypeas NOT_FOUND results)
            for (const profileDoc of profilesWithoutContactsButProcessed) {
              const identifier = profileDoc.linkedinUrl || profileDoc.profileId;

              // Check if this profile matches our input and hasn't been processed yet
              let matchesInput = false;
              if (profileDoc.linkedinUrl) {
                matchesInput = normalizedUrls.some(inputUrl => {
                  const normalizedInput = inputUrl.toLowerCase().replace(/\/+$/, '');
                  const normalizedProfile = profileDoc.linkedinUrl.toLowerCase().replace(/\/+$/, '');
                  return normalizedInput === normalizedProfile ||
                    normalizedInput.includes(normalizedProfile.split('/').pop()) ||
                    normalizedProfile.includes(normalizedInput.split('/').pop());
                });
              } else if (profileDoc.profileId) {
                matchesInput = profileIds.includes(profileDoc.profileId);
              }

              if (!matchesInput || processedIdentifiers.has(identifier)) continue;

              processedIdentifiers.add(identifier);
              completedCount++;

              console.log(`[STREAM] Processing profile without contacts (processed): ${identifier}`);

              try {
                // Send result with empty emails array but successful processing
                res.write(`data: ${JSON.stringify({
                  type: 'result',
                  identifier: identifier,
                  linkedinUrl: profileDoc.linkedinUrl || null,
                  profileId: profileDoc.profileId || null,
                  emails: [],
                  fullName: profileDoc.data?.fullName || null,
                  status: 'no_contacts',
                  enrichmentSource: profileDoc.data?.enrichmentSource || 'unknown',
                  fallbackUsed: profileDoc.data?.fallbackUsed || false,
                  noEmailsFound: profileDoc.data?.noEmailsFound || false,
                  progress: {
                    completed: completedCount,
                    total: totalCount
                  }
                })}\n\n`);

              } catch (processingError) {
                console.error(`Error processing profile ${identifier}:`, processingError);
                res.write(`data: ${JSON.stringify({
                  type: 'result',
                  identifier: identifier,
                  linkedinUrl: profileDoc.linkedinUrl || null,
                  profileId: profileDoc.profileId || null,
                  error: 'Failed to process profile',
                  status: 'failed',
                  progress: {
                    completed: completedCount,
                    total: totalCount
                  }
                })}\n\n`);
              }
            }

          } catch (error) {
            console.error('Error in profile processing loop:', error);
          }

          console.log(`[STREAM] Completed: ${completedCount}/${totalCount}, waiting ${pollInterval}ms...`);

          // Wait before next poll
          if (completedCount < totalCount) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
          }
        }

        console.log(`[STREAM] Polling complete. Final count: ${completedCount}/${totalCount}`);

        // Handle any remaining unprocessed identifiers (timeouts)
        for (const url of normalizedUrls) {
          if (!processedIdentifiers.has(url)) {
            completedCount++;
            res.write(`data: ${JSON.stringify({
              type: 'result',
              identifier: url,
              linkedinUrl: url,
              profileId: null,
              error: 'Profile processing timed out',
              status: 'failed',
              progress: {
                completed: completedCount,
                total: totalCount
              }
            })}\n\n`);
          }
        }

        for (const id of profileIds) {
          if (!processedIdentifiers.has(id)) {
            completedCount++;
            res.write(`data: ${JSON.stringify({
              type: 'result',
              identifier: id,
              linkedinUrl: null,
              profileId: id,
              error: 'Profile processing timed out',
              status: 'failed',
              progress: {
                completed: completedCount,
                total: totalCount
              }
            })}\n\n`);
          }
        }

        // Only consume credits for profiles that actually returned emails
        if (profilesWithEmails > 0) {
          try {
            const creditsToConsume = profilesWithEmails * 3;
            await creditService.consumeCredits(
              req.user.userId,
              `EMAIL EXTRACTION SUCCESS: ${profilesWithEmails}/${totalCount} PROFILES`,
              creditsToConsume
            );

            res.write(`data: ${JSON.stringify({
              type: 'credit_info',
              message: `Credits consumed: ${creditsToConsume} for ${profilesWithEmails} profiles with emails`,
              profilesWithEmails: profilesWithEmails,
              totalProfiles: totalCount,
              creditsCharged: creditsToConsume
            })}\n\n`);
          } catch (creditError) {
            console.error('Error consuming credits:', creditError);
            res.write(`data: ${JSON.stringify({
              type: 'credit_error',
              message: 'Failed to consume credits',
              error: creditError.message
            })}\n\n`);
          }
        } else {
          res.write(`data: ${JSON.stringify({
            type: 'credit_info',
            message: 'No credits consumed - no emails found for any profiles',
            profilesWithEmails: 0,
            totalProfiles: totalCount,
            creditsCharged: 0
          })}\n\n`);
        }

        // Send completion message
        res.write(`data: ${JSON.stringify({
          type: 'complete',
          message: 'Email extraction complete',
          totalProcessed: completedCount
        })}\n\n`);

        res.end();
      };

      // Start processing
      processProfileStream().catch(error => {
        console.error('Error in profile stream processing:', error);
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: 'Stream processing failed',
          error: error.message
        })}\n\n`);
        res.end();
      });

      // Handle client disconnect
      req.on('close', () => {
        console.log('Client disconnected from get-emails-stream');
      });

    } catch (error) {
      console.error('❌ Get emails stream failed:', error);

      if (!res.headersSent) {
        return res.status(400).json({
          success: false,
          error: 'Failed to start get emails stream',
          details: error.message
        });
      } else {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: 'Stream failed',
          error: error.message
        })}\n\n`);
        res.end();
      }
    }
  }
);

// Add this new streaming endpoint
router.post(
  '/deep-analyze-stream',
  authenticateUser,
  checkCredits,
  body('criteria').isArray({ min: 1 }).withMessage('Criteria array required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(StatusCodes.BAD_REQUEST).json({ errors: errors.array() });
    }

    try {
      const { linkedinUrls = [], profileIds = [], enrichedProfiles = [], criteria } = req.body;

      const normalizeLinkedinUrl = (url) => {
        try {
          const parsed = new URL(url);
          const pathname = parsed.pathname.replace(/\/+$/, '');
          return `https://www.linkedin.com${pathname}`;
        } catch { return url; }
      };

      const enrichmentCount = linkedinUrls.length + profileIds.length;
      const directAnalysisCount = enrichedProfiles.length;
      const totalCount = enrichmentCount + directAnalysisCount;

      if (totalCount === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          error: 'At least one linkedinUrl, profileId, or enrichedProfile must be provided.'
        });
      }

      // Calculate credit cost (1 credit per profile for any operation)
      await creditService.consumeCredits(
        req.user.userId,
        `DEEP ANALYZE STREAM ${totalCount} PROFILES`,
        totalCount
      );

      // Set up Server-Sent Events
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Send initial status
      res.write(`data: ${JSON.stringify({
        type: 'status',
        message: 'Starting deep analysis...',
        total: totalCount,
        completed: 0
      })}\n\n`);

      let completedCount = 0;
      const processedIdentifiers = new Set();

      // --- 1. DIRECT ANALYSIS of enrichedProfiles ---
      if (directAnalysisCount > 0) {
        res.write(`data: ${JSON.stringify({
          type: 'status',
          message: `Analyzing ${directAnalysisCount} pre-enriched profiles...`,
        })}\n\n`);

        const transformEnrichedData = (data) => {
          const sourceData = data.contactOutData || data;
          if (!sourceData.full_name && !sourceData.experience) return null;
          return {
            fullName: sourceData.full_name || '',
            summary: sourceData.company?.overview || sourceData.headline || '',
            headLine: sourceData.headline || '',
            experience: (sourceData.experience || []).map(exp => (typeof exp === 'string' ? { summary: exp } : exp)),
            education: (sourceData.education || []).map(edu => (typeof edu === 'string' ? { summary: edu } : edu)),
            skills: sourceData.skills || [],
            locations: sourceData.location ? [sourceData.location] : [],
            industry: sourceData.industry || sourceData.company?.industry || ''
          };
        };

        for (const profile of enrichedProfiles) {
          const identifier = profile.id || profile.contactOutData?.li_vanity || `enriched_${completedCount}`;
          if (processedIdentifiers.has(identifier)) continue;
          processedIdentifiers.add(identifier);

          const transformedProfile = transformEnrichedData(profile);
          if (transformedProfile) {
            try {
              const analysisResult = await openaiService.analyzeProfilesBatchAgainstCriteria([transformedProfile], criteria);
              const profileAnalysis = analysisResult.profiles[0];
              const breakdown = profileAnalysis.breakdown || [];
              const score = `${breakdown.filter(c => c.met).length}/${breakdown.length}`;
              completedCount++;
              res.write(`data: ${JSON.stringify({
                type: 'result',
                identifier: identifier,
                name: transformedProfile.fullName,
                enrichedData: profile,
                analysis: { score, breakdown, description: profileAnalysis.description },
                status: 'success',
                progress: { completed: completedCount, total: totalCount }
              })}\n\n`);
            } catch (analysisError) {
              completedCount++;
              res.write(`data: ${JSON.stringify({
                type: 'error',
                identifier: identifier,
                error: 'Failed to analyze profile',
                details: analysisError.message,
                status: 'failed',
                progress: { completed: completedCount, total: totalCount }
              })}\n\n`);
            }
          } else {
            completedCount++;
            res.write(`data: ${JSON.stringify({
              type: 'error',
              identifier: identifier,
              error: 'Invalid enriched profile format',
              status: 'failed',
              progress: { completed: completedCount, total: totalCount }
            })}\n\n`);
          }
        }
      }

      // --- 2. ENRICHMENT + ANALYSIS ---
      if (enrichmentCount > 0) {
        const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;
        const BATCH_SIZE = 10;
        const limit = pLimit(10); // Use p-limit for concurrency
        const batchPromises = [];

        const normalizedUrls = linkedinUrls.map(normalizeLinkedinUrl);

        // Find and immediately process already-enriched profiles from the enrichment list
        const existingByUrls = await ProfileRequest.find({ linkedinUrl: { $in: normalizedUrls }, status: 'success' });
        const existingByIds = await ProfileRequest.find({ profileId: { $in: profileIds }, status: 'success' });

        const processExistingProfile = async (profileDoc) => {
          const identifier = profileDoc.linkedinUrl || profileDoc.profileId;
          if (processedIdentifiers.has(identifier)) return;
          processedIdentifiers.add(identifier);
          completedCount++;

          try {
            const analysisResult = await openaiService.analyzeProfilesBatchAgainstCriteria([JSON.parse(JSON.stringify(profileDoc.data))], criteria);
            const profileAnalysis = analysisResult.profiles[0];
            const breakdown = profileAnalysis.breakdown || [];
            const score = `${breakdown.filter(c => c.met).length}/${breakdown.length}`;
            res.write(`data: ${JSON.stringify({
              type: 'result', identifier, name: profileDoc.data?.fullName || '', enrichedData: profileDoc.data,
              analysis: { score, breakdown, description: profileAnalysis.description }, status: 'success',
              progress: { completed: completedCount, total: totalCount }
            })}\n\n`);
          } catch (analysisError) {
            res.write(`data: ${JSON.stringify({
              type: 'error', identifier, error: 'Failed to analyze existing profile', details: analysisError.message,
              status: 'failed', progress: { completed: completedCount, total: totalCount }
            })}\n\n`);
          }
        };

        for (const doc of [...existingByUrls, ...existingByIds]) {
          await processExistingProfile(doc);
        }

        const urlsToEnrich = normalizedUrls.filter(url => !processedIdentifiers.has(url));
        const idsToEnrich = profileIds.filter(id => !processedIdentifiers.has(id));
        const enrichmentNeededCount = urlsToEnrich.length + idsToEnrich.length;

        if (enrichmentNeededCount > 0) {
          res.write(`data: ${JSON.stringify({ type: 'enrichment_status', message: `Enriching ${enrichmentNeededCount} new profiles...` })}\n\n`);

          // Batch process enrichment requests for URLs with ContactOut fallback
          if (urlsToEnrich.length > 0) {
            for (let i = 0; i < urlsToEnrich.length; i += BATCH_SIZE) {
              const batch = urlsToEnrich.slice(i, i + BATCH_SIZE);
              batchPromises.push(limit(async () => {
                try {
                  // Try SignalHire first
                  await signalHireService.searchProfiles(batch, callbackUrl, {}, false);
                  await Promise.all(batch.map(url => profileService.createRequest(uuidv4(), url).catch(e => console.error(`DB request failed for ${url}`, e))));
                } catch (signalHireError) {
                  console.warn('SignalHire batch failed, trying ContactOut fallback:', signalHireError.message);

                  // Send status update about fallback
                  res.write(`data: ${JSON.stringify({
                    type: 'fallback_status',
                    message: `SignalHire failed (${signalHireError.message}), trying ContactOut fallback for ${batch.length} profiles...`
                  })}\n\n`);

                  // Fallback to ContactOut enrichment
                  try {
                    const contactOutService = require('../services/contactOutService');

                    // Validate LinkedIn URLs before attempting ContactOut
                    const validUrls = batch.filter(url => url && url.includes('linkedin.com/in/'));
                    const invalidUrls = batch.filter(url => !url || !url.includes('linkedin.com/in/'));

                    if (invalidUrls.length > 0) {
                      console.warn(`Skipping ${invalidUrls.length} invalid URLs for ContactOut:`, invalidUrls);
                    }

                    if (validUrls.length === 0) {
                      console.warn('No valid LinkedIn URLs for ContactOut fallback');
                      res.write(`data: ${JSON.stringify({
                        type: 'fallback_status',
                        message: `No valid LinkedIn URLs for ContactOut fallback`
                      })}\n\n`);

                      // Create failed requests for all URLs
                      await Promise.all(batch.map(url => profileService.createRequest(uuidv4(), url).catch(e => console.error(`DB request failed for ${url}`, e))));
                      return;
                    }

                    console.log(`Attempting ContactOut enrichment for ${validUrls.length} valid URLs`);
                    const fallbackResults = await contactOutService.batchEnrichProfiles(validUrls);

                    if (fallbackResults.success && fallbackResults.results.length > 0) {
                      const successfulResults = fallbackResults.results.filter(r => r.success);
                      const failedResults = fallbackResults.results.filter(r => !r.success);

                      console.log(`ContactOut fallback: ${successfulResults.length} successful, ${failedResults.length} failed`);

                      // Send success status update
                      res.write(`data: ${JSON.stringify({
                        type: 'fallback_success',
                        message: `ContactOut fallback successful for ${successfulResults.length}/${validUrls.length} profiles`
                      })}\n\n`);

                      // Save ContactOut results
                      const savePromises = fallbackResults.results.map(async (result) => {
                        try {
                          if (result.success && result.profile) {
                            // Create the request first
                            await profileService.createRequest(uuidv4(), result.linkedinUrl);

                            // Then update it with the enriched data
                            await profileService.updateRequestStatusByUrl(
                              result.linkedinUrl,
                              'success',
                              {
                                ...result.profile,
                                enrichmentSource: 'contactout_fallback',
                                fallbackUsed: true,
                                originalError: signalHireError.message
                              }
                            );

                            console.log(`✅ ContactOut data saved for: ${result.linkedinUrl}`);
                          } else {
                            // Create failed request for ContactOut failures
                            await profileService.createRequest(uuidv4(), result.linkedinUrl);
                            console.warn(`❌ ContactOut failed for ${result.linkedinUrl}: ${result.message || result.error}`);
                          }
                        } catch (saveError) {
                          console.error(`💥 Save error for ${result.linkedinUrl}:`, saveError.message);
                          // Try to create a basic request so it doesn't get lost
                          try {
                            await profileService.createRequest(uuidv4(), result.linkedinUrl);
                          } catch (createError) {
                            console.error(`💥 Failed to create request for ${result.linkedinUrl}:`, createError.message);
                          }
                        }
                      });

                      await Promise.allSettled(savePromises); // Use allSettled to handle individual save failures

                      // Handle any invalid URLs that were skipped
                      if (invalidUrls.length > 0) {
                        const invalidPromises = invalidUrls.map(url =>
                          profileService.createRequest(uuidv4(), url).catch(e => console.error(`DB request failed for invalid URL ${url}`, e))
                        );
                        await Promise.allSettled(invalidPromises);
                      }

                    } else {
                      console.warn('ContactOut fallback returned no successful results');
                      res.write(`data: ${JSON.stringify({
                        type: 'fallback_failed',
                        message: `ContactOut fallback failed - no successful results returned`
                      })}\n\n`);

                      // Create failed requests for all URLs
                      await Promise.allSettled(batch.map(url => profileService.createRequest(uuidv4(), url).catch(e => console.error(`DB request failed for ${url}`, e))));
                    }

                  } catch (contactOutError) {
                    console.error('ContactOut fallback exception:', contactOutError.message);

                    // Send error status update
                    res.write(`data: ${JSON.stringify({
                      type: 'fallback_failed',
                      message: `ContactOut fallback failed: ${contactOutError.message}`
                    })}\n\n`);

                    // Create failed requests so the polling logic can handle timeouts
                    await Promise.allSettled(batch.map(url => profileService.createRequest(uuidv4(), url).catch(e => console.error(`DB request failed for ${url}`, e))));
                  }
                }
              }));
            }
          }

          // Batch process enrichment requests for Profile IDs with ContactOut fallback
          if (idsToEnrich.length > 0) {
            for (let i = 0; i < idsToEnrich.length; i += BATCH_SIZE) {
              const batch = idsToEnrich.slice(i, i + BATCH_SIZE);
              batchPromises.push(limit(async () => {
                try {
                  // Try SignalHire first
                  await signalHireService.searchProfiles(batch, callbackUrl, {}, false);
                  await Promise.all(batch.map(id => profileService.createRequest(uuidv4(), null, id).catch(e => console.error(`DB request failed for ${id}`, e))));
                } catch (signalHireError) {
                  console.warn('SignalHire batch failed for profile IDs, fallback not available for IDs:', signalHireError.message);

                  // Send status update about ProfileID limitation
                  res.write(`data: ${JSON.stringify({
                    type: 'fallback_status',
                    message: `SignalHire failed for Profile IDs (${signalHireError.message}). Icypeas fallback requires LinkedIn URLs, not Profile IDs.`
                  })}\n\n`);

                  // Icypeas requires LinkedIn URLs, so we can't fall back for profile IDs
                  // Create failed requests so the polling logic can handle timeouts
                  const createPromises = batch.map(async (id) => {
                    try {
                      await profileService.createRequest(uuidv4(), null, id);
                      console.log(`Created pending request for Profile ID: ${id}`);
                    } catch (createError) {
                      console.error(`Failed to create request for Profile ID ${id}:`, createError.message);
                    }
                  });

                  await Promise.allSettled(createPromises);
                }
              }));
            }
          }

          await Promise.all(batchPromises);

          // Polling logic for newly requested profiles
          const maxWaitTime = 120000;
          const pollInterval = 3000;
          const startTime = Date.now();

          while ((completedCount < totalCount) && (Date.now() - startTime < maxWaitTime)) {
            const availableProfiles = await ProfileRequest.find({
              $or: [
                { linkedinUrl: { $in: urlsToEnrich }, status: 'success' },
                { profileId: { $in: idsToEnrich }, status: 'success' }
              ]
            });

            for (const profileDoc of availableProfiles) {
              const identifier = profileDoc.linkedinUrl || profileDoc.profileId;
              if (processedIdentifiers.has(identifier)) continue;
              await processExistingProfile(profileDoc); // Reuse the same processing logic
            }
            if (completedCount < totalCount) {
              await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
          }
        }
      }

      // Handle any remaining unprocessed identifiers (timeouts)
      const allRequestedIdentifiers = [...linkedinUrls, ...profileIds, ...enrichedProfiles.map(p => p.id || p.contactOutData?.li_vanity)];
      for (const identifier of allRequestedIdentifiers) {
        // Normalize linkedinUrl before checking if it was processed
        const normalizedIdentifier = identifier && identifier.startsWith('http') ? normalizeLinkedinUrl(identifier) : identifier;
        if (normalizedIdentifier && !processedIdentifiers.has(normalizedIdentifier)) {
          completedCount++;
          processedIdentifiers.add(normalizedIdentifier); // Mark as processed to avoid duplicates
          res.write(`data: ${JSON.stringify({
            type: 'error', identifier: identifier, error: 'Profile processing timed out', status: 'failed',
            progress: { completed: completedCount, total: totalCount }
          })}\n\n`);
        }
      }

      // Send completion message
      res.write(`data: ${JSON.stringify({ type: 'complete', message: 'Deep analysis complete', totalProcessed: completedCount })}\n\n`);
      res.end();

    } catch (error) {
      console.error('❌ Deep analyze stream failed:', error);
      if (!res.headersSent) {
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
          success: false,
          error: 'Failed to start deep analyze stream',
          details: error.message
        });
      } else {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: 'Stream failed',
          error: error.message
        })}\n\n`);
        res.end();
      }
    }
  }
);


router.post(
  '/get-linkedin-urls',
  authenticateUser,
  checkCredits,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { profileIds = [] } = req.body;

      // Check that at least one profileId is provided
      if (profileIds.length === 0) {
        return res.status(400).json({
          error: 'At least one profileId must be provided'
        });
      }

      // Find already enriched profiles by IDs
      const existingByIds = await ProfileRequest.find({
        profileId: { $in: profileIds },
        status: 'success'
      });

      // For get-linkedin-urls, we need profiles with LinkedIn URL in social data
      const existingIdsWithLinkedIn = new Set();

      existingByIds.forEach(profile => {
        if (profile.data && profile.data.social && Array.isArray(profile.data.social)) {
          const hasLinkedIn = profile.data.social.some(social =>
            (social.type === 'li' || social.type === 'linkedin') && social.link
          );
          if (hasLinkedIn) {
            existingIdsWithLinkedIn.add(profile.profileId);
          }
        }
      });

      // Filter IDs that need enrichment (those without existing LinkedIn data)
      const idsToEnrich = profileIds.filter(id => !existingIdsWithLinkedIn.has(id));

      // Consume credits for the operation - consume for all profiles regardless of existing data
      await creditService.consumeCredits(req.user.userId, `GET LINKEDIN URLS FOR ${profileIds.length} PROFILES`, profileIds.length);

      const callbackUrl = `${process.env.API_BASE_URL}/api/callback/signalhire`;

      // Batch size for SignalHire enrichment requests
      const BATCH_SIZE = 10;

      // Limit concurrency to 3 batches at a time
      const pLimit = require('p-limit');
      const limit = pLimit.default(3);

      const batchPromises = [];

      // Handle Profile IDs enrichment
      for (let i = 0; i < idsToEnrich.length; i += BATCH_SIZE) {
        const batch = idsToEnrich.slice(i, i + BATCH_SIZE);
        batchPromises.push(limit(async () => {
          await signalHireService.searchProfiles(batch, callbackUrl, {}, false); // withoutContacts: true for LinkedIn URL retrieval

          // Save requests in DB with status pending concurrently
          const insertPromises = batch.map(profileId => {
            const uniqueRequestId = require('uuid').v4();
            return ProfileRequest.create({
              requestId: uniqueRequestId,
              profileId,
              status: 'pending',
              data: null
            }).catch(error => {
              console.error(`Error storing request for ${profileId}:`, error);
            });
          });
          await Promise.all(insertPromises);
        }));
      }

      await Promise.all(batchPromises);

      // Polling function to check enrichment completion for profile IDs
      const pollEnrichmentCompletion = async (ids, maxRetries = 30, intervalMs = 5000) => {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Find profiles by IDs
            const profileDocsByIds = await ProfileRequest.find({
              profileId: { $in: ids },
              status: 'success'
            });

            // Map identifiers to profileDocs for quick lookup
            const profileMapById = new Map(profileDocsByIds.map(doc => [doc.profileId, doc]));

            // Check if all profiles are present and have data WITH LinkedIn URLs
            const allIdsCompleted = ids.every(id => {
              const doc = profileMapById.get(id);
              if (!doc || !doc.data) return false;

              // Check if profile has LinkedIn URL in social data
              if (doc.data.social && Array.isArray(doc.data.social)) {
                return doc.data.social.some(social =>
                  (social.type === 'li' || social.type === 'linkedin') && social.link
                );
              }
              return false;
            });

            if (allIdsCompleted) {
              // Return profileDocs in the order of ids
              const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: profileMapById.get(id) }));
              return idResults;
            }

            // If we're past the minimum wait time, also accept profiles with data (even if no LinkedIn URL)
            if (attempt >= 15) { // After 75 seconds, accept any profiles with data
              const allIdsHaveData = ids.every(id => {
                const doc = profileMapById.get(id);
                return doc && doc.data;
              });

              if (allIdsHaveData) {
                const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: profileMapById.get(id) }));
                return idResults;
              }
            }
          } catch (error) {
            console.error('Error fetching profiles:', error);
          }

          // Wait before next attempt
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        // Return whatever is available after max retries
        try {
          const profileDocsByIds = await ProfileRequest.find({
            profileId: { $in: ids },
            status: 'success'
          });

          const profileMapById = new Map(profileDocsByIds.map(doc => [doc.profileId, doc]));
          const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: profileMapById.get(id) }));
          return idResults;
        } catch (error) {
          console.error('Error fetching profiles after max retries:', error);
          const idResults = ids.map(id => ({ type: 'id', identifier: id, doc: null }));
          return idResults;
        }
      };

      // Poll for enrichment completion
      const profileResults = await pollEnrichmentCompletion(profileIds);

      const results = [];

      profileResults.forEach((result) => {
        if (!result.doc || !result.doc.data) {
          results.push({
            profileId: result.identifier,
            linkedinUrl: null,
            fullName: null,
            error: 'Profile not found or incomplete',
            status: 'failed'
          });
        } else {
          // Extract LinkedIn URL from social links
          let linkedinUrl = null;
          if (result.doc.data.social && Array.isArray(result.doc.data.social)) {
            const linkedinSocial = result.doc.data.social.find(social =>
              (social.type === 'li' || social.type === 'linkedin') && social.link
            );
            if (linkedinSocial && linkedinSocial.link) {
              linkedinUrl = linkedinSocial.link;
            }
          }

          results.push({
            profileId: result.identifier,
            linkedinUrl: linkedinUrl,
            fullName: result.doc.data?.fullName || null,
            status: linkedinUrl ? 'success' : 'no_linkedin_url_found'
          });
        }
      });

      return res.status(200).json({
        success: true,
        results,
        message: `Retrieved LinkedIn URLs for ${results.length} profiles`
      });

    } catch (error) {
      console.error('Error in /get-linkedin-urls:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to get LinkedIn URLs',
        details: error.message
      });
    }
  }
);

// Profile enrichment routes with ContactOut fallback
router.post('/enrich-profile', authenticateUser, checkCredits, profileController.enrichProfile);
router.post('/batch-enrich-profiles', authenticateUser, checkCredits, profileController.batchEnrichProfiles);
router.get('/profile-by-url/:encodedUrl', authenticateUser, profileController.getProfile);
router.post('/evaluate-profile', authenticateUser, checkCredits, profileController.evaluateProfile);

module.exports = router;


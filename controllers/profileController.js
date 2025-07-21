const profileService = require('../services/profileService');
const signalHireService = require('../services/signalHireService');

exports.getProfile = async (req, res) => {
  try {
    const { url } = req.params;
    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    const normalizedUrl = profileService.normalizeLinkedInUrl(url);
    const profile = await profileService.getProfileByUrl(normalizedUrl);

    return res.json(profile);
  } catch (error) {
    console.error('Error retrieving profile:', error);
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
};

exports.enrichProfile = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    const normalizedUrl = profileService.normalizeLinkedInUrl(url);

    // Use the new enrichment method with ContactOut fallback
    const enrichmentResult = await signalHireService.enrichProfileWithFallback(normalizedUrl);

    if (enrichmentResult.success) {
      return res.json({
        success: true,
        profile: enrichmentResult.profile,
        source: enrichmentResult.source,
        enrichmentMethod: enrichmentResult.enrichmentMethod || enrichmentResult.source
      });
    } else {
      return res.status(500).json({
        success: false,
        error: enrichmentResult.error,
        details: enrichmentResult.contactOutError || enrichmentResult.details,
        signalHireError: enrichmentResult.signalHireError
      });
    }

  } catch (error) {
    console.error('Error enriching profile:', error);
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
};

exports.evaluateProfile = async (req, res) => {
  try {
    const { url, criteria } = req.body;
    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    if (!criteria) {
      return res.status(400).json({ error: "No evaluation criteria provided" });
    }

    const normalizedUrl = profileService.normalizeLinkedInUrl(url);
    const evaluation = await profileService.evaluateProfile(normalizedUrl, criteria);

    return res.json(evaluation);
  } catch (error) {
    console.error('Error evaluating profile:', error);
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
};

// New batch enrichment controller with fallback support
exports.batchEnrichProfiles = async (req, res) => {
  try {
    const { urls, options = {} } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        error: "URLs array is required and must not be empty"
      });
    }

    // Normalize all URLs
    const normalizedUrls = urls.map(url => profileService.normalizeLinkedInUrl(url));

    console.log(`Starting batch enrichment for ${normalizedUrls.length} profiles with ContactOut fallback`);

    // Use the new batch enrichment with fallback
    const batchResult = await signalHireService.batchEnrichProfilesWithFallback(normalizedUrls, options);

    return res.json({
      success: batchResult.success,
      results: batchResult.results,
      summary: {
        ...batchResult.summary,
        requestedUrls: urls.length,
        processedUrls: normalizedUrls.length
      },
      fallbackInfo: {
        contactOutFallbacks: batchResult.summary.contactOutFallbacks,
        fallbackRate: ((batchResult.summary.contactOutFallbacks / batchResult.summary.successful) * 100).toFixed(1) + '%'
      }
    });

  } catch (error) {
    console.error('Error in batch profile enrichment:', error);
    return res.status(500).json({
      success: false,
      error: error.message || "Unknown error",
      details: "Batch enrichment failed"
    });
  }
};
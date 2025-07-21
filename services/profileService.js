const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const openaiService = require('./openaiService');
const ProfileRequest = require('../models/ProfileRequest');

const PROFILES_DIR = path.join(__dirname, '../data/profiles');
const REQUESTS_DIR = path.join(__dirname, '../data/requests');

// In-memory cache for profiles
const profileCache = new Map();

exports.normalizeLinkedInUrl = (url) => {
  // Remove query parameters and trailing slashes
  let normalizedUrl = url.split('?')[0];
  normalizedUrl = normalizedUrl.replace(/\/$/, '');

  // Ensure it's a linkedin.com/in/ URL
  if (!normalizedUrl.includes('linkedin.com/in/')) {
    throw new Error('Not a valid LinkedIn profile URL');
  }

  return normalizedUrl;
};

exports.getProfileByUrl = async (url) => {
  try {
    const normalizedUrl = this.normalizeLinkedInUrl(url);

    // Check in-memory cache first
    if (profileCache.has(normalizedUrl)) {
      return profileCache.get(normalizedUrl);
    }

    // Create a filename from the URL
    const filename = `${Buffer.from(normalizedUrl).toString('base64')}.json`;
    const filePath = path.join(PROFILES_DIR, filename);

    // Check if we have cached data on disk
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const profile = JSON.parse(data);

      // Update in-memory cache
      profileCache.set(normalizedUrl, profile);

      return profile;
    } catch (err) {
      // File doesn't exist or other error
      return { url: normalizedUrl, name: "", title: "", company: "", location: "" };
    }
  } catch (error) {
    console.error('Error getting profile by URL:', error);
    throw error;
  }
};

exports.saveProfile = async (profile) => {
  try {
    // Ensure the profile has a URL
    if (!profile.url) {
      throw new Error('Profile must have a URL');
    }

    const normalizedUrl = this.normalizeLinkedInUrl(profile.url);
    profile.url = normalizedUrl;

    // Update in-memory cache
    profileCache.set(normalizedUrl, profile);

    // Ensure the directory exists
    await fs.mkdir(PROFILES_DIR, { recursive: true });

    // Create a filename from the URL
    const filename = `${Buffer.from(normalizedUrl).toString('base64')}.json`;
    const filePath = path.join(PROFILES_DIR, filename);

    // Save the profile data
    await fs.writeFile(filePath, JSON.stringify(profile, null, 2));

    return true;
  } catch (error) {
    console.error('Error saving profile:', error);
    throw error;
  }
};

exports.enrichProfileData = async (profile) => {
  try {
    if (!profile || !profile.url) {
      throw new Error('Invalid profile data');
    }

    // Extract additional data if needed
    if (!profile.name || !profile.title || !profile.company) {
      const enhancedData = await openaiService.extractProfileDataFromUrl(profile.url);
      profile = { ...profile, ...enhancedData };
    }

    return profile;
  } catch (error) {
    console.error('Error enriching profile data:', error);
    throw error;
  }
};

exports.getJobTitle = (profile) => {
  if (!profile || !profile.title) return '';

  // Clean and normalize the job title
  let title = profile.title.trim();

  // Remove geographical regions
  title = title.replace(/\b(?:emea|europe|nordic|nordics|dach|northern europe|southern europe)\b/i, '').trim();

  // Remove parenthetical content
  title = title.replace(/\([^)]*\)/g, '').trim();

  return title;
};

exports.getCurrentCompany = (profile) => {
  if (!profile || !profile.company) return '';

  // Clean and normalize the company name
  let company = profile.company.trim();

  // Check against verified companies list
  const verifiedCompanies = require('../config/verifiedCompanies');

  for (const verifiedCompany of verifiedCompanies) {
    if (company.toLowerCase().includes(verifiedCompany.toLowerCase())) {
      return verifiedCompany;
    }
  }

  return company;
};

exports.getLocation = (profile) => {
  if (!profile || !profile.location) return '';

  // Clean and normalize the location
  let location = profile.location.trim();

  // Check against verified locations
  const verifiedLocations = require('../config/verifiedLocations');

  // Check cities
  for (const city of verifiedLocations.cities) {
    if (location.toLowerCase().includes(city.toLowerCase())) {
      return city;
    }
  }

  // Check countries
  for (const country of verifiedLocations.countries) {
    if (location.toLowerCase().includes(country.toLowerCase())) {
      return country;
    }
  }

  return location;
};

exports.formatExperience = (experience) => {
  if (!experience || !Array.isArray(experience)) return [];

  return experience.map(job => ({
    title: job.title || '',
    company: job.company || '',
    startDate: job.startDate || '',
    endDate: job.endDate || 'Present',
    duration: job.duration || '',
    description: job.description || ''
  }));
};

exports.formatEducation = (education) => {
  if (!education || !Array.isArray(education)) return [];

  return education.map(edu => ({
    school: edu.school || '',
    degree: edu.degree || '',
    field: edu.field || '',
    startDate: edu.startDate || '',
    endDate: edu.endDate || '',
    description: edu.description || ''
  }));
};

exports.evaluateProfile = async (url, criteria) => {
  try {
    // Get the profile data
    const profile = await this.getProfileByUrl(url);

    // Enrich the profile data if needed
    const enrichedProfile = await this.enrichProfileData(profile);

    // Evaluate against criteria
    const evaluation = {
      score: 0,
      matchedCriteria: [],
      unmatchedCriteria: []
    };

    // Title matching
    if (criteria.titles && criteria.titles.length > 0 && enrichedProfile.title) {
      const jobTitle = this.getJobTitle(enrichedProfile);

      const titleMatches = criteria.titles.some(title =>
        jobTitle.toLowerCase().includes(title.toLowerCase())
      );

      if (titleMatches) {
        evaluation.score += 30;
        evaluation.matchedCriteria.push('title');
      } else {
        evaluation.unmatchedCriteria.push('title');
      }
    }

    // Company matching
    if (criteria.companies && criteria.companies.length > 0 && enrichedProfile.company) {
      const company = this.getCurrentCompany(enrichedProfile);

      const companyMatches = criteria.companies.some(companyName =>
        company.toLowerCase().includes(companyName.toLowerCase())
      );

      if (companyMatches) {
        evaluation.score += 30;
        evaluation.matchedCriteria.push('company');
      } else {
        evaluation.unmatchedCriteria.push('company');
      }
    }

    // Location matching
    if (criteria.locations && criteria.locations.length > 0 && enrichedProfile.location) {
      const location = this.getLocation(enrichedProfile);

      const locationMatches = criteria.locations.some(loc =>
        location.toLowerCase().includes(loc.toLowerCase())
      );

      if (locationMatches) {
        evaluation.score += 20;
        evaluation.matchedCriteria.push('location');
      } else {
        evaluation.unmatchedCriteria.push('location');
      }
    }

    // Skills matching
    if (criteria.skills && criteria.skills.length > 0 && enrichedProfile.skills) {
      const skillMatches = criteria.skills.filter(skill =>
        enrichedProfile.skills.some(profileSkill =>
          profileSkill.toLowerCase().includes(skill.toLowerCase())
        )
      );

      if (skillMatches.length > 0) {
        const skillScore = Math.min(20, skillMatches.length * 5);
        evaluation.score += skillScore;
        evaluation.matchedCriteria.push('skills');
      } else {
        evaluation.unmatchedCriteria.push('skills');
      }
    }

    // Save the evaluation results
    enrichedProfile.evaluation = evaluation;
    await this.saveProfile(enrichedProfile);

    return { profile: enrichedProfile, evaluation };
  } catch (error) {
    console.error('Error evaluating profile:', error);
    throw error;
  }
};

// Get all profiles
exports.getAllProfiles = async () => {
  try {
    // Ensure the directory exists
    await fs.mkdir(PROFILES_DIR, { recursive: true });

    // Get all profile files
    const files = await fs.readdir(PROFILES_DIR);

    // Read each file and parse the JSON
    const profiles = await Promise.all(
      files
        .filter(file => file.endsWith('.json'))
        .map(async file => {
          const filePath = path.join(PROFILES_DIR, file);
          const data = await fs.readFile(filePath, 'utf8');
          return JSON.parse(data);
        })
    );

    return profiles;
  } catch (error) {
    console.error('Error getting all profiles:', error);
    throw error;
  }
};

// Delete a profile
exports.deleteProfile = async (url) => {
  try {
    const normalizedUrl = this.normalizeLinkedInUrl(url);

    // Remove from in-memory cache
    profileCache.delete(normalizedUrl);

    // Create a filename from the URL
    const filename = `${Buffer.from(normalizedUrl).toString('base64')}.json`;
    const filePath = path.join(PROFILES_DIR, filename);

    // Delete the file
    await fs.unlink(filePath);

    return true;
  } catch (error) {
    console.error('Error deleting profile:', error);
    throw error;
  }
};

// Search profiles by criteria
exports.searchProfiles = async (criteria) => {
  try {
    // Get all profiles
    const profiles = await this.getAllProfiles();

    // Filter profiles based on criteria
    const filteredProfiles = profiles.filter(profile => {
      let matches = true;

      // Filter by title
      if (criteria.titles && criteria.titles.length > 0) {
        const jobTitle = this.getJobTitle(profile);
        const titleMatches = criteria.titles.some(title =>
          jobTitle.toLowerCase().includes(title.toLowerCase())
        );
        if (!titleMatches) matches = false;
      }

      // Filter by company
      if (matches && criteria.companies && criteria.companies.length > 0) {
        const company = this.getCurrentCompany(profile);
        const companyMatches = criteria.companies.some(companyName =>
          company.toLowerCase().includes(companyName.toLowerCase())
        );
        if (!companyMatches) matches = false;
      }

      // Filter by location
      if (matches && criteria.locations && criteria.locations.length > 0) {
        const location = this.getLocation(profile);
        const locationMatches = criteria.locations.some(loc =>
          location.toLowerCase().includes(loc.toLowerCase())
        );
        if (!locationMatches) matches = false;
      }

      // Filter by skills
      if (matches && criteria.skills && criteria.skills.length > 0 && profile.skills) {
        const skillMatches = criteria.skills.some(skill =>
          profile.skills.some(profileSkill =>
            profileSkill.toLowerCase().includes(skill.toLowerCase())
          )
        );
        if (!skillMatches) matches = false;
      }

      return matches;
    });

    return filteredProfiles;
  } catch (error) {
    console.error('Error searching profiles:', error);
    throw error;
  }
};

// Extract profile data from LinkedIn URL
exports.extractProfileFromUrl = async (url) => {
  try {
    const normalizedUrl = this.normalizeLinkedInUrl(url);

    // Check if we already have this profile
    const existingProfile = await this.getProfileByUrl(normalizedUrl);
    if (existingProfile.name && existingProfile.title && existingProfile.company) {
      return existingProfile;
    }

    // Extract profile data using OpenAI
    const profileData = await openaiService.extractProfileDataFromUrl(normalizedUrl);

    // Create a new profile object
    const profile = {
      url: normalizedUrl,
      name: profileData.name || '',
      title: profileData.title || '',
      company: profileData.company || '',
      location: profileData.location || '',
      skills: profileData.skills || [],
      experience: this.formatExperience(profileData.experience),
      education: this.formatEducation(profileData.education),
      extractedAt: new Date().toISOString()
    };

    // Save the profile
    await this.saveProfile(profile);

    return profile;
  } catch (error) {
    console.error('Error extracting profile from URL:', error);
    throw error;
  }
};

// Analyze profile text
exports.analyzeProfileText = async (text) => {
  try {
    // Use OpenAI to analyze the profile text
    const analysis = await openaiService.analyzeProfileText(text);

    return analysis;
  } catch (error) {
    console.error('Error analyzing profile text:', error);
    throw error;
  }
};

exports.getPendingRequestByUrl = async (url) => {
  try {
    const normalizedUrl = this.normalizeLinkedInUrl(url);

    // Ensure the directory exists
    await fs.mkdir(REQUESTS_DIR, { recursive: true });

    // Get all request files
    const files = await fs.readdir(REQUESTS_DIR);

    // Read each file and check if it's a pending request for this URL
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(REQUESTS_DIR, file);
      const data = await fs.readFile(filePath, 'utf8');
      const request = JSON.parse(data);

      // Check if this is a pending request for the URL
      if (request.status === 'pending' && request.url === normalizedUrl) {
        return request;
      }
    }

    // No pending request found
    return null;
  } catch (error) {
    console.error('Error getting pending request by URL:', error);
    throw error;
  }
};

exports.saveRequest = async (request) => {
  try {
    // Ensure the directory exists
    await fs.mkdir(REQUESTS_DIR, { recursive: true });

    // Create a filename from the requestId
    const filename = `${request.requestId}.json`;
    const filePath = path.join(REQUESTS_DIR, filename);

    // Save the request data
    await fs.writeFile(filePath, JSON.stringify(request, null, 2));

    return true;
  } catch (error) {
    console.error('Error saving request:', error);
    throw error;
  }
};

// exports.getRequestById = async (requestId) => {
//   try {
//     // Create a filename from the requestId
//     const filename = `${requestId}.json`;
//     const filePath = path.join(REQUESTS_DIR, filename);

//     // Check if we have the request
//     try {
//       const data = await fs.readFile(filePath, 'utf8');
//       return JSON.parse(data);
//     } catch (err) {
//       // File doesn't exist or other error
//       return null;
//     }
//   } catch (error) {
//     console.error('Error getting request by ID:', error);
//     throw error;
//   }
// };

// exports.updateRequestStatus = async (requestId, status, data = {}) => {
//   try {
//     // Get the existing request
//     const request = await this.getRequestById(requestId);

//     if (!request) {
//       throw new Error(`Request with ID ${requestId} not found`);
//     }

//     // Update the request
//     request.status = status;
//     request.updatedAt = new Date().toISOString();

//     // Add any additional data
//     Object.assign(request, data);

//     // Save the updated request
//     await this.saveRequest(request);

//     return request;
//   } catch (error) {
//     console.error('Error updating request status:', error);
//     throw error;
//   }
// };

// exports.createRequest = async (requestId, linkedinUrl) => {
//   const normalizedUrl = normalizeLinkedInUrl(linkedinUrl);
//   const newRequest = new ProfileRequest({ requestId, linkedinUrl: normalizedUrl });
//   return await newRequest.save();
// };
exports.createRequest = async (requestId, linkedinUrl, profileId = null) => {
  const payload = { requestId };

  if (linkedinUrl) {
    const normalizedUrl = normalizeLinkedInUrl(linkedinUrl);
    payload.linkedinUrl = normalizedUrl;
  }

  if (profileId) {
    payload.profileId = profileId;
  }

  const newRequest = new ProfileRequest(payload);
  return await newRequest.save();
};

exports.getRequestById = async (requestId) => {
  return await ProfileRequest.findOne({ requestId });
};

exports.updateRequestStatusByUrl = async (linkedinUrl, status, data = null) => {
  const normalizedUrl = normalizeLinkedInUrl(linkedinUrl);
  // Use regex to find any linkedinUrl that starts with the normalizedUrl
  const escapedUrl = normalizedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedUrl}(\\/.*)?$`, 'i');
  return await ProfileRequest.findOneAndUpdate(
    { linkedinUrl: { $regex: regex } },
    { status, data, updatedAt: new Date() },
    { new: true }
  );
};

exports.updateRequestStatusByProfileId = async (profileId, status, data = null) => {
  return await ProfileRequest.findOneAndUpdate(
    { profileId },
    { status, data, updatedAt: new Date() },
    { new: true }
  );
};

const normalizeLinkedInUrl = (url) => {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, ''); // trim trailing slash
    return `https://www.linkedin.com${pathname}`;
  } catch (err) {
    return url; // fallback
  }
};


exports.getRequestByUrl = async (linkedinUrl) => {
  const normalizedUrl = normalizeLinkedInUrl(linkedinUrl);
  console.log('Normalized LinkedIn URL:', normalizedUrl);
  // Use regex to find any linkedinUrl that starts with the normalizedUrl
  const regex = new RegExp(`^${normalizedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return await ProfileRequest.findOne({ linkedinUrl: { $regex: regex } });
};
exports.getRequestByProfileId = async (profileId) => {
  return await ProfileRequest.findOne({ profileId });
};

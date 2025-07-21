/**
 * Helper functions for LinkedIn profile data extraction
 */

// Helper function to normalize LinkedIn URLs
exports.normalizeLinkedInUrl = (url) => {
  if (!url) return '';
  
  try {
    // Add https:// if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    // Parse the URL to handle it properly
    const urlObj = new URL(url);
    
    // Make sure it's a linkedin.com URL
    if (!urlObj.hostname.includes('linkedin.com')) {
      console.warn('Not a LinkedIn URL:', url);
      return url; // Return as is if not LinkedIn
    }
    
    // Clean up the path to just keep the profile part
    let path = urlObj.pathname;
    
    // Remove trailing slash
    if (path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    
    // Get just /in/username or /pub/username part
    const pathParts = path.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      // Keep only first two parts (e.g., 'in' and 'username')
      path = '/' + pathParts.slice(0, 2).join('/');
    }
    
    // Build clean URL without query parameters or fragments
    return `https://www.linkedin.com${path}`;
  } catch (error) {
    console.error('Error normalizing LinkedIn URL:', error);
    return url; // Return original if parsing fails
  }
};

// Helper function to get job title from profile
exports.getJobTitle = (profile) => {
  if (!profile || !profile.experience || !profile.experience.length) {
    return 'Unknown';
  }
  
  // Sort by date (most recent first)
  const sortedExperience = [...profile.experience].sort((a, b) => {
    const dateA = a.dateRange?.end ? new Date(a.dateRange.end) : new Date();
    const dateB = b.dateRange?.end ? new Date(b.dateRange.end) : new Date();
    return dateB - dateA;
  });
  
  // Return the title of the most recent job
  return sortedExperience[0].title || 'Unknown';
};

// Helper function to get current company from profile
exports.getCurrentCompany = (profile) => {
  if (!profile || !profile.experience || !profile.experience.length) {
    return 'Unknown';
  }
  
  // Find current position (no end date or most recent)
  const currentPosition = profile.experience.find(exp => 
    !exp.dateRange?.end || exp.dateRange.end === 'Present'
  );
  
  if (currentPosition) {
    return currentPosition.company || 'Unknown';
  }
  
  // If no current position found, return the most recent
  const sortedExperience = [...profile.experience].sort((a, b) => {
    const dateA = a.dateRange?.end ? new Date(a.dateRange.end) : new Date();
    const dateB = b.dateRange?.end ? new Date(b.dateRange.end) : new Date();
    return dateB - dateA;
  });
  
  return sortedExperience[0].company || 'Unknown';
};

// Helper function to get email from profile
exports.getEmail = (profile) => {
  if (!profile || !profile.contactInfo || !profile.contactInfo.email) {
    return '';
  }
  return profile.contactInfo.email;
};

// Helper function to get phone from profile
exports.getPhone = (profile) => {
  if (!profile || !profile.contactInfo || !profile.contactInfo.phone) {
    return '';
  }
  return profile.contactInfo.phone;
};

// Helper function to get location from profile
exports.getLocation = (profile) => {
  if (!profile || !profile.location) {
    return 'Unknown';
  }
  return profile.location;
};

// Helper function to format experience
exports.formatExperience = (experience) => {
  if (!experience || !Array.isArray(experience)) {
    return [];
  }
  
  return experience.map(exp => ({
    title: exp.title || 'Unknown Title',
    company: exp.company || 'Unknown Company',
    dateRange: exp.dateRange || { start: '', end: '' },
    description: exp.description || ''
  }));
};

// Helper function to format education
exports.formatEducation = (education) => {
  if (!education || !Array.isArray(education)) {
    return [];
  }
  
  return education.map(edu => ({
    school: edu.school || 'Unknown School',
    degree: edu.degree || '',
    field: edu.field || '',
    dateRange: edu.dateRange || { start: '', end: '' }
  }));
};
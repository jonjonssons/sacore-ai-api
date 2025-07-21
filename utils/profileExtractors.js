// Move the profile extraction logic from frontend to backend

exports.extractName = (title, snippet) => {
  // Implementation based on your frontend logic
  if (!title) return "";
  
  // Basic name extraction logic
  const nameMatch = title.match(/^([^-|–—]+)/);
  if (nameMatch) {
    return nameMatch[1].trim();
  }
  
  return "";
};

exports.extractTitle = (title, snippet) => {
  // Implementation based on your frontend logic
  if (!snippet) return "";
  
  // Basic title extraction logic
  const titlePattern = /(?:is|as|a|an)\s+([^,\.]+)(?:at|in|with|for)/i;
  const match = snippet.match(titlePattern);
  
  if (match) {
    return match[1].trim();
  }
  
  return "";
};

exports.extractCompany = (title, snippet) => {
  // Implementation based on your frontend logic
  if (!snippet) return "";
  
  // Basic company extraction logic
  const companyPattern = /(?:at|with|for)\s+([^,\.]+)/i;
  const match = snippet.match(companyPattern);
  
  if (match) {
    return match[1].trim();
  }
  
  return "";
};

exports.extractLocation = (title, snippet) => {
  // Implementation based on your frontend logic
  if (!snippet) return "";
  
  // Basic location extraction logic
  const locationPattern = /(?:in|from)\s+([^,\.]+)(?:,|\.|\s+|$)/i;
  const match = snippet.match(locationPattern);
  
  if (match) {
    return match[1].trim();
  }
  
  return "";
};
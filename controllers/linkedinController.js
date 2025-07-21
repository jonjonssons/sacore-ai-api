const linkedinService = require('../services/linkedinService');
const openaiService = require('../services/openaiService');

exports.retrieveData = async (req, res) => {
  try {
    const { title, snippet, url } = req.body;
    
    if (!title && !snippet && !url) {
      return res.status(400).json({ 
        error: "No title, snippet, or URL provided" 
      });
    }
    
    let extractedData;
    if (url) {
      extractedData = await linkedinService.extractDataFromUrl(url);
    } else {
      extractedData = await openaiService.extractProfileData(title, snippet);
    }
    
    return res.json(extractedData);
  } catch (error) {
    console.error('Error retrieving LinkedIn data:', error);
    return res.status(500).json({ 
      error: error.message || "Unknown error" 
    });
  }
};

exports.checkStatus = async (req, res) => {
  try {
    const status = await linkedinService.checkStatus();
    return res.json({ available: status });
  } catch (error) {
    console.error('Error checking LinkedIn status:', error);
    return res.status(500).json({ 
      error: error.message || "Unknown error",
      available: false
    });
  }
};
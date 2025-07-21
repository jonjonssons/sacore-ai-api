const proxyService = require('../services/proxyService');

exports.proxyRequest = async (req, res) => {
  try {
    const { url, method, headers, body } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }
    
    const response = await proxyService.makeRequest(url, method, headers, body);
    
    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Proxy server error', 
      message: error.message 
    });
  }
};
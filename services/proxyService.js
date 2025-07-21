const axios = require('axios');

exports.makeRequest = async (url, method = 'GET', headers = {}, body = null) => {
  try {
    const response = await axios({
      url,
      method: method || 'GET',
      headers: headers || {},
      data: body || undefined,
      validateStatus: () => true // Don't throw on non-2xx responses
    });
    
    return {
      status: response.status,
      data: response.data,
      headers: response.headers
    };
  } catch (error) {
    console.error('Proxy request error:', error);
    throw error;
  }
};
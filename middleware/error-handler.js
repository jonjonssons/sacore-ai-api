/**
 * Global error handler middleware
 */
const { StatusCodes } = require('http-status-codes');

const errorHandlerMiddleware = (err, req, res, next) => {
  console.error('Error:', err);
  
  let customError = {
    // Set default
    statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
    msg: err.message || 'Something went wrong, please try again later'
  };
  
  // Send the error response
  return res.status(customError.statusCode).json({ error: customError.msg });
};

module.exports = errorHandlerMiddleware;
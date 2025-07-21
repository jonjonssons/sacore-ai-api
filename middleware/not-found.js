/**
 * Middleware to handle 404 (Not Found) errors
 * This middleware should be placed after all other routes
 */
const { NotFoundError } = require('../errors');

const notFoundMiddleware = (req, res, next) => {
  throw new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`);
};

module.exports = notFoundMiddleware;
const { ForbiddenError } = require('../errors');

const isAdmin = (req, res, next) => {
  console.log("req.user::::::", req.user);
  if (req.user && req.user.role === 'admin') {
    return next();
  }

  return next(new ForbiddenError('Not authorized to access this route'));
};

module.exports = {
  isAdmin
};
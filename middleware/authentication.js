const jwt = require('jsonwebtoken');
const { UnauthenticatedError, ForbiddenError } = require('../errors');
const User = require('../models/User');

const authenticateUser = async (req, res, next) => {
  // Check for authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthenticatedError('Authentication invalid'));
  }

  try {
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user to request object
    req.user = {
      userId: payload.userId,
      name: payload.name,
      role: payload.role
    };

    next();
  } catch (error) {
    return next(new UnauthenticatedError('Authentication invalid'));
  }
};

const checkCredits = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.user.userId });

    if (!user) {
      throw new UnauthenticatedError('User not found');
    }

    // Check if trial has ended and reset credits if needed (atomic operation)
    const trialEndDate = new Date(user.trialStartDate);
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    // Use atomic update to prevent race conditions
    if (!user.isTrialValid() && !user.trialEnded && user.subscription === 'free') {
      const updatedUser = await User.findOneAndUpdate(
        {
          _id: req.user.userId,
          trialEnded: false, // Only update if trial hasn't been marked as ended yet
          subscription: 'free'
        },
        {
          trialEnded: true,
          credits: 0
        },
        { new: true }
      );

      if (updatedUser) {
        // Credits were reset, use updated user object
        user.credits = 0;
        user.trialEnded = true;
      }
    } else if (!user.isTrialValid() && !user.trialEnded) {
      // Just mark trial as ended for paid subscribers
      await User.findOneAndUpdate(
        {
          _id: req.user.userId,
          trialEnded: false
        },
        {
          trialEnded: true
        }
      );
      user.trialEnded = true;
    }

    // Check if user has credits
    if (user.credits <= 0) {
      throw new ForbiddenError('Your trial period has ended or you have no credits left. Please upgrade your plan.');
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticateUser,
  checkCredits
};
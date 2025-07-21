const creditService = require('../services/creditService');
const stripeTopUpService = require('../services/stripeTopUpService');
const usageService = require('../services/usageService');
const { StatusCodes } = require('http-status-codes');
const User = require('../models/User');
const { BadRequestError, NotFoundError, UnauthenticatedError } = require('../errors');
const CREDIT_PACKAGES = require('../config/creditPackages');

// Get available credit packages
exports.getCreditPackages = async (req, res) => {
  res.status(StatusCodes.OK).json({ packages: CREDIT_PACKAGES });
};

// Create checkout session for credit purchase
exports.createCreditCheckoutSession = async (req, res) => {
  const { packageId, customAmount } = req.body;
  const userId = req.user.userId;

  if (!packageId) {
    throw new BadRequestError('Please select a credit package');
  }

  try {
    const session = await stripeTopUpService.createCreditCheckoutSession(
      userId,
      packageId,
      customAmount
    );

    res.status(StatusCodes.OK).json({ url: session.url });
  } catch (error) {
    throw new BadRequestError(error.message);
  }
};

// Get user's credit balance
exports.getUserCredits = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.user.userId });

    if (!user) {
      throw new UnauthenticatedError('User not found');
    }

    // Get usage information
    const usageData = await usageService.getSearchUsage(req.user.userId);

    res.status(StatusCodes.OK).json({
      credits: user.credits,
      usage: {
        subscription: user.subscription || 'free',
        ...usageData.usage
      }
    });
  } catch (error) {
    console.error('Error getting user credits:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get user credits',
      details: error.message
    });
  }
};

// Get credit packages
// exports.getCreditPackages = async (req, res) => {
//   try {
//     const packages = stripeTopUpService.CREDIT_PACKAGES;

//     res.status(StatusCodes.OK).json({
//       packages
//     });
//   } catch (error) {
//     console.error('Error getting credit packages:', error);
//     res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
//       error: 'Failed to get credit packages',
//       details: error.message
//     });
//   }
// };

// Create checkout session for credit purchase
// exports.createCreditCheckoutSession = async (req, res) => {
//   try {
//     const { packageId } = req.body;

//     if (!packageId) {
//       throw new BadRequestError('Please provide a package ID');
//     }

//     const session = await stripeTopUpService.createCreditCheckoutSession(
//       req.user.userId,
//       packageId
//     );

//     res.status(StatusCodes.OK).json({
//       url: session.url
//     });
//   } catch (error) {
//     console.error('Error creating checkout session:', error);
//     res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
//       error: 'Failed to create checkout session',
//       details: error.message
//     });
//   }
// };

// Get credit history
exports.getCreditHistory = async (req, res) => {
  try {
    const { startDate, endDate, type, limit } = req.query;

    const filter = {};
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (type) filter.type = type.toUpperCase();
    if (limit) filter.limit = parseInt(limit);

    const history = await creditService.getCreditHistory(req.user.userId, filter);

    res.status(StatusCodes.OK).json(history);
  } catch (error) {
    console.error('Error getting credit history:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get credit history',
      details: error.message
    });
  }
};

// Get credit summary
exports.getCreditSummary = async (req, res) => {
  try {
    const summary = await creditService.getCreditSummary(req.user.userId);

    res.status(StatusCodes.OK).json(summary);
  } catch (error) {
    console.error('Error getting credit summary:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to get credit summary',
      details: error.message
    });
  }
};
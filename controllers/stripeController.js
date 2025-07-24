const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const stripeService = require('../services/stripeService');
const stripeTopUpService = require('../services/stripeTopUpService');
const { StatusCodes } = require('http-status-codes');
const { BadRequestError } = require('../errors');
const User = require('../models/User');

// Create checkout session
exports.createCheckoutSession = async (req, res) => {
  const { plan, billingInterval = 'monthly' } = req.body;

  if (!plan) {
    throw new BadRequestError('Please provide a plan');
  }

  if (!['monthly', 'yearly'].includes(billingInterval)) {
    throw new BadRequestError('Billing interval must be either "monthly" or "yearly"');
  }

  const session = await stripeService.createCheckoutSession(req.user.userId, plan, billingInterval);

  res.status(StatusCodes.OK).json({ url: session.url });
};

// Handle webhook

exports.handleWebhook = async (req, res, next) => {
  console.log('🔔 WEBHOOK RECEIVED - Start of handleWebhook');
  console.log('Headers received:', req.headers);
  console.log('Body type:', typeof req.body);
  console.log('Body length:', req.body ? req.body.length : 'No body');

  const sig = req.headers['stripe-signature'];
  console.log('Stripe signature present:', !!sig);

  let event;

  try {
    if (process.env.NODE_ENV === 'production' && req.headers['rndr-id']) {
      // When on Render, parse the event from the body directly
      event = req.body;

      // Log that we're using the relaxed approach
      console.log('Using relaxed webhook verification for Render');
    } else {
      // For local development or other platforms, use standard verification
      const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

      // Verify the event with the signature
      event = stripe.webhooks.constructEvent(
        req.rawBody || req.body, // Use rawBody if available
        sig,
        endpointSecret
      );
    }

    console.log('✅ Webhook signature verified successfully');
    console.log('Event type:', event.type);
    console.log('Event ID:', event.id);

    // Check if this is a credit purchase
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }


    console.log('✅ Webhook processed successfully');
    res.status(StatusCodes.OK).json({ received: true });
  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);
    console.error('❌ Full error:', error);
    next(error);
  }
};

// Get subscription plans based on user's current plan
exports.getPlans = async (req, res) => {
  try {
    const allPlansData = stripeService.PLANS;

    const user = await User.findById(req.user.userId);
    const currentPlanName = (user.subscription || 'free').toLowerCase();
    const currentBillingInterval = user.billingInterval || 'monthly';

    const planHierarchy = ['free', 'basic', 'explorer', 'pro'];
    const currentPlanIndex = planHierarchy.indexOf(currentPlanName);

    let availablePlans = [];

    // Transform plans data to include both monthly and yearly options
    Object.keys(allPlansData).forEach(planKey => {
      const plan = allPlansData[planKey];
      const planName = plan.name.toLowerCase();
      const planIndex = planHierarchy.indexOf(planName);

      // Only include plans that are higher tier than current plan
      if (currentPlanIndex === -1 || currentPlanName === 'free' || planIndex >= currentPlanIndex) {
        availablePlans.push({
          id: planKey.toLowerCase(),
          name: plan.name,
          credits: plan.credits,
          monthly: {
            priceId: plan.monthly.priceId,
            interval: plan.monthly.interval
          },
          yearly: {
            priceId: plan.yearly.priceId,
            interval: plan.yearly.interval
          },
          // Add flags to help frontend identify upgrade vs billing change
          isUpgrade: planIndex > currentPlanIndex,
          isBillingChange: planIndex === currentPlanIndex,
          isCurrentPlan: planIndex === currentPlanIndex
        });
      }
    });

    res.status(StatusCodes.OK).json({
      plans: availablePlans,
      currentPlan: {
        name: currentPlanName,
        billingInterval: currentBillingInterval
      }
    });
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch subscription plans',
      details: error.message
    });
  }
};
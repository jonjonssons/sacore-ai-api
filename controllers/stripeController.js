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

// Handle webhook
exports.handleWebhook = async (req, res, next) => {
  console.log('🔔 WEBHOOK RECEIVED - Start of handleWebhook');
  console.log('Headers received:', req.headers);
  console.log('Body type:', typeof req.body);
  console.log('Body length:', req.body ? JSON.stringify(req.body).length : 'No body');

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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('📦 Checkout session completed - metadata:', session.metadata);

      if (session.metadata && session.metadata.type === 'credit_purchase') {
        console.log('💳 Processing credit purchase');
        // Handle credit purchase
        await stripeTopUpService.handleSuccessfulCreditPurchase(session);
      } else {
        console.log('📋 Processing subscription (calling stripeService.handleWebhookEvent)');
        // Handle subscription (existing code)
        await stripeService.handleWebhookEvent(event);
      }
    } else {
      console.log('🔄 Processing other event type:', event.type);
      // Handle other events with existing code
      await stripeService.handleWebhookEvent(event);
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

// Get subscription details
exports.getSubscriptionDetails = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user from database
    const user = await User.findById(userId);
    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({ error: 'User not found' });
    }

    // Prepare the base response with user subscription data
    const response = {
      subscription: {
        plan: user.subscription || 'free',
        status: user.subscription === 'free' ? 'inactive' : 'active',
        billingInterval: user.billingInterval || 'monthly',
        credits: {
          available: user.credits || 0
        }
      }
    };

    // If user has a Stripe customer ID, get additional details from Stripe
    if (user.stripeCustomerId && user.subscription !== 'free') {
      try {
        // Get customer's subscriptions from Stripe
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'all',
          limit: 1
        });
        console.log('subscriptions', subscriptions);

        if (subscriptions.data.length > 0) {
          const subscription = subscriptions.data[0];

          // Helper function to safely convert timestamp
          const safeTimestampToISO = (timestamp) => {
            if (!timestamp || timestamp === null) return null;
            try {
              const date = new Date(timestamp * 1000);
              if (isNaN(date.getTime())) return null;
              return date.toISOString();
            } catch (error) {
              console.error('Invalid timestamp:', timestamp, error);
              return null;
            }
          };

          // Calculate current period end from billing cycle anchor and interval
          let currentPeriodEnd = null;
          if (subscription.billing_cycle_anchor && subscription.items?.data?.[0]?.price?.recurring) {
            const interval = subscription.items.data[0].price.recurring.interval;
            const intervalCount = subscription.items.data[0].price.recurring.interval_count || 1;

            const anchor = new Date(subscription.billing_cycle_anchor * 1000);
            const now = new Date();

            // Calculate next billing date
            let nextBilling = new Date(anchor);
            while (nextBilling <= now) {
              if (interval === 'month') {
                nextBilling.setMonth(nextBilling.getMonth() + intervalCount);
              } else if (interval === 'year') {
                nextBilling.setFullYear(nextBilling.getFullYear() + intervalCount);
              } else if (interval === 'day') {
                nextBilling.setDate(nextBilling.getDate() + intervalCount);
              } else if (interval === 'week') {
                nextBilling.setDate(nextBilling.getDate() + (intervalCount * 7));
              }
            }
            currentPeriodEnd = nextBilling.toISOString();
          }

          // Add Stripe subscription details
          response.subscription.stripeDetails = {
            id: subscription.id,
            status: subscription.status,
            currentPeriodStart: safeTimestampToISO(subscription.start_date),
            currentPeriodEnd: currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            canceledAt: safeTimestampToISO(subscription.canceled_at),
            billingCycleAnchor: safeTimestampToISO(subscription.billing_cycle_anchor)
          };

          // Get the product details for this subscription
          if (subscription.items.data.length > 0) {
            const item = subscription.items.data[0];
            const price = await stripe.prices.retrieve(item.price.id, {
              expand: ['product']
            });

            response.subscription.stripeDetails.product = {
              id: price.product.id,
              name: price.product.name,
              description: price.product.description
            };

            response.subscription.stripeDetails.price = {
              id: price.id,
              amount: price.unit_amount / 100, // Convert from cents to dollars
              currency: price.currency,
              interval: price.recurring ? price.recurring.interval : null,
              intervalCount: price.recurring ? price.recurring.interval_count : null
            };
          }
        }
      } catch (stripeError) {
        console.error('Error fetching Stripe subscription details:', stripeError);
        // Continue without Stripe details
      }
    }

    // Get usage information if available
    try {
      const usageService = require('../services/usageService');
      const usageData = await usageService.getSearchUsage(userId);

      if (usageData && usageData.usage) {
        response.subscription.usage = usageData.usage;
      }
    } catch (usageError) {
      console.error('Error fetching usage data:', usageError);
      // Continue without usage data
    }

    return res.status(StatusCodes.OK).json(response);
  } catch (error) {
    console.error('Error fetching subscription details:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch subscription details',
      details: error.message
    });
  }
};

// Cancel subscription at period end
exports.cancelSubscription = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Call service method to cancel subscription
    const canceledSubscription = await stripeService.cancelSubscription(userId);

    res.status(StatusCodes.OK).json({
      message: 'Subscription will be canceled at the end of the billing period',
      subscription: canceledSubscription
    });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to cancel subscription',
      details: error.message
    });
  }
};


// Get user's invoice history
exports.getInvoiceHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const invoices = await stripeService.listUserInvoices(userId);
    res.status(StatusCodes.OK).json({ invoices });
  } catch (error) {
    console.error('Error fetching invoice history:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to fetch invoice history',
      details: error.message,
    });
  }
};


// Cancel subscription immediately
exports.cancelSubscriptionImmediately = async (req, res) => {
  try {
    const userId = req.user.userId;

    // Call service method to cancel subscription immediately
    const canceledSubscription = await stripeService.cancelSubscriptionImmediately(userId);

    res.status(StatusCodes.OK).json({
      message: 'Subscription has been canceled immediately',
      subscription: canceledSubscription
    });
  } catch (error) {
    console.error('Error canceling subscription immediately:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to cancel subscription immediately',
      details: error.message
    });
  }
};
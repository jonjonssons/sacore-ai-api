const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');


// Subscription plans with monthly and yearly options
const PLANS = {
  BASIC: {
    name: 'Basic',
    credits: 500,
    monthly: {
      priceId: process.env.STRIPE_BASIC_MONTHLY_PRICE_ID,
      interval: 'month'
    },
    yearly: {
      priceId: process.env.STRIPE_BASIC_YEARLY_PRICE_ID,
      interval: 'year'
    }
  },
  EXPLORER: {
    name: 'Explorer',
    credits: 1500,
    monthly: {
      priceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
      interval: 'month'
    },
    yearly: {
      priceId: process.env.STRIPE_PRO_YEARLY_PRICE_ID,
      interval: 'year'
    }
  },
  PRO: {
    name: 'Pro',
    credits: 6500,
    monthly: {
      priceId: process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID,
      interval: 'month'
    },
    yearly: {
      priceId: process.env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID,
      interval: 'year'
    }
  }
};

// Create a checkout session
exports.createCheckoutSession = async (userId, plan, billingInterval = 'monthly') => {
  const user = await User.findOne({ _id: userId });

  if (!user) {
    throw new Error('User not found');
  }

  // Get plan details
  const planDetails = PLANS[plan.toUpperCase()];

  if (!planDetails) {
    throw new Error('Invalid plan');
  }

  // Get the correct price ID based on billing interval
  const intervalKey = billingInterval.toLowerCase();
  if (!planDetails[intervalKey]) {
    throw new Error(`Invalid billing interval: ${billingInterval}`);
  }

  const priceId = planDetails[intervalKey].priceId;

  // Create or retrieve Stripe customer
  let customerId = user.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name,
      metadata: {
        userId: user._id.toString()
      }
    });

    customerId = customer.id;
    user.stripeCustomerId = customerId;
    await user.save();
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/dashboard?canceled=true`,
    metadata: {
      userId: user._id.toString(),
      plan: plan.toLowerCase(),
      billingInterval: intervalKey
    }
  });

  // Add debugging for checkout session creation
  console.log('=== CHECKOUT SESSION CREATION DEBUG ===');
  console.log('Original plan:', plan);
  console.log('Original billingInterval:', billingInterval);
  console.log('IntervalKey used:', intervalKey);
  console.log('PriceId selected:', priceId);
  console.log('Metadata being sent to Stripe:', {
    userId: user._id.toString(),
    plan: plan.toLowerCase(),
    billingInterval: intervalKey
  });
  console.log('=== END CHECKOUT CREATION DEBUG ===');

  return session;
};

// Handle webhook events
exports.handleWebhookEvent = async (event) => {
  switch (event.type) {
    case 'checkout.session.completed':
      return await handleCheckoutSessionCompleted(event.data.object);

    case 'invoice.paid':
      return await handleInvoicePaid(event.data.object);

    case 'customer.subscription.deleted':
      return await handleSubscriptionCanceled(event.data.object);

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }
};

// Handle checkout session completed
const handleCheckoutSessionCompleted = async (session) => {
  const userId = session.metadata.userId;
  const plan = session.metadata.plan;
  const billingInterval = session.metadata.billingInterval || 'monthly';

  // Add debugging
  console.log('=== CHECKOUT SESSION COMPLETED DEBUG ===');
  console.log('Session metadata:', session.metadata);
  console.log('Extracted plan:', plan);
  console.log('Extracted billingInterval:', billingInterval);

  const user = await User.findOne({ _id: userId });

  if (!user) {
    throw new Error('User not found');
  }

  console.log('User before update:', {
    subscription: user.subscription,
    billingInterval: user.billingInterval
  });

  // Store original credits for transaction record
  const originalCredits = user.credits;

  // Update user subscription with billing interval info
  user.subscription = plan;
  user.billingInterval = billingInterval;
  user.trialEnded = true;

  // Add credits based on plan instead of replacing
  let planCredits = 0;
  switch (plan) {
    case 'basic':
      planCredits = PLANS.BASIC.credits;
      break;
    case 'explorer':
      planCredits = PLANS.EXPLORER.credits;
      break;
    case 'pro':
      planCredits = PLANS.PRO.credits;
      break;
  }

  // Add new plan credits to existing credits instead of replacing
  user.credits += planCredits;
  const newCredits = user.credits;

  await user.save();

  console.log('User after update and save:', {
    subscription: user.subscription,
    billingInterval: user.billingInterval
  });
  console.log('=== END CHECKOUT SESSION DEBUG ===');

  // Create credit transaction entry for plan upgrade
  const intervalText = billingInterval === 'yearly' ? ' (Yearly)' : ' (Monthly)';
  await CreditTransaction.create({
    user: userId,
    amount: newCredits - originalCredits,
    type: 'PLAN_CHANGE',
    description: `Plan upgraded to ${plan.charAt(0).toUpperCase() + plan.slice(1)}${intervalText} (${planCredits} credits)`,
    balance: newCredits,
    createdAt: new Date()
  });

  return user;
};

// Handle invoice paid
const handleInvoicePaid = async (invoice) => {

  const isInitialInvoice = invoice.billing_reason === 'subscription_create';
  // If this is the initial invoice and we've already handled the checkout session, don't add credits again
  if (isInitialInvoice) {
    console.log('Skipping credit addition for initial invoice as it was handled in checkout session');
    return;
  }
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const customerId = invoice.customer;

  const user = await User.findOne({ stripeCustomerId: customerId });

  if (!user) {
    throw new Error('User not found');
  }

  const originalCredits = user.credits;


  // Reset credits based on subscription
  const plan = user.subscription;
  let planCredits = 0;

  switch (plan) {
    case 'basic':
      planCredits = PLANS.BASIC.credits;
      break;
    case 'explorer':
      planCredits = PLANS.EXPLORER.credits;
      break;
    case 'pro':
      planCredits = PLANS.PRO.credits;
      break;
  }

  // Add new plan credits to existing credits instead of replacing
  user.credits += planCredits;
  const newCredits = user.credits;

  await user.save();

  // Create credit transaction entry for plan renewal
  const intervalText = user.billingInterval === 'yearly' ? ' (Yearly)' : ' (Monthly)';
  await CreditTransaction.create({
    user: user._id,
    amount: newCredits - originalCredits,
    type: 'PLAN_CHANGE',
    description: `Plan renewed: ${plan.charAt(0).toUpperCase() + plan.slice(1)}${intervalText} (+${planCredits} credits)`,
    balance: newCredits,
    createdAt: new Date()
  });

  return user;
};

// Handle subscription canceled
const handleSubscriptionCanceled = async (subscription) => {
  const customerId = subscription.customer;

  const user = await User.findOne({ stripeCustomerId: customerId });

  if (!user) {
    throw new Error('User not found');
  }

  // Downgrade to free plan
  user.subscription = 'free';
  user.credits = 10; // Free tier credits

  await user.save();

  return user;
};

module.exports.PLANS = PLANS;
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

// Helper to find plan details by price ID
const findPlanByPriceId = (priceId) => {
  for (const planKey of Object.keys(PLANS)) {
    const plan = PLANS[planKey];
    if (plan.monthly.priceId === priceId) {
      return {
        planName: plan.name.toLowerCase(),
        credits: plan.credits,
        billingInterval: 'monthly',
      };
    }
    if (plan.yearly.priceId === priceId) {
      return {
        planName: plan.name.toLowerCase(),
        credits: plan.credits,
        billingInterval: 'yearly',
      };
    }
  }
  return null;
};


// Handle invoice paid
const handleInvoicePaid = async (invoice) => {

  const isInitialInvoice = invoice.billing_reason === 'subscription_create';
  // If this is the initial invoice from a new subscription, we've already handled
  // adding credits in the 'checkout.session.completed' event.
  if (isInitialInvoice) {
    console.log('Skipping credit addition for initial invoice as it was handled in checkout session.');
    return;
  }

  const customerId = invoice.customer;
  if (!customerId) {
    console.error('Invoice paid event is missing customer ID.', { invoiceId: invoice.id });
    return;
  }

  const user = await User.findOne({ stripeCustomerId: customerId });

  if (!user) {
    // This can happen if a customer is created in Stripe but not in your DB.
    // Or if a webhook is received for a customer you've deleted.
    throw new Error(`User not found for stripeCustomerId: ${customerId}`);
  }

  // Get plan details from the invoice line items, which is the source of truth.
  if (!invoice.lines || !invoice.lines.data || invoice.lines.data.length === 0) {
    console.error('Invoice paid event is missing line items.', { invoiceId: invoice.id });
    return;
  }

  const priceId = invoice.lines.data[0].price.id;
  const planDetails = findPlanByPriceId(priceId);

  if (!planDetails) {
    console.error(`Could not find a plan associated with price ID: ${priceId}. This may be a one-time payment not handled here.`);
    return;
  }

  const { planName, credits: planCredits, billingInterval } = planDetails;

  const originalCredits = user.credits;
  let newCredits;
  let transactionAmount;
  let transactionDescription;
  let transactionType;

  // Different credit handling based on billing interval
  if (billingInterval === 'yearly') {
    // YEARLY PLANS: Annual renewal - Reset all credits (this is the actual yearly billing)
    
    // Log expired credits if any
    if (originalCredits > 0) {
      await CreditTransaction.create({
        user: user._id,
        amount: -originalCredits,
        type: 'ANNUAL_RESET',
        description: `Annual renewal - ${originalCredits} unused credits expired`,
        balance: 0,
        createdAt: new Date()
      });
      console.log(`User ${user.email} annual renewal: ${originalCredits} unused credits expired.`);
    }

    // Reset to plan amount for annual renewal and reset rollover flag
    user.credits = planCredits;
    user.hasUsedMonthlyRollover = false; // Reset for new year
    newCredits = user.credits;
    transactionAmount = planCredits;
    transactionType = 'PLAN_CHANGE';
    transactionDescription = `Plan renewed: ${planName.charAt(0).toUpperCase() + planName.slice(1)} (Annual) - Credits reset to ${planCredits}`;

    console.log(`User ${user.email} annual subscription renewed. Plan: ${planName}. Credits reset to ${planCredits}.`);

  } else {
    // MONTHLY PLANS: Rollover only for first month, then reset
    
    if (!user.hasUsedMonthlyRollover) {
      // First month - ROLLOVER
      const newTotalCredits = originalCredits + planCredits;
      user.credits = newTotalCredits;
      user.hasUsedMonthlyRollover = true;
      
      newCredits = user.credits;
      transactionAmount = planCredits;
      transactionType = 'PLAN_CHANGE';
      transactionDescription = `Plan renewed: ${planName.charAt(0).toUpperCase() + planName.slice(1)} (Monthly) - ${planCredits} credits added to existing ${originalCredits}`;

      console.log(`User ${user.email} monthly subscription renewed (FIRST ROLLOVER). Plan: ${planName}. ${originalCredits} + ${planCredits} = ${newTotalCredits} credits.`);

    } else {
      // Subsequent months - RESET
      
      // Log expired credits if any
      if (originalCredits > 0) {
        await CreditTransaction.create({
          user: user._id,
          amount: -originalCredits,
          type: 'MONTHLY_RESET',
          description: `Monthly renewal - ${originalCredits} unused credits expired`,
          balance: 0,
          createdAt: new Date()
        });
        console.log(`User ${user.email} monthly renewal: ${originalCredits} unused credits expired.`);
      }

      // Set new credits
      user.credits = planCredits;
      newCredits = user.credits;
      transactionAmount = planCredits;
      transactionType = 'PLAN_CHANGE';
      transactionDescription = `Plan renewed: ${planName.charAt(0).toUpperCase() + planName.slice(1)} (Monthly) - Credits reset to ${planCredits}`;

      console.log(`User ${user.email} monthly subscription renewed (RESET). Plan: ${planName}. Credits reset to ${planCredits}.`);
    }
  }

  // Also update the user's subscription info to ensure it's in sync with Stripe.
  user.subscription = planName;
  user.billingInterval = billingInterval;

  // Track subscription start date and last reset
  if (!user.subscriptionStartDate) {
    user.subscriptionStartDate = new Date();
  }
  user.lastCreditReset = new Date();

  await user.save();

  // Create credit transaction entry for plan renewal
  await CreditTransaction.create({
    user: user._id,
    amount: transactionAmount,
    type: transactionType,
    description: transactionDescription,
    balance: newCredits,
    createdAt: new Date()
  });

  return user;
};

// List invoices for a user
exports.listUserInvoices = async (userId) => {
  const user = await User.findById(userId);
  if (!user || !user.stripeCustomerId) {
    throw new Error('User or Stripe customer not found.');
  }

  const invoices = await stripe.invoices.list({
    customer: user.stripeCustomerId,
    limit: 100, // You can add pagination later if needed
  });

  // Format the invoices to be more front-end friendly
  return invoices.data.map(invoice => ({
    id: invoice.id,
    date: new Date(invoice.created * 1000).toLocaleDateString(),
    amount: (invoice.amount_paid / 100).toFixed(2),
    currency: invoice.currency.toUpperCase(),
    status: invoice.status,
    pdf: invoice.invoice_pdf, // Link to the downloadable PDF
    url: invoice.hosted_invoice_url, // Link to the Stripe-hosted invoice page
  }));
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

// Cancel subscription
exports.cancelSubscription = async (userId) => {
  try {
    // Find user
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.stripeCustomerId) {
      throw new Error('User does not have a Stripe customer ID');
    }

    // Get active subscriptions for customer
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      throw new Error('No active subscriptions found');
    }

    // Get the subscription ID
    const subscriptionId = subscriptions.data[0].id;

    // Cancel the subscription at period end
    const canceledSubscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });

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

    // Return subscription details with cancellation info
    return {
      id: canceledSubscription.id,
      status: canceledSubscription.status,
      cancelAtPeriodEnd: canceledSubscription.cancel_at_period_end,
      currentPeriodEnd: safeTimestampToISO(canceledSubscription.current_period_end),
      canceledAt: safeTimestampToISO(Date.now() / 1000)
    };
  } catch (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }
};

// Immediately cancel subscription
exports.cancelSubscriptionImmediately = async (userId) => {
  try {
    // Find user
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.stripeCustomerId) {
      throw new Error('User does not have a Stripe customer ID');
    }

    // Get active subscriptions for customer
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      throw new Error('No active subscriptions found');
    }

    // Get the subscription ID
    const subscriptionId = subscriptions.data[0].id;

    // Cancel the subscription immediately
    const canceledSubscription = await stripe.subscriptions.cancel(subscriptionId);

    // Update user to free plan immediately
    user.subscription = 'free';
    user.credits = Math.min(user.credits, 10); // Set to free tier credits but don't increase if lower
    await user.save();

    // Create credit transaction entry for plan downgrade if credits were reduced
    if (user.credits < subscriptions.data[0].metadata.originalCredits) {
      await CreditTransaction.create({
        user: userId,
        amount: 10 - subscriptions.data[0].metadata.originalCredits,
        type: 'PLAN_CHANGE',
        description: 'Plan downgraded to Free (subscription canceled immediately)',
        balance: user.credits,
        createdAt: new Date()
      });
    }

    return {
      id: canceledSubscription.id,
      status: canceledSubscription.status,
      canceled: true
    };
  } catch (error) {
    console.error('Error canceling subscription immediately:', error);
    throw error;
  }
};

module.exports.PLANS = PLANS;
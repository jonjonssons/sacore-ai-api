const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const CREDIT_PACKAGES = require('../config/creditPackages');
const { addCredits } = require('./creditService');
const User = require('../models/User');

// Create a checkout session for credit purchase
exports.createCreditCheckoutSession = async (userId, packageId, customAmount = null) => {
  // Find the selected package
  const selectedPackage = CREDIT_PACKAGES.find(pkg => pkg.id === packageId);

  if (!selectedPackage) {
    throw new Error('Invalid credit package');
  }

  let amount, unitAmount, description;

  if (packageId === 'custom') {
    // Handle custom amount
    if (!customAmount || customAmount < 10) { // Minimum 10 credits
      throw new Error('Custom amount must be at least 10 credits');
    }

    amount = customAmount;
    unitAmount = Math.round(customAmount * selectedPackage.pricePerCredit * 100); // Convert to cents
    description = `${customAmount} Credits`;
  } else {
    // Use predefined package
    amount = selectedPackage.amount;
    unitAmount = Math.round(selectedPackage.price * 100); // Convert to cents
    description = selectedPackage.description;
  }

  // Create a product for this purchase (or use existing products)
  const product = await stripe.products.create({
    name: description,
    metadata: {
      type: 'credit_package',
      credits: amount.toString()
    }
  });

  // Create a price for the product
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: unitAmount,
    currency: 'usd',
  });

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price: price.id,
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${process.env.FRONTEND_URL}/dashboard?success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.FRONTEND_URL}/dashboard?cancel`,
    metadata: {
      userId: userId,
      type: 'credit_purchase',
      creditAmount: amount.toString(),
      packageId: packageId
    },
  });

  return session;
};

// Process successful credit purchase
exports.handleSuccessfulCreditPurchase = async (session) => {
  if (session.metadata && session.metadata.type === 'credit_purchase') {
    const userId = session.metadata.userId;
    const packageId = session.metadata.packageId;
    const creditAmount = parseInt(session.metadata.creditAmount);

    const user = await User.findOne({ _id: userId });

    if (!user) {
      throw new Error('User not found');
    }

    // Get package details
    const packageDetails = CREDIT_PACKAGES.find(pkg => pkg.id === packageId);

    if (!packageDetails) {
      throw new Error('Invalid package');
    }

    // Add credits to user account
    return await addCredits(
      userId,
      creditAmount,
      'TOPUP',
      `Purchased ${packageDetails.id} (${creditAmount} credits)`
    );
  }

  return user;
};
// exports.handleSuccessfulCreditPurchase = async (session) => {
//   const userId = session.metadata.userId;
//   const packageId = session.metadata.packageId;

//   const user = await User.findOne({ _id: userId });

//   if (!user) {
//     throw new Error('User not found');
//   }

//   // Get package details
//   const packageDetails = this.CREDIT_PACKAGES.find(pkg => pkg.id === packageId);

//   if (!packageDetails) {
//     throw new Error('Invalid package');
//   }

//   // Add credits using the credit service
//   await creditService.addCredits(
//     userId,
//     packageDetails.credits,
//     'TOPUP',
//     `Purchased ${packageDetails.name} (${packageDetails.credits} credits)`
//   );

//   return user;
// };
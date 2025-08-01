const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    match: [
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
      'Please provide a valid email',
    ],
    unique: true,
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: 6,
  },
  firstName: {
    type: String,
    required: [true, 'Please provide a firstName'],
    minlength: 3,
    maxlength: 50,
  },
  lastName: {
    type: String,
    required: [true, 'Please provide a lastName'],
    maxlength: 50,
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  verificationCode: {
    type: Number,
    default: null,
  },
  verificationCodeExpires: {
    type: Date,
    default: null,
  },
  trialStartDate: {
    type: Date,
    default: Date.now,
  },
  trialEnded: {
    type: Boolean,
    default: false,
  },
  subscription: {
    type: String,
    enum: ['free', 'basic', 'explorer', 'pro'],
    default: 'free',
  },
  billingInterval: {
    type: String,
    enum: ['monthly', 'yearly'],
    default: 'monthly',
  },
  credits: {
    type: Number,
    default: 100, // Default free credits
  },
  stripeCustomerId: {
    type: String,
    default: null,
  },
  hasSeenOnboardingVideo: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  // Add these fields to the UserSchema
  resetPasswordCode: {
    type: Number,
    default: null,
  },
  resetPasswordCodeExpires: {
    type: Date,
    default: null,
  }
});

// Hash password before saving
UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Create JWT
UserSchema.methods.createAccessToken = function () {
  return jwt.sign(
    { userId: this._id, name: this.firstName, role: this.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_LIFETIME }
  );
};

UserSchema.methods.createRefreshToken = function () {
  return jwt.sign(
    { userId: this._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_LIFETIME }
  );
};


// Compare password
UserSchema.methods.comparePassword = async function (candidatePassword) {
  const isMatch = await bcrypt.compare(candidatePassword, this.password);
  return isMatch;
};

// Generate verification code
UserSchema.methods.generateVerificationCode = function () {
  // Generate a 6-digit verification code
  const verificationCode = Math.floor(100000 + Math.random() * 900000);

  // Set expiration time (1 hour from now)
  const expirationTime = new Date();
  expirationTime.setHours(expirationTime.getHours() + 1);

  // Save to user
  this.verificationCode = verificationCode;
  this.verificationCodeExpires = expirationTime;

  return verificationCode;
};

// Check if verification code is valid
UserSchema.methods.isVerificationCodeValid = function (code) {
  return (
    this.verificationCode === code &&
    this.verificationCodeExpires > new Date() &&
    !this.isVerified
  );
};

// Check if trial is still valid
UserSchema.methods.isTrialValid = function () {
  const trialEndDate = new Date(this.trialStartDate);
  trialEndDate.setDate(trialEndDate.getDate() + 7); // 7-day trial
  return new Date() < trialEndDate;
};

// Get remaining trial days
UserSchema.methods.getRemainingTrialDays = function () {
  if (this.trialEnded) return 0;

  const trialEndDate = new Date(this.trialStartDate);
  trialEndDate.setDate(trialEndDate.getDate() + 7); // 7-day trial

  const currentDate = new Date();
  const diffTime = trialEndDate - currentDate;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays > 0 ? diffDays : 0;
};

// Add this method after the other methods
UserSchema.methods.checkAndResetTrialCredits = function () {
  // Check if trial has just ended
  const trialEndDate = new Date(this.trialStartDate);
  trialEndDate.setDate(trialEndDate.getDate() + 7); // 7-day trial

  const currentDate = new Date();
  const trialJustEnded = !this.isTrialValid() && !this.trialEnded;

  // Only reset credits if the user is still on the free plan
  // Paid subscribers keep their credits even after trial ends
  if (trialJustEnded && this.subscription === 'free') {
    // Mark trial as ended and reset credits to zero
    this.trialEnded = true;
    this.credits = 0;
    return true; // Credits were reset
  } else if (trialJustEnded) {
    // Just mark trial as ended for paid subscribers, but don't reset credits
    this.trialEnded = true;
    return false; // No credits reset needed
  }

  return false; // No change needed
};

// Generate reset password code
UserSchema.methods.generateResetPasswordCode = function () {
  // Generate a 6-digit reset code
  const resetCode = Math.floor(100000 + Math.random() * 900000);

  // Set expiration time (1 hour from now)
  const expirationTime = new Date();
  expirationTime.setHours(expirationTime.getHours() + 1);

  // Save to user
  this.resetPasswordCode = resetCode;
  this.resetPasswordCodeExpires = expirationTime;

  return resetCode;
};

// Check if reset password code is valid
UserSchema.methods.isResetPasswordCodeValid = function (code) {
  return (
    this.resetPasswordCode === parseInt(code) &&
    this.resetPasswordCodeExpires > new Date()
  );
};

module.exports = mongoose.model('User', UserSchema);
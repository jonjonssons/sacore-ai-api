const User = require('../models/User');
const CreditTransaction = require('../models/CreditTransaction');
const jwt = require('jsonwebtoken');
const { StatusCodes } = require('http-status-codes');
const { BadRequestError, UnauthenticatedError, NotFoundError } = require('../errors');
const emailService = require('../services/emailService');

const register = async (req, res, next) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(StatusCodes.CONFLICT).json({
        error: 'Email already exists. Please use a different email or try logging in.',
      });
    }

    // Create user (unverified)
    const user = await User.create({ firstName, lastName, email, password, isVerified: false });

    // Generate verification code
    const verificationCode = user.generateVerificationCode();
    await user.save();

    // Send verification email
    const emailSent = await emailService.sendVerificationEmail(email, firstName, verificationCode);

    if (!emailSent) {
      // If email fails, still create the account but inform the user
      return res.status(StatusCodes.CREATED).json({
        message: 'Account created but verification email could not be sent. Please contact support.',
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          isVerified: false
        }
      });
    }

    // Return success response
    res.status(StatusCodes.CREATED).json({
      message: 'Registration successful. Please check your email for verification code.',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isVerified: false
      }
    });
  } catch (error) {
    next(error);
  }
};

const verifyEmail = async (req, res, next) => {
  try {
    const { email, verificationCode } = req.body;

    if (!email || !verificationCode) {
      throw new BadRequestError('Please provide email and verification code');
    }

    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if user is already verified
    if (user.isVerified) {
      return res.status(StatusCodes.OK).json({
        message: 'Email already verified. Please login.',
        isVerified: true
      });
    }

    // Validate verification code
    if (!user.isVerificationCodeValid(verificationCode)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid or expired verification code',
        isVerified: false
      });
    }

    // Mark user as verified
    user.isVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpires = null;

    // Set trial start date to now (when user is actually verified)
    user.trialStartDate = new Date();

    await user.save();

    // Create initial credit transaction
    await CreditTransaction.create({
      user: user._id,
      amount: user.credits,
      type: 'INITIAL',
      description: 'Initial credits',
      balance: user.credits,
      createdAt: new Date()
    });

    // Send welcome email
    await emailService.sendWelcomeEmail(user.email, user.firstName);

    // Generate token for automatic login
    const token = user.createAccessToken();

    const trialEndDate = new Date(user.trialStartDate);
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    // Return success response with token
    res.status(StatusCodes.OK).json({
      message: 'Email verified successfully',
      isVerified: true,
      user: {
        id: user._id,
        firstName: user.firstName,
        email: user.email,
        role: user.role,
        credits: user.credits,
        trialStartDate: user.trialStartDate,
        trialEndDate: trialEndDate,
      },
      token
    });
  } catch (error) {
    next(error);
  }
};

const resendVerificationCode = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw new BadRequestError('Please provide email');
    }

    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if user is already verified
    if (user.isVerified) {
      return res.status(StatusCodes.OK).json({
        message: 'Email already verified. Please login.',
        isVerified: true
      });
    }

    // Generate new verification code
    const verificationCode = user.generateVerificationCode();
    await user.save();

    // Send verification email
    const emailSent = await emailService.sendVerificationEmail(email, user.firstName, verificationCode);

    if (!emailSent) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Could not send verification email. Please try again later.'
      });
    }

    // Return success response
    res.status(StatusCodes.OK).json({
      message: 'Verification code sent. Please check your email.'
    });
  } catch (error) {
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new BadRequestError('Please provide email and password');
    }

    // Find user
    const user = await User.findOne({ email });

    if (!user) {
      throw new UnauthenticatedError('User with this email not found');
    }

    // Check password
    const isPasswordCorrect = await user.comparePassword(password);

    if (!isPasswordCorrect) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    // Check if user is verified
    if (!user.isVerified) {
      return res.status(StatusCodes.FORBIDDEN).json({
        error: 'Email not verified. Please verify your email before logging in.',
        isVerified: false,
        email: user.email
      });
    }

    // Generate tokens
    const accessToken = user.createAccessToken();
    const refreshToken = user.createRefreshToken();

    // 👇 Send refresh token as httpOnly secure cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // set to true in production
      // secure: false,
      sameSite: 'Strict', // or 'Lax'
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    });

    // Calculate trial end date
    const trialEndDate = new Date(user.trialStartDate);
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    // Return user info and token
    res.status(StatusCodes.OK).json({
      user: {
        firstName: user.firstName,
        email: user.email,
        role: user.role,
        credits: user.credits,
        trialStartDate: user.trialStartDate,
        trialEndDate: trialEndDate,
        remainingTrialDays: user.getRemainingTrialDays(),
        isTrialValid: user.isTrialValid(),
        trialStatus: user.trialEnded ? 'ended' : (user.isTrialValid() ? 'active' : 'expired'),
        hasSeenOnboardingVideo: user.hasSeenOnboardingVideo
      },
      accessToken,
      refreshToken
    });
  } catch (error) {
    // Pass the error to the error handling middleware
    next(error);
  }
};

const getOnboardingStatus = async (req, res, next) => {
  const user = await User.findOne({ _id: req.user.userId });
  res.status(StatusCodes.OK).json({ hasSeenOnboardingVideo: user.hasSeenOnboardingVideo });
};

const updateOnboardingStatus = async (req, res, next) => {
  const user = await User.findOne({ _id: req.user.userId });
  user.hasSeenOnboardingVideo = true;
  await user.save();
  res.status(StatusCodes.OK).json({ hasSeenOnboardingVideo: user.hasSeenOnboardingVideo });
};

const refreshToken = async (req, res, next) => {
  const token = req.cookies.refreshToken;
  if (!token) {
    return res.status(401).json({ msg: 'No refresh token found' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(payload.userId);

    if (!user) return res.status(404).json({ message: 'User not found' });

    const newAccessToken = user.createAccessToken();

    res.status(200).json({ accessToken: newAccessToken });
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired refresh token' });
  }
};

const getCurrentUser = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.user.userId }).select('-password -verificationCode -verificationCodeExpires');

    if (!user) {
      throw new UnauthenticatedError('User not found');
    }

    // Calculate trial information
    const trialEndDate = new Date(user.trialStartDate);
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    const userResponse = {
      ...user.toObject(),
      trialEndDate,
      remainingTrialDays: user.getRemainingTrialDays(),
      isTrialValid: user.isTrialValid(),
      trialStatus: user.trialEnded ? 'ended' : (user.isTrialValid() ? 'active' : 'expired')
    };

    res.status(StatusCodes.OK).json({
      user: userResponse
    });
  } catch (error) {
    // Pass the error to the error handling middleware
    next(error);
  }
};

// Request password reset
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw new BadRequestError('Please provide email');
    }

    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      // For security reasons, don't reveal that the user doesn't exist
      return res.status(StatusCodes.OK).json({
        message: 'If your email is registered, you will receive a reset code shortly.'
      });
    }

    // Generate reset password code
    const resetCode = user.generateResetPasswordCode();
    await user.save();

    // Send reset password email
    const emailSent = await emailService.sendResetPasswordEmail(email, user.firstName, resetCode);

    if (!emailSent) {
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Could not send reset password email. Please try again later.'
      });
    }

    // Return success response
    res.status(StatusCodes.OK).json({
      message: 'If your email is registered, you will receive a reset code shortly.'
    });
  } catch (error) {
    next(error);
  }
};

// Reset password with code
const resetPassword = async (req, res, next) => {
  try {
    const { email, resetCode, newPassword } = req.body;

    if (!email || !resetCode || !newPassword) {
      throw new BadRequestError('Please provide email, reset code, and new password');
    }

    if (newPassword.length < 6) {
      throw new BadRequestError('Password must be at least 6 characters long');
    }

    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Validate reset code
    if (!user.isResetPasswordCodeValid(resetCode)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Invalid or expired reset code'
      });
    }

    // Update password
    user.password = newPassword;
    user.resetPasswordCode = null;
    user.resetPasswordCodeExpires = null;
    await user.save();

    // Return success response
    res.status(StatusCodes.OK).json({
      message: 'Password reset successful. You can now log in with your new password.'
    });
  } catch (error) {
    next(error);
  }
};

// Change password
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      throw new BadRequestError('Please provide current password and new password');
    }

    if (newPassword.length < 6) {
      throw new BadRequestError('Password must be at least 6 characters long');
    }

    if (newPassword !== confirmNewPassword) {
      throw new BadRequestError('New password and confirm password do not match');
    }

    // Find user by id
    const user = await User.findOne({ _id: req.user.userId });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if current password is correct
    const isPasswordCorrect = await user.comparePassword(currentPassword);

    if (!isPasswordCorrect) {
      throw new BadRequestError('Current password is incorrect');
    }

    // Update password
    user.password = newPassword;
    await user.save();

    // Return success response
    res.status(StatusCodes.OK).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Get trial status
const getTrialStatus = async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.user.userId });

    if (!user) {
      throw new UnauthenticatedError('User not found');
    }

    // Calculate trial information
    const trialEndDate = new Date(user.trialStartDate);
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    res.status(StatusCodes.OK).json({
      trialInfo: {
        trialStartDate: user.trialStartDate,
        trialEndDate: trialEndDate,
        remainingTrialDays: user.getRemainingTrialDays(),
        isTrialValid: user.isTrialValid(),
        trialStatus: user.trialEnded ? 'ended' : (user.isTrialValid() ? 'active' : 'expired'),
        credits: user.credits,
        subscription: user.subscription
      }
    });
  } catch (error) {
    next(error);
  }
};

// Logout user
const logoutUser = (req, res) => {
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // secure: false,
    sameSite: 'Strict',
  });
  res.status(200).json({ message: 'Logged out' });
};


// Add these to the exports
module.exports = {
  register,
  verifyEmail,
  resendVerificationCode,
  login,
  getOnboardingStatus,
  updateOnboardingStatus,
  refreshToken,
  getCurrentUser,
  getTrialStatus,
  forgotPassword,
  resetPassword,
  changePassword,
  logoutUser
};
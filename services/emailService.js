const nodemailer = require('nodemailer');

// Create a transporter object
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Send verification email
exports.sendVerificationEmail = async (email, name, verificationCode) => {
  try {
    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME || 'SACORE AI'}" <${process.env.EMAIL_FROM || 'noreply@sacoreai.com'}>`,
      to: email,
      subject: 'Verify Your Email Address',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hello ${name},</h2>
          <p>Thank you for registering with SACORE AI. Please verify your email address to complete your registration.</p>
          <p>Your verification code is: <strong>${verificationCode}</strong></p>
          <p>This code will expire in 1 hour.</p>
          <p>If you did not request this verification, please ignore this email.</p>
          <p>Best regards,<br>The SACORE AI Team</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Verification email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending verification email:', error);
    return false;
  }
};

// Send welcome email after verification
exports.sendWelcomeEmail = async (email, name) => {
  try {
    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME || 'SACORE AI'}" <${process.env.EMAIL_FROM || 'noreply@sacoreai.com'}>`,
      to: email,
      subject: 'Welcome to SACORE AI',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to SACORE AI, ${name}!</h2>
          <p>Your email has been verified and your account is now active.</p>
          <p>You can now log in and start using our services.</p>
          <p>Best regards,<br>The SACORE AI Team</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Welcome email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending welcome email:', error);
    return false;
  }
};

// Send reset password email
exports.sendResetPasswordEmail = async (email, name, resetCode) => {
  try {
    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME || 'SACORE AI'}" <${process.env.EMAIL_FROM || 'noreply@sacoreai.com'}>`,
      to: email,
      subject: 'Reset Your Password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Hello ${name},</h2>
          <p>We received a request to reset your password. Please use the following code to reset your password:</p>
          <p>Your reset code is: <strong>${resetCode}</strong></p>
          <p>This code will expire in 1 hour.</p>
          <p>If you did not request this reset, please ignore this email and your password will remain unchanged.</p>
          <p>Best regards,<br>The SACORE AI Team</p>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Reset password email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending reset password email:', error);
    return false;
  }
};
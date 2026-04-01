'use strict';

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_APP_PASSWORD,
  },
});

/**
 * Send welcome email to a newly created teacher with their login credentials.
 */
async function sendWelcomeEmail(email, fullName, teacherCode, tempPassword) {
  await transporter.sendMail({
    from: `"Auriva System" <${process.env.SMTP_EMAIL}>`,
    to: email,
    subject: 'Welcome to Auriva — Your Login Credentials',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: linear-gradient(135deg, #1a1a2e, #2d2b6b); padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 1px;">Auriva</h1>
          <p style="color: rgba(255,255,255,0.75); margin: 8px 0 0; font-size: 14px;">Special Education Learning Platform</p>
        </div>
        <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #e0e0e0; border-top: none;">
          <h2 style="color: #1a1a2e; margin-top: 0;">Welcome, ${fullName}!</h2>
          <p style="color: #555; line-height: 1.6;">Your teacher account has been created on the Auriva platform. Below are your login credentials:</p>

          <div style="background: #f5f7ff; border: 1px solid #c8d0f5; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #888; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; width: 140px;">Teacher Code</td>
                <td style="padding: 8px 0; color: #1a1a2e; font-weight: 700; font-size: 15px;">${teacherCode}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #888; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Email</td>
                <td style="padding: 8px 0; color: #1a1a2e; font-size: 15px;">${email}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #888; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Temp. Password</td>
                <td style="padding: 8px 0; color: #2d2b6b; font-weight: 700; font-size: 15px; font-family: monospace;">${tempPassword}</td>
              </tr>
            </table>
          </div>

          <div style="background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px;">
            <p style="margin: 0; color: #7a5c00; font-size: 13px; line-height: 1.6;">
              <strong>Important:</strong> You will be required to change your password upon your first login. Keep this email secure and do not share your credentials.
            </p>
          </div>

          <p style="color: #555; font-size: 14px; line-height: 1.6;">Open the Auriva app, select <strong>Teacher</strong> on the login screen, and sign in with your email and temporary password above.</p>
        </div>
        <div style="background: #f5f5f5; padding: 16px 24px; border-radius: 0 0 12px 12px; text-align: center; border: 1px solid #e0e0e0; border-top: none;">
          <p style="margin: 0; color: #999; font-size: 12px;">SECURE EDUCATOR ACCESS &bull; AURIVA 2025</p>
        </div>
      </div>
    `,
  });
}

/**
 * Send a password-reset OTP to the teacher's email.
 */
async function sendOtpEmail(email, fullName, otp) {
  await transporter.sendMail({
    from: `"Auriva System" <${process.env.SMTP_EMAIL}>`,
    to: email,
    subject: 'Auriva — Password Reset OTP',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: linear-gradient(135deg, #1a1a2e, #2d2b6b); padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 1px;">Auriva</h1>
          <p style="color: rgba(255,255,255,0.75); margin: 8px 0 0; font-size: 14px;">Special Education Learning Platform</p>
        </div>
        <div style="background: #ffffff; padding: 32px 24px; border: 1px solid #e0e0e0; border-top: none;">
          <h2 style="color: #1a1a2e; margin-top: 0;">Password Reset Request</h2>
          <p style="color: #555; line-height: 1.6;">Hi ${fullName}, we received a request to reset your Auriva password. Use the OTP below to proceed:</p>

          <div style="text-align: center; margin: 32px 0;">
            <div style="display: inline-block; background: #f5f7ff; border: 2px solid #2d2b6b; border-radius: 12px; padding: 20px 40px;">
              <p style="margin: 0 0 4px; color: #888; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Your OTP</p>
              <p style="margin: 0; color: #2d2b6b; font-size: 40px; font-weight: 800; letter-spacing: 8px; font-family: monospace;">${otp}</p>
            </div>
          </div>

          <div style="background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px;">
            <p style="margin: 0; color: #7a5c00; font-size: 13px; line-height: 1.6;">
              <strong>This OTP expires in 10 minutes.</strong> If you did not request a password reset, please ignore this email — your account remains secure.
            </p>
          </div>

          <p style="color: #555; font-size: 14px; line-height: 1.6;">Enter this code in the Auriva app to set a new password.</p>
        </div>
        <div style="background: #f5f5f5; padding: 16px 24px; border-radius: 0 0 12px 12px; text-align: center; border: 1px solid #e0e0e0; border-top: none;">
          <p style="margin: 0; color: #999; font-size: 12px;">SECURE EDUCATOR ACCESS &bull; AURIVA 2025</p>
        </div>
      </div>
    `,
  });
}

module.exports = { sendWelcomeEmail, sendOtpEmail };

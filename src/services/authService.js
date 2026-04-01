'use strict';

const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Op }  = require('sequelize');
const { Principal, Teacher, PasswordResetOtp } = require('../models');
const { sendOtpEmail } = require('./emailService');
const ApiError = require('../utils/ApiError');

const SALT_ROUNDS = 12;
const OTP_EXPIRY_MINUTES = 10;

async function loginPrincipal(username, password) {
  const principal = await Principal.findOne({ where: { username } });
  if (!principal) throw new ApiError(401, 'Invalid credentials');

  const valid = await bcrypt.compare(password, principal.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  return jwt.sign(
    { id: principal.id, role: 'principal' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

async function loginTeacher(email, password) {
  const teacher = await Teacher.findOne({ where: { email } });
  if (!teacher) throw new ApiError(401, 'Invalid credentials');

  const valid = await bcrypt.compare(password, teacher.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  return jwt.sign(
    { id: teacher.tid, role: 'teacher', is_first_login: teacher.is_first_login },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

/**
 * Set a new password for a teacher on first login.
 * Returns a fresh JWT with is_first_login: false.
 */
async function setTeacherPassword(teacherId, newPassword) {
  const teacher = await Teacher.findByPk(teacherId);
  if (!teacher) throw new ApiError(404, 'Teacher not found');
  if (!teacher.is_first_login) throw new ApiError(400, 'Password has already been set');

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await teacher.update({ password_hash: hash, is_first_login: false });

  return jwt.sign(
    { id: teacher.tid, role: 'teacher', is_first_login: false },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

/**
 * Generate and email a 6-digit OTP for password reset.
 * Only teachers can reset via this flow.
 */
async function requestPasswordReset(email) {
  const teacher = await Teacher.findOne({ where: { email } });
  // Always respond the same way to avoid email enumeration
  if (!teacher) return;

  // Invalidate any previous unused OTPs for this email
  await PasswordResetOtp.update(
    { used: true },
    { where: { email, used: false } }
  );

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await PasswordResetOtp.create({ email, otp_code: otp, expires_at });
  await sendOtpEmail(email, teacher.full_name, otp);
}

/**
 * Verify OTP and return a short-lived password-reset token.
 */
async function verifyOtp(email, otp) {
  const record = await PasswordResetOtp.findOne({
    where: {
      email,
      otp_code: otp,
      used: false,
      expires_at: { [Op.gt]: new Date() },
    },
    order: [['created_at', 'DESC']],
  });

  if (!record) throw new ApiError(400, 'Invalid or expired OTP');

  // Mark OTP as used
  await record.update({ used: true });

  const teacher = await Teacher.findOne({ where: { email } });
  if (!teacher) throw new ApiError(404, 'Teacher not found');

  // Issue a short-lived reset token (15 min, scoped)
  return jwt.sign(
    { id: teacher.tid, role: 'teacher', scope: 'password_reset' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

/**
 * Reset teacher password using a valid reset token.
 */
async function resetPassword(teacherId, newPassword) {
  const teacher = await Teacher.findByPk(teacherId);
  if (!teacher) throw new ApiError(404, 'Teacher not found');

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await teacher.update({ password_hash: hash, is_first_login: false });
}

async function hashPassword(plainText) {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

module.exports = {
  loginPrincipal,
  loginTeacher,
  setTeacherPassword,
  requestPasswordReset,
  verifyOtp,
  resetPassword,
  hashPassword,
};

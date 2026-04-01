'use strict';

const { validationResult } = require('express-validator');
const authService = require('../services/authService');
const ApiError    = require('../utils/ApiError');

async function login(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { username, email, password, role } = req.body;

  let token;
  if (role === 'principal') {
    token = await authService.loginPrincipal(username, password);
  } else if (role === 'teacher') {
    token = await authService.loginTeacher(email, password);
  } else {
    throw new ApiError(400, 'role must be "principal" or "teacher"');
  }

  res.json({ token });
}

async function setPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  if (req.user.role !== 'teacher') {
    throw new ApiError(403, 'Only teachers can set a password via this endpoint');
  }

  const token = await authService.setTeacherPassword(req.user.id, req.body.newPassword);
  res.json({ message: 'Password updated successfully', token });
}

async function forgotPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  await authService.requestPasswordReset(req.body.email);
  // Always return success to avoid email enumeration
  res.json({ message: 'If that email is registered, an OTP has been sent.' });
}

async function verifyOtp(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const resetToken = await authService.verifyOtp(req.body.email, req.body.otp);
  res.json({ reset_token: resetToken });
}

async function resetPassword(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  if (req.user.scope !== 'password_reset') {
    throw new ApiError(403, 'Invalid token scope for this operation');
  }

  await authService.resetPassword(req.user.id, req.body.newPassword);
  res.json({ message: 'Password reset successfully. Please log in with your new password.' });
}

module.exports = { login, setPassword, forgotPassword, verifyOtp, resetPassword };

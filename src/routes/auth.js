'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const authController  = require('../controllers/authController');
const {
  loginValidation,
  setPasswordValidation,
  forgotPasswordValidation,
  verifyOtpValidation,
  resetPasswordValidation,
} = require('../validations/teacherValidation');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication endpoints
 */

router.post('/login', loginValidation, authController.login);

router.post('/set-password', verifyToken, setPasswordValidation, authController.setPassword);

router.post('/forgot-password', forgotPasswordValidation, authController.forgotPassword);

router.post('/verify-otp', verifyOtpValidation, authController.verifyOtp);

router.post('/reset-password', verifyToken, resetPasswordValidation, authController.resetPassword);

module.exports = router;

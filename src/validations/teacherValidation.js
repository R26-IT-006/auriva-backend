'use strict';

const { body } = require('express-validator');

const loginValidation = [
  body('role')
    .isIn(['principal', 'teacher'])
    .withMessage('role must be "principal" or "teacher"'),
  body('password')
    .notEmpty()
    .withMessage('password is required'),
];

const setPasswordValidation = [
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

const createTeacherValidation = [
  body('full_name')
    .trim()
    .notEmpty()
    .withMessage('full_name is required'),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('A valid email address is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('System password must be at least 8 characters'),
];

const updateTeacherValidation = [
  body('full_name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('full_name cannot be empty'),
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('A valid email address is required'),
];

const assignStudentValidation = [
  body('teacher_id')
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage('teacher_id must be a positive integer'),
];

const forgotPasswordValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('A valid email address is required'),
];

const verifyOtpValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('A valid email address is required'),
  body('otp')
    .isLength({ min: 6, max: 6 })
    .isNumeric()
    .withMessage('OTP must be a 6-digit number'),
];

const resetPasswordValidation = [
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

module.exports = {
  loginValidation,
  setPasswordValidation,
  createTeacherValidation,
  updateTeacherValidation,
  assignStudentValidation,
  forgotPasswordValidation,
  verifyOtpValidation,
  resetPasswordValidation,
};

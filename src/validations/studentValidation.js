'use strict';

const { body } = require('express-validator');

const createStudentValidation = [
  body('full_name')
    .trim()
    .notEmpty()
    .withMessage('full_name is required'),
  body('date_of_birth')
    .trim()
    .notEmpty().withMessage('date_of_birth is required')
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date_of_birth must be a valid date (YYYY-MM-DD)'),
  body('disability')
    .trim()
    .notEmpty()
    .withMessage('disability is required'),
  body('mobile_number')
    .optional({ checkFalsy: true })
    .matches(/^[+\d\s\-().]{7,20}$/).withMessage('mobile_number must be a valid phone number'),
  body('father_name').optional().trim(),
  body('mother_name').optional().trim(),
  body('address').optional().trim(),
  body('marital_status').optional().trim(),
  body('home_number').optional().trim(),
];

const updateStudentValidation = [
  body('full_name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('full_name cannot be empty'),
  body('date_of_birth')
    .optional({ checkFalsy: true })
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('date_of_birth must be a valid date (YYYY-MM-DD)'),
  body('disability')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('disability cannot be empty'),
  body('mobile_number')
    .optional({ checkFalsy: true })
    .matches(/^[+\d\s\-().]{7,20}$/).withMessage('mobile_number must be a valid phone number'),
  body('father_name').optional().trim(),
  body('mother_name').optional().trim(),
  body('address').optional().trim(),
  body('marital_status').optional().trim(),
  body('home_number').optional().trim(),
];

module.exports = { createStudentValidation, updateStudentValidation };

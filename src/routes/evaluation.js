'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/evaluationController');

router.use(verifyToken, isTeacher);

router.get('/dialogue/evaluations/:studentId', ctrl.getEvaluationStatus);
router.get('/dialogue/evaluations/:studentId/:category', ctrl.buildEvaluation);

router.post('/dialogue/evaluations/:studentId/:category', [
  body('pairs').isArray({ min: 1 }).withMessage('pairs must be a non-empty array'),
  body('pairs.*.word_id').isInt({ min: 1 }).withMessage('pairs[].word_id is required').toInt(),
  body('pairs.*.chosen_word_id_for_image').isInt({ min: 1 }).withMessage('pairs[].chosen_word_id_for_image is required').toInt(),
], ctrl.recordEvaluation);

module.exports = router;

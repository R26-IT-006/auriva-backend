'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl   = require('../controllers/conceptController');

router.get('/:category/items', ctrl.getConceptItems);
router.get('/distractors', ctrl.getDistractors);

router.post('/tier1/start', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
], ctrl.startTier1);

router.post('/tier1/interaction', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('event_type').isString().notEmpty(),
], ctrl.logInteraction);

router.post('/tier1/attempt', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('attempt_number').isInt({ min: 1, max: 3 }),
  body('selected_key').isString().notEmpty(),
  body('correct_key').isString().notEmpty(),
  body('was_correct').isBoolean(),
], ctrl.logMatchAttempt);

router.get('/:conceptKey/confusions', ctrl.getConfusions);

router.post('/tier1/complete', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('passed').isBoolean(),
  body('score').isFloat({ min: 0, max: 1 }),
  body('attempt_count').isInt({ min: 1 }),
], ctrl.completeTier1);

router.post('/adaptive/attempt', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('confused_concept_key').isString().notEmpty(),
  body('round_number').isInt({ min: 1 }),
  body('was_correct').isBoolean(),
], ctrl.logAdaptiveAttempt);

router.post('/adaptive/complete', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('all_passed').isBoolean(),
], ctrl.completeAdaptive);

router.post('/tier2/start', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
], ctrl.startTier2);

router.post('/tier2/complete', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('passed').isBoolean(),
  body('score').isFloat({ min: 0, max: 1 }),
  body('attempt_count').isInt({ min: 1 }),
], ctrl.completeTier2);

router.post('/tier3/start', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
], ctrl.startTier3);

router.post('/tier3/complete', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
], ctrl.completeTier3);

module.exports = router;

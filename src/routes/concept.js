'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl   = require('../controllers/conceptController');
const { singleUpload } = require('../middleware/upload');
const { ownsStudent } = require('../middleware/ownsStudent');

// Every route below acts on one child, identified by an id in the body, query or
// path. Mounted here rather than checked in each handler so that a route added
// later inherits the guard instead of depending on someone remembering it.
//
// The parent router (routes/teacher.js) already establishes *who* is calling;
// this establishes *which children they may touch*. Without it, changing one
// integer reached any teacher's student.
router.use(ownsStudent);

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
  // Optional so older app builds keep working — they simply log null and their
  // rounds stay unusable for distractor evaluation, which is the status quo.
  body('option_keys').optional().isArray({ max: 12 }),
  body('option_keys.*').isString(),
  body('distractor_source').optional().isString().isLength({ max: 40 }),
], ctrl.logMatchAttempt);

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
  body('option_keys').optional().isArray({ max: 12 }),
  body('option_keys.*').isString(),
  body('distractor_source').optional().isString().isLength({ max: 40 }),
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

// ─── Card games (pair match, memory) ─────────────────────────────────────────
// Concepts are chosen server-side from the child's tier 1 + tier 2 mastery, the
// same way the mixed activity picks its own, so the client never decides what is
// under test.
router.post('/game/start', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('activity_type').isIn(['pair_match', 'memory']),
  body('concept_count').optional().isInt({ min: 2, max: 8 }),
], ctrl.startGameActivity);

router.post('/game/complete', [
  body('student_id').isInt({ min: 1 }),
  body('activity_id').isInt({ min: 1 }),
  body('pair_results').isArray({ min: 1, max: 12 }),
  body('pair_results.*.concept_key').isString().notEmpty(),
  body('pair_results.*.was_correct_first_try').isBoolean(),
  body('pair_results.*.confused_with').optional().isArray({ max: 12 }),
  body('pair_results.*.confused_with.*').isString(),
], ctrl.completeGameActivity);

// ─── Tier 3 colouring artwork ────────────────────────────────────────────────
// Multipart: the PNG arrives as `image`, everything else as form fields, so the
// validators run on strings rather than the JSON types used elsewhere.
router.post('/tier3/coloring', singleUpload('image'), [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('stroke_count').optional().isInt({ min: 0 }),
  body('time_spent_ms').optional().isInt({ min: 0 }),
], ctrl.saveColoring);

// ownsStudent is attached again here, not redundantly: router.use() runs before
// route matching, so req.params is still empty when the mounted copy executes.
// This is the only route that identifies the student by path segment, so it is
// the only one that needs the per-route attachment.
router.get('/coloring/:studentId', ownsStudent, ctrl.listColoring);

// ─── Cross-concept activities ────────────────────────────────────────────────
// 3-segment path, so no conflict with /:category/items or /:conceptKey/confusions
router.get('/:category/activity/status', ctrl.getActivityStatus);

router.post('/activity/start', [
  body('student_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('session_id').optional({ nullable: true }).isInt(),
], ctrl.startActivity);

router.post('/activity/attempt', [
  body('student_id').isInt({ min: 1 }),
  body('activity_id').isInt({ min: 1 }),
  body('category_key').isString().notEmpty(),
  body('concept_key').isString().notEmpty(),
  body('round_number').isInt({ min: 1 }),
  body('question_type').isIn(['image_choice', 'name_choice', 'drag_drop']),
  body('was_correct').isBoolean(),
], ctrl.logActivityAttempt);

router.post('/activity/complete', [
  body('student_id').isInt({ min: 1 }),
  body('activity_id').isInt({ min: 1 }),
  body('round_results').isArray({ min: 1 }),
], ctrl.completeActivity);

module.exports = router;

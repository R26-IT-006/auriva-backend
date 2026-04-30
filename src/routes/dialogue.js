'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/dialogueController');

router.use(verifyToken, isTeacher);

// ── Level 1 overview + next-word ─────────────────────────────────────────

router.get('/student/:studentId/level1/overview',  ctrl.getLevel1Overview);
router.get('/student/:studentId/level1/next-word', ctrl.getNextWord);

// ── Phase 1 ───────────────────────────────────────────────────────────────

router.post('/student/:studentId/level1/word/:wordId/phase1-exposure', ctrl.recordPhase1Exposure);

router.post('/student/:studentId/level1/word/:wordId/phase1-gate', [
  body('gate_passed').isBoolean().withMessage('gate_passed must be a boolean'),
], ctrl.recordPhase1Gate);

// ── Phase 2 (speech assessment) ───────────────────────────────────────────

router.post('/student/:studentId/level1/word/:wordId/phase2-assess', [
  body('audio_base64').isString().notEmpty().withMessage('audio_base64 is required'),
  body('mime_type').isString().notEmpty().withMessage('mime_type is required'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.assessPhase2Speech);

// ── Phase 2 non-verbal fallback ───────────────────────────────────────────

router.post('/student/:studentId/level1/word/:wordId/phase2-nonverbal', [
  body('image_selected_correct').isBoolean().withMessage('image_selected_correct must be a boolean'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordNonVerbalResult);

// ── Phase 3 (contextual check) ────────────────────────────────────────────

router.post('/student/:studentId/level1/word/:wordId/phase3-scenario', [
  body('scenario_label').isIn(['A', 'B', 'C', 'checkpoint']).withMessage('scenario_label must be A, B, C, or checkpoint'),
  body('selected_correct').isBoolean().withMessage('selected_correct must be a boolean'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordPhase3Scenario);

router.post('/student/:studentId/level1/word/:wordId/phase3-complete', [
  body('phase3_passed').isBoolean().withMessage('phase3_passed must be a boolean'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordPhase3Result);

module.exports = router;

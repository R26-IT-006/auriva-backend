'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/category3Controller');

router.use(verifyToken, isTeacher);

// ── Cat3 overview + next-word ─────────────────────────────────────────────

router.get('/student/:studentId/cat3/overview',  ctrl.getCat3Overview);
router.get('/student/:studentId/cat3/next-word', ctrl.getNextWord);

// ── Phase 1 – Avatar Performance ──────────────────────────────────────────
// Tap is engagement-only; non-scored. One exposure is enough.

router.post('/student/:studentId/cat3/word/:wordId/phase1-tap', ctrl.recordPhase1Tap);

// ── DragToLine Recognition Gate ───────────────────────────────────────────
// success = correct on first drag; retry_correct = correct after hint; auto_advanced = both attempts failed

router.post('/student/:studentId/cat3/word/:wordId/drag-to-line', [
  body('result')
    .isIn(['success', 'retry_correct', 'auto_advanced'])
    .withMessage('result must be success, retry_correct, or auto_advanced'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordDragToLine);

// ── Phase 2 – Production Practice ────────────────────────────────────────

router.post('/student/:studentId/cat3/word/:wordId/phase2-assess', [
  body('audio_base64').isString().notEmpty().withMessage('audio_base64 is required'),
  body('mime_type').isString().notEmpty().withMessage('mime_type is required'),
  body('session_id').optional().isInt({ min: 1 }),
  body('avatar_audio_end_ts').optional().isInt({ min: 0 }),
  body('recording_start_ts').optional().isInt({ min: 0 }),
], ctrl.assessPhase2Speech);

// Score 0 three times → Word-to-Action Matching non-verbal fallback

router.post('/student/:studentId/cat3/word/:wordId/phase2-nonverbal', [
  body('tap_correct').isBoolean().withMessage('tap_correct must be a boolean'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordPhase2NonVerbal);

// ── Phase 3 – Action Identification Check ────────────────────────────────
// Avatar performs action; child picks the matching word tile.
// second_attempt_correct is omitted when correct_on_first = true.

router.post('/student/:studentId/cat3/word/:wordId/phase3-check', [
  body('correct_on_first').isBoolean().withMessage('correct_on_first must be a boolean'),
  body('second_attempt_correct').optional().isBoolean(),
  body('session_id').optional().isInt({ min: 1 }),
  body('attempt1_latency_ms').optional().isInt({ min: 0 }),
  body('attempt2_latency_ms').optional().isInt({ min: 0 }),
  body('attempt1_first_tap_correct').optional().isBoolean(),
  body('attempt2_first_tap_correct').optional().isBoolean(),
  body('attempt1_selection_change_count').optional().isInt({ min: 0, max: 2 }),
  body('attempt2_selection_change_count').optional().isInt({ min: 0, max: 2 }),
  body('attempt1_prompt_count').optional().isInt({ min: 1 }),
  body('attempt2_prompt_count').optional().isInt({ min: 1 }),
], ctrl.recordPhase3Check);

// ── Complete Word Session (Mastery Algorithm) ─────────────────────────────

router.post('/student/:studentId/cat3/word/:wordId/complete', [
  body('phase3_passed').isBoolean().withMessage('phase3_passed must be a boolean'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.completeWordSession);

// ── Rule 5 — periodic production probe ────────────────────────────────────
// GET probe-candidate is not duplicated here — abilities words are covered
// by dialogueController's GET /level1/probe-candidate (see STATE.md TASK-37
// notes for the association-alias verification behind this).

router.post('/student/:studentId/cat3/word/:wordId/probe-result', [
  body('audio_base64').isString().notEmpty().withMessage('audio_base64 is required'),
  body('mime_type').isString().notEmpty().withMessage('mime_type is required'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordProbeResult);

module.exports = router;

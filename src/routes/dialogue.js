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

// RC-PROMPT: minimal word lookup (id + cue_grapheme) — not student-scoped,
// used by Phase 2 screens to fetch cue_grapheme by wordId at mount time.
router.get('/word/:wordId', ctrl.getWordById);

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
  body('avatar_audio_end_ts').optional().isInt({ min: 0 }),
  body('recording_start_ts').optional().isInt({ min: 0 }),
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
  body('response_latency_ms').optional().isInt({ min: 0 }),
  body('selection_change_count').optional().isInt({ min: 0, max: 2 })
    .withMessage('selection_change_count must be an integer between 0 and 2'),
  body('prompt_count').optional().isInt({ min: 1 }),
  body('first_tap_correct').optional().isBoolean(),
], ctrl.recordPhase3Scenario);

router.post('/student/:studentId/level1/word/:wordId/phase3-complete', [
  body('phase3_passed').isBoolean().withMessage('phase3_passed must be a boolean'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordPhase3Result);

// ── Rule 5 — periodic production probe ────────────────────────────────────

router.get('/student/:studentId/level1/probe-candidate', ctrl.getProbeCandidate);

router.post('/student/:studentId/level1/word/:wordId/probe-result', [
  body('audio_base64').isString().notEmpty().withMessage('audio_base64 is required'),
  body('mime_type').isString().notEmpty().withMessage('mime_type is required'),
  body('session_id').optional().isInt({ min: 1 }),
], ctrl.recordProbeResult);

// ── TASK-38 — trajectory-driven difficulty ladder / dwell adaptivity ──────

router.get('/student/:studentId/word/:wordId/trajectory', ctrl.getTrajectory);

// ── TASK-43 — explainable AI for trajectory predictions (teacher reports) ──

router.get('/student/:studentId/word/:wordId/trajectory/explain', ctrl.getTrajectoryExplanation);
router.get('/student/:studentId/dialogue/trajectory-report',      ctrl.getTrajectoryReport);

// ── TASK-47 — practice-trend timelines (module-level and per-word) ────────

router.get('/student/:studentId/dialogue/timeline',           ctrl.getDialogueTimeline);
router.get('/student/:studentId/word/:wordId/dialogue/timeline', ctrl.getWordTimeline);

// ── TASK-12 — Non-Verbal Adaptive Wait-Time Escalation ────────────────────

router.get('/student/:studentId/speech-state', ctrl.getDailySpeechState);

module.exports = router;

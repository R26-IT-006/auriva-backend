'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body }        = require('express-validator');
const ctrl            = require('../controllers/daysOfWeekController');

router.use(verifyToken, isTeacher);

// ── Phase 3 question data for a specific days_of_week word ────────────────
// Returns either a 'sequence' check (individual day names) or
// 'phrase_completion' check (conversational phrases), with options + correct answer.

router.get(
  '/student/:studentId/level1/days/phase3-question/:wordId',
  ctrl.getPhase3Question,
);

// ── UC2 – Day of the Week Wheel (Spinning Wheel) ──────────────────────────
// GET  – returns wheel config for the next round
// POST – records a single tap attempt

router.get(
  '/student/:studentId/level1/days/spinning-wheel',
  ctrl.getSpinningWheelRound,
);

router.post(
  '/student/:studentId/level1/days/spinning-wheel/attempt',
  [
    body('target_word_id')
      .isInt({ min: 1 })
      .withMessage('target_word_id must be a positive integer'),
    body('selected_word_id')
      .isInt({ min: 1 })
      .withMessage('selected_word_id must be a positive integer'),
    body('session_id').optional().isInt({ min: 1 }),
  ],
  ctrl.recordSpinningWheelAttempt,
);

module.exports = router;

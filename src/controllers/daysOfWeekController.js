'use strict';

// RETIRED 2026-07 — Days of the Week removed from Level 1 (R-10). Route unregistered; file retained for data integrity.
const { validationResult } = require('express-validator');
const daysService = require('../services/daysOfWeekService');
const ApiError    = require('../utils/ApiError');

async function getPhase3Question(req, res) {
  const data = await daysService.getPhase3Question(
    req.user.id,
    req.params.studentId,
    req.params.wordId,
  );
  res.json(data);
}

async function getSpinningWheelRound(req, res) {
  // Accept attempted_word_ids as a comma-separated query string, e.g. ?attempted_word_ids=1,2,3
  const raw = req.query.attempted_word_ids;
  const attemptedWordIds = raw
    ? String(raw).split(',').map(Number).filter((n) => !Number.isNaN(n) && n > 0)
    : [];

  const data = await daysService.getSpinningWheelRound(
    req.user.id,
    req.params.studentId,
    attemptedWordIds,
  );
  res.json(data);
}

async function recordSpinningWheelAttempt(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await daysService.recordSpinningWheelAttempt(
    req.user.id,
    req.params.studentId,
    req.body,
  );
  res.json(result);
}

module.exports = {
  getPhase3Question,
  getSpinningWheelRound,
  recordSpinningWheelAttempt,
};

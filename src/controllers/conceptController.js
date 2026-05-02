'use strict';

const { validationResult } = require('express-validator');
const conceptService       = require('../services/conceptService');
const ApiError             = require('../utils/ApiError');

async function getConceptItems(req, res) {
  const { category } = req.params;
  const studentId = parseInt(req.query.student_id, 10);
  if (!studentId) throw new ApiError(422, 'student_id query param is required');

  const items = await conceptService.getConceptItems(category, studentId);
  res.json(items);
}

async function startTier1(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, category_key, concept_key } = req.body;
  const result = await conceptService.startTier1(student_id, category_key, concept_key);
  res.status(201).json(result);
}

async function logInteraction(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, session_id, category_key, concept_key, tier, event_type, event_data } = req.body;
  const result = await conceptService.logInteraction(
    student_id, session_id, category_key, concept_key, tier || 1, event_type, event_data
  );
  res.status(201).json(result);
}

async function logMatchAttempt(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const {
    student_id, session_id, category_key, concept_key,
    attempt_number, selected_key, correct_key, time_taken_ms, was_correct,
  } = req.body;

  const result = await conceptService.logInteraction(
    student_id,
    session_id,
    category_key,
    concept_key,
    1,
    'match_attempt',
    { attempt_number, selected_key, correct_key, time_taken_ms, was_correct },
  );
  res.status(201).json(result);
}

async function completeTier1(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const {
    student_id, category_key, concept_key,
    passed, score, attempt_count, confused_with,
  } = req.body;

  const result = await conceptService.completeTier1(
    student_id, category_key, concept_key,
    passed, score, attempt_count, confused_with || [],
  );
  res.json(result);
}

module.exports = { getConceptItems, startTier1, logInteraction, logMatchAttempt, completeTier1 };

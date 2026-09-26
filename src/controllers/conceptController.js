'use strict';

const { validationResult } = require('express-validator');
const conceptService       = require('../services/conceptService');
const activityService      = require('../services/activityService');
const coloringService      = require('../services/coloringService');
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
    option_keys, distractor_source,
  } = req.body;

  const result = await conceptService.logInteraction(
    student_id,
    session_id,
    category_key,
    concept_key,
    1,
    'match_attempt',
    // option_keys records what the child was actually shown. Without it the log
    // only says what they picked, and a picked option is only ever one the
    // policy offered — so any offline evaluation of distractor quality measures
    // the policy, not the child. See ml/PHASE1-FINDINGS.md: 97% of observed
    // confusions were with a sequential neighbour purely because the sequential
    // fallback chose them. distractor_source records which fallback tier ran.
    {
      attempt_number, selected_key, correct_key, time_taken_ms, was_correct,
      option_keys: option_keys || null,
      distractor_source: distractor_source || null,
    },
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

async function getDistractors(req, res) {
  const studentId  = parseInt(req.query.student_id, 10);
  const { category_key, concept_key } = req.query;
  const tier = parseInt(req.query.tier || '1', 10);
  if (!studentId) throw new ApiError(422, 'student_id required');
  if (!category_key || !concept_key) throw new ApiError(422, 'category_key and concept_key required');
  const result = await conceptService.getDistractors(studentId, category_key, concept_key, tier);
  res.json(result);
}

async function logAdaptiveAttempt(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const {
    student_id, session_id, category_key, concept_key,
    confused_concept_key, round_number, was_correct, time_taken_ms,
    option_keys, distractor_source,
  } = req.body;

  const result = await conceptService.logAdaptiveAttempt(
    student_id, session_id, category_key, concept_key,
    confused_concept_key, round_number, was_correct, time_taken_ms,
    { option_keys, distractor_source },
  );
  res.status(201).json(result);
}

async function completeAdaptive(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const {
    student_id, session_id, category_key, concept_key,
    confused_keys, round_results, all_passed,
  } = req.body;

  const result = await conceptService.completeAdaptive(
    student_id, session_id, category_key, concept_key,
    confused_keys || [], round_results || [], all_passed,
  );
  res.json(result);
}

async function startTier2(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const { student_id, category_key, concept_key } = req.body;
  const result = await conceptService.startTier2(student_id, category_key, concept_key);
  res.status(201).json(result);
}

async function completeTier2(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const { student_id, category_key, concept_key, passed, score, attempt_count, confused_with } = req.body;
  const result = await conceptService.completeTier2(student_id, category_key, concept_key, passed, score, attempt_count, confused_with || []);
  res.json(result);
}

async function startTier3(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const { student_id, category_key, concept_key } = req.body;
  const result = await conceptService.startTier3(student_id, category_key, concept_key);
  res.status(201).json(result);
}

async function completeTier3(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
  const { student_id, category_key, concept_key, time_spent_ms } = req.body;
  const result = await conceptService.completeTier3(student_id, category_key, concept_key, time_spent_ms || 0);
  res.json(result);
}

// ─── Cross-concept activities ────────────────────────────────────────────────

async function getActivityStatus(req, res) {
  const { category } = req.params;
  const studentId = parseInt(req.query.student_id, 10);
  if (!studentId) throw new ApiError(422, 'student_id query param is required');

  const result = await activityService.getActivityStatus(studentId, category);
  res.json(result);
}

async function startActivity(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, category_key, session_id } = req.body;
  const result = await activityService.startActivity(student_id, category_key, session_id);
  res.status(201).json(result);
}

async function logActivityAttempt(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, session_id, ...payload } = req.body;
  const result = await activityService.logActivityAttempt(student_id, session_id, payload);
  res.status(201).json(result);
}

async function completeActivity(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, activity_id, round_results, session_id } = req.body;
  const result = await activityService.completeActivity(
    student_id, activity_id, round_results || [], session_id,
  );
  res.json(result);
}

// ─── Card games (pair match, memory) ─────────────────────────────────────────

async function startGameActivity(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, category_key, activity_type, concept_count } = req.body;
  const result = await activityService.startGameActivity(
    student_id, category_key, activity_type, concept_count || 4,
  );
  res.status(201).json(result);
}

async function completeGameActivity(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, activity_id, pair_results, session_id } = req.body;
  const result = await activityService.completeGameActivity(
    student_id, activity_id, pair_results || [], session_id,
  );
  res.json(result);
}

// ─── Tier 3 colouring artwork ────────────────────────────────────────────────

async function saveColoring(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const { student_id, category_key, concept_key, stroke_count, time_spent_ms } = req.body;
  const result = await coloringService.saveArtwork(
    parseInt(student_id, 10), category_key, concept_key, req.file,
    {
      // Multipart fields arrive as strings.
      strokeCount: stroke_count  != null ? parseInt(stroke_count, 10)  : null,
      timeSpentMs: time_spent_ms != null ? parseInt(time_spent_ms, 10) : null,
    },
  );
  res.status(201).json(result);
}

async function listColoring(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'studentId is required');

  const items = await coloringService.listArtworks(studentId, req.query.category_key);
  res.json(items);
}

module.exports = { getConceptItems, startTier1, logInteraction, logMatchAttempt, completeTier1, getDistractors, logAdaptiveAttempt, completeAdaptive, startTier2, completeTier2, startTier3, completeTier3, getActivityStatus, startActivity, logActivityAttempt, completeActivity, startGameActivity, completeGameActivity, saveColoring, listColoring };

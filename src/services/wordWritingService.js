'use strict';

const { WordWritingAttempt, WordActivityProgress } = require('../models');
const { scoreWord } = require('./wordScoringService');
const { computeWordLayoutMetrics, resolveChildFeedbackAdvisory, scoreToConsistencyLabel } = require('./wordLayoutService');

const STAGES = new Set(['guided_word_writing', 'practice_exercise_e']);
const ACTIVITIES = new Set(['A', 'B', 'C', 'D']);

async function upsertActivity({ studentId, word, activity, status }) {
  if (!ACTIVITIES.has(activity) || !['correct', 'good'].includes(status)) return { status: 'invalid_input' };
  const normalized = String(word || '').toLowerCase();
  const [row] = await WordActivityProgress.findOrCreate({
    where: { student_id: studentId, word: normalized },
    defaults: { student_id: studentId, word: normalized, source_letter: normalized[0], activity_status: {} },
  });
  await row.update({ activity_status: { ...(row.activity_status || {}), [activity]: status } });
  return { status: 'saved', progress: row };
}

async function saveAttempt(input) {
  if (!STAGES.has(input.stage) || typeof input.actionId !== 'string') return { status: 'invalid_input' };
  const existing = await WordWritingAttempt.findOne({ where: { action_id: input.actionId } });
  if (existing) return { status: 'saved', duplicate: true, attempt: existing };

  // Scoring deliberately receives the original device coordinate space.
  const result = scoreWord({
    word: input.word,
    strokes: input.strokes,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
  });
  if (!result.valid) return { status: result.error };

  // Word-layout-metrics task — additive research measurements, computed
  // from the SAME raw strokes/canonical template scoreWord just used, never
  // from anything the client sent. Applies identically to both stages
  // (guided_word_writing and practice_exercise_e — same call site, no
  // special-casing). Never influences score/passed/completionPassed above,
  // which are already finalized by this point. Merged into
  // normalized_features (no new column, no migration) rather than
  // replacing result.features's existing {dtw_distance, smoothness} keys.
  const wordLayout = computeWordLayoutMetrics({
    word: input.word,
    strokes: input.strokes,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
  });
  const childFeedback = resolveChildFeedbackAdvisory(wordLayout);

  const support = input.stage === 'guided_word_writing'
    ? ({ 1: 'high', 2: 'medium', 3: 'low' }[input.attemptNumber] || null)
    : null;

  let attempt;
  try {
    attempt = await WordWritingAttempt.create({
      action_id: input.actionId,
      student_id: input.studentId,
      word: String(input.word).toLowerCase(),
      source_letter: String(input.word)[0].toLowerCase(),
      stage: input.stage,
      attempt_number: input.attemptNumber ?? null,
      support_stage: support,
      score: result.score,
      threshold_used: result.thresholdUsed,
      passed: result.passed,
      completion_passed: result.completionPassed,
      expected_letter_count: result.expectedLetterCount,
      covered_letter_count: result.coveredLetterCount,
      strokes: input.strokes,
      normalized_features: { ...result.features, word_layout: wordLayout },
      // PostgreSQL columns are INTEGER. Round only at persistence; never
      // change the dimensions used by scoreWord above.
      canvas_width: Math.round(Number(input.canvasWidth)),
      canvas_height: Math.round(Number(input.canvasHeight)),
      capture_status: 'complete',
      collection_mode: false,
      word_score_version: result.scoreVersion,
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      attempt = await WordWritingAttempt.findOne({ where: { action_id: input.actionId } });
      return { status: 'saved', duplicate: true, attempt };
    }
    throw error;
  }

  if (input.stage === 'practice_exercise_e' && result.passed) {
    const normalized = String(input.word).toLowerCase();
    const [row] = await WordActivityProgress.findOrCreate({
      where: { student_id: input.studentId, word: normalized },
      defaults: { student_id: input.studentId, word: normalized, source_letter: normalized[0], activity_status: {} },
    });
    await row.update({ activity_status: { ...(row.activity_status || {}), E: 'correct' } });
  }

  // childFeedback is a simple advisory ('size'|'spacing'|'both'|null) for
  // OPTIONAL child-facing copy — never raw numbers, never affects
  // score/passed. The controller decides whether to forward it at all.
  return { status: 'saved', duplicate: false, attempt, childFeedback };
}

async function getProgress(studentId) {
  const rows = await WordActivityProgress.findAll({ where: { student_id: studentId }, order: [['source_letter', 'ASC'], ['word', 'ASC']] });
  const result = {};
  rows.forEach(row => {
    const progress = row.get ? row.get({ plain: true }) : row;
    (result[progress.source_letter] ??= []).push({ word: progress.word, status: progress.activity_status });
  });
  return result;
}

async function getAttempts(studentId) {
  return WordWritingAttempt.findAll({ where: { student_id: studentId, collection_mode: false }, attributes: { exclude: ['strokes'] }, order: [['created_at', 'DESC']] });
}

async function getReport(studentId) {
  const [progress, attempts] = await Promise.all([getProgress(studentId), getAttempts(studentId)]);
  const byWord = {};
  attempts.forEach(row => {
    const attempt = row.get ? row.get({ plain: true }) : row;
    if (attempt.stage === 'practice_exercise_e') (byWord[attempt.word] ??= []).push(attempt);
  });
  const words = Object.entries(byWord).map(([word, list]) => ({
    word,
    latest_score: list[0].score,
    best_score: Math.max(...list.map(attempt => attempt.score)),
    attempt_count: list.length,
    passed: list.some(attempt => attempt.passed),
    last_practised: list[0].created_at,
    // Word-layout-metrics task — a small, non-numeric summary from the
    // MOST RECENT attempt's stored word_layout (already computed at save
    // time; nothing recomputed here). Interpreted labels only — see
    // scoreToConsistencyLabel's own disclosed pilot/engineering bands.
    // null (not a fabricated label) when that attempt's layout data is
    // unavailable, e.g. a pre-this-feature historical row.
    letter_size: scoreToConsistencyLabel(list[0].normalized_features?.word_layout?.size_consistency_score ?? null),
    letter_spacing: scoreToConsistencyLabel(list[0].normalized_features?.word_layout?.spacing_consistency_score ?? null),
  }));
  return { progress, words, summary: { words_practised: words.length, words_completed: words.filter(word => word.passed).length } };
}

module.exports = { saveAttempt, upsertActivity, getProgress, getAttempts, getReport };

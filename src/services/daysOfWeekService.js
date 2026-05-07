'use strict';

const { Op } = require('sequelize');
const { DialogueWord, DialogueWordProgress, DaysWheelAttempt, Student } = require('../models');
const ApiError = require('../utils/ApiError');

// Canonical teaching order for individual day names
const DAY_ASSET_KEYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function assertStudentBelongsToTeacher(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

/**
 * Returns individual day-name words (teaching_order 1–7) that are
 * in_progress or mastered for the student, sorted by teaching_order.
 * When includeWordId is provided, that word is always included regardless of status
 * (covers the current word mid-session which is in_progress but may not yet be stored).
 */
async function getIntroducedDayWords(studentId, includeWordId = null) {
  const allDays = await DialogueWord.findAll({
    where: { category: 'days_of_week', teaching_order: { [Op.lte]: 7 } },
    order: [['teaching_order', 'ASC']],
    include: [{
      model: DialogueWordProgress,
      as: 'progress',
      where: { student_id: studentId },
      required: false,
    }],
  });

  return allDays.filter((w) => {
    const status = w.progress?.[0]?.status ?? 'not_started';
    return status === 'in_progress' || status === 'mastered' || w.id === includeWordId;
  });
}

/**
 * Fills a distractor list to length 2, drawing from the full day sequence
 * when the introduced pool is too small.
 */
async function fillDistractors(existing, excludeId) {
  if (existing.length >= 2) return existing.slice(0, 2);

  const allDays = await DialogueWord.findAll({
    where: { category: 'days_of_week', teaching_order: { [Op.lte]: 7 } },
    order: [['teaching_order', 'ASC']],
  });

  const pool = allDays.filter(
    (d) => d.id !== excludeId && !existing.some((e) => e.id === d.id),
  );

  const result = [...existing];
  for (const d of pool) {
    if (result.length >= 2) break;
    result.push(d);
  }
  return result;
}

// ── Phase 3 question builders ─────────────────────────────────────────────

async function buildSequenceQuestion(studentId, word) {
  const dayIdx = DAY_ASSET_KEYS.indexOf(word.asset_key);
  const previousAssetKey = dayIdx > 0 ? DAY_ASSET_KEYS[dayIdx - 1] : null;
  const previousDayLabel = previousAssetKey ? capitalize(previousAssetKey) : null;

  // Include the target word itself (it is the "current" word being learned)
  const introduced = await getIntroducedDayWords(studentId, word.id);
  const rawDistractors = introduced.filter((d) => d.id !== word.id);
  const distractors = await fillDistractors(rawDistractors, word.id);

  const options = shuffle([
    { word_id: word.id, word: word.word, asset_key: word.asset_key },
    ...distractors.map((d) => ({ word_id: d.id, word: d.word, asset_key: d.asset_key })),
  ]);

  return {
    type: 'sequence',
    question: previousDayLabel
      ? `What comes after ${previousDayLabel}?`
      : 'Which day comes first in the week?',
    previous_day: previousDayLabel,
    previous_day_asset_key: previousAssetKey,
    // Frontend uses this key to load the weekly calendar strip asset
    calendar_image_key: previousAssetKey
      ? `calendar_sequence_${previousAssetKey}`
      : 'calendar_start',
    options,
    correct_word_id: word.id,
  };
}

async function buildPhraseCompletionQuestion(studentId) {
  const introduced = await getIntroducedDayWords(studentId);

  if (introduced.length === 0) {
    throw new ApiError(422, 'No introduced day names available for phrase completion check');
  }

  // Deterministically pick the first introduced day as the classroom board day
  const boardDay = introduced[0];

  const rawOthers = introduced.filter((d) => d.id !== boardDay.id);
  const others = await fillDistractors(rawOthers, boardDay.id);

  const options = shuffle([
    { word_id: boardDay.id, word: boardDay.word, asset_key: boardDay.asset_key, label: `Today is ${boardDay.word}` },
    ...others.map((d) => ({
      word_id: d.id,
      word: d.word,
      asset_key: d.asset_key,
      label: `Today is ${d.word}`,
    })),
  ]);

  return {
    type: 'phrase_completion',
    question: "What's the day today?",
    // Frontend loads classroom scene image showing this day written on the board
    classroom_image_key: `classroom_${boardDay.asset_key}`,
    board_day_word: boardDay.word,
    board_day_asset_key: boardDay.asset_key,
    board_day_word_id: boardDay.id,
    options,
    correct_word_id: boardDay.id,
  };
}

// ── Public service functions ──────────────────────────────────────────────

/**
 * GET /days/phase3-question/:wordId
 *
 * Returns the Phase 3 question payload for a days_of_week word.
 *
 * Individual day names (teaching_order 1–7):
 *   type: 'sequence' — "What comes after [previous day]?"
 *   Three day-name buttons: correct next day + 2 distractors from introduced set.
 *
 * Conversational phrases (teaching_order 8–9):
 *   type: 'phrase_completion' — "What's the day today?"
 *   Classroom scene image; three "Today is ___" options using introduced days.
 */
async function getPhase3Question(teacherId, studentId, wordId) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const word = await DialogueWord.findOne({
    where: { id: wordId, category: 'days_of_week' },
  });
  if (!word) throw new ApiError(404, 'Days of the week word not found');

  const isPhrase = word.teaching_order >= 8;
  return isPhrase
    ? buildPhraseCompletionQuestion(studentId)
    : buildSequenceQuestion(studentId, word);
}

/**
 * GET /days/spinning-wheel
 *
 * Returns the next wheel round configuration.
 * Requires ≥3 day names to be in_progress or mastered (FSD UC2 pre-condition).
 *
 * Query: attempted_word_ids — comma-separated word IDs already tested this session.
 * The system picks the first introduced day not yet attempted (cycles back when all done).
 */
async function getSpinningWheelRound(teacherId, studentId, attemptedWordIds) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const introduced = await getIntroducedDayWords(studentId);

  // TEMP: lock disabled for testing — restore by uncommenting the block below
  if (introduced.length < 3) {
     return {
       available: false,
       reason: 'At least 3 day names must be in progress or mastered to unlock the Spinning Wheel',
     };
  }

  const attempted = new Set((attemptedWordIds || []).map(Number));
  // System-controlled selection: first introduced day not yet tested this session
  let target = introduced.find((d) => !attempted.has(d.id));
  // When all have been covered this session, cycle back to the first
  if (!target) target = introduced[0];

  const rawOthers = introduced.filter((d) => d.id !== target.id);
  // Always have exactly 3 options; fillDistractors pads from full day list if needed
  const distractors = await fillDistractors(rawOthers, target.id);

  const options = shuffle([
    { word_id: target.id, word: target.word, asset_key: target.asset_key },
    ...distractors.map((d) => ({ word_id: d.id, word: d.word, asset_key: d.asset_key })),
  ]);

  return {
    available: true,
    introduced_days: introduced.map((d) => ({
      word_id: d.id,
      word: d.word,
      asset_key: d.asset_key,
    })),
    target: { word_id: target.id, word: target.word, asset_key: target.asset_key },
    options,
  };
}

/**
 * POST /days/spinning-wheel/attempt
 * Records a single spinning wheel tap attempt.
 */
async function recordSpinningWheelAttempt(teacherId, studentId, { target_word_id, selected_word_id, session_id }) {
  await assertStudentBelongsToTeacher(teacherId, studentId);

  const [target, selected] = await Promise.all([
    DialogueWord.findOne({ where: { id: target_word_id, category: 'days_of_week' } }),
    DialogueWord.findOne({ where: { id: selected_word_id, category: 'days_of_week' } }),
  ]);
  if (!target || !selected) throw new ApiError(404, 'One or both word IDs are not valid days_of_week words');

  const correct = target_word_id === selected_word_id;

  await DaysWheelAttempt.create({
    student_id:       studentId,
    session_id:       session_id ?? null,
    target_word_id,
    selected_word_id,
    correct,
  });

  return {
    correct,
    target_word:   target.word,
    selected_word: selected.word,
  };
}

module.exports = {
  getPhase3Question,
  getSpinningWheelRound,
  recordSpinningWheelAttempt,
};

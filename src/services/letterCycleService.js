'use strict';

/**
 * letterCycleService.js
 *
 * How many 3-attempt cycles a letter has already had today, and which letters
 * have used both of theirs without being mastered.
 *
 * ── Derived, not stored ──────────────────────────────────────────────────
 * No new table and no new column. Everything here comes from rows that already
 * exist:
 *
 *   one cycle          = one distinct `session_key` (handwritingController
 *                        mints one randomUUID per POST /letter-complete, and
 *                        every attempt row in that POST shares it)
 *   attempt numbering  = `attempt_number` 1/2/3, already per-cycle
 *   the date           = `created_at`, bucketed in the practice timezone
 *   the outcome        = `passed`, identical across a cycle's rows
 *   mastery            = LetterProgress.mastered_at, untouched by this file
 *
 * ── Normal learning only ─────────────────────────────────────────────────
 * The same exclusion set every other normal-learning query in this codebase
 * uses (see adaptiveSupportService / dynamicThresholdService):
 *
 *   collection_mode = false   research data-collection protocol
 *   source_type IS NULL       excludes reassessment and Writing Check rows
 *   capture_status = complete excludes partial captures
 *
 * A Writing Check writes with collection_mode true, so it can neither consume
 * a child's practice cycles nor be capped by them.
 *
 * ── This service decides nothing about mastery ───────────────────────────
 * It counts and reports. `mastered_at` is set exclusively by the existing
 * in-app pass logic in handwritingController; nothing here writes anything at
 * all.
 */

const { Op, fn, col } = require('sequelize');
const { LetterAttempt, LetterProgress } = require('../models');
const logger = require('../utils/logger');
const {
  MAX_CYCLES_PER_LETTER_PER_DATE, toPracticeDate, currentPracticeDate, CYCLE_CAP_REASON,
} = require('../config/practiceCyclePolicy');

const COMPLETE = 'complete';

/** The exclusion set shared by every read here. */
function normalLearningWhere(studentId) {
  return {
    student_id: studentId,
    collection_mode: false,
    source_type: null,
    capture_status: COMPLETE,
  };
}

function isPositiveInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isValidLetter(v) {
  return typeof v === 'string' && /^[A-Za-z]$/.test(v);
}
function isValidCaseType(v) {
  return v === 'lowercase' || v === 'uppercase';
}

/**
 * Groups attempt rows into cycles keyed by session_key, preserving the order
 * they were written in. A cycle counts as COMPLETED once it carries the full
 * three attempts; a half-finished cycle (app closed mid-way) is not counted
 * against the child's two.
 */
function groupIntoCycles(rows) {
  const bySession = new Map();
  for (const row of rows) {
    const key = row.session_key;
    if (!key) continue;
    if (!bySession.has(key)) {
      bySession.set(key, {
        sessionKey: key,
        attemptNumbers: [],
        passed: Boolean(row.passed),
        firstAt: row.created_at,
        lastAt: row.created_at,
      });
    }
    const cycle = bySession.get(key);
    cycle.attemptNumbers.push(row.attempt_number);
    // `passed` is written identically across a cycle's rows; OR is defensive.
    cycle.passed = cycle.passed || Boolean(row.passed);
    if (row.created_at < cycle.firstAt) cycle.firstAt = row.created_at;
    if (row.created_at > cycle.lastAt) cycle.lastAt = row.created_at;
  }

  return [...bySession.values()]
    .map(c => ({ ...c, complete: c.attemptNumbers.length >= 3 }))
    .sort((a, b) => new Date(a.firstAt) - new Date(b.firstAt));
}

/**
 * How many completed cycles this exact letter has had on one practice date.
 *
 * @param {{studentId: number, letter: string, caseType: string, date?: string}} args
 * @returns {Promise<{
 *   status: 'ok'|'invalid_input'|'read_failed',
 *   date: string|null,
 *   cycles: number,            // completed cycles on that date
 *   failedCycles: number,
 *   passedCycles: number,
 *   remaining: number,         // cycles still available today
 *   capReached: boolean,
 *   reason: string,
 * }>}
 */
async function getCycleUsageForDate({ studentId, letter, caseType, date = null }) {
  const empty = {
    date: null, cycles: 0, failedCycles: 0, passedCycles: 0,
    remaining: MAX_CYCLES_PER_LETTER_PER_DATE, capReached: false,
  };
  if (!isPositiveInteger(studentId) || !isValidLetter(letter) || !isValidCaseType(caseType)) {
    return { status: 'invalid_input', ...empty, reason: CYCLE_CAP_REASON.UNKNOWN_DATE };
  }

  const targetDate = date ?? currentPracticeDate();
  if (!targetDate) {
    return { status: 'invalid_input', ...empty, reason: CYCLE_CAP_REASON.UNKNOWN_DATE };
  }

  let rows;
  try {
    // Read a generous window and bucket in JS rather than pushing a timezone
    // expression into SQL: the practice timezone lives in ONE place
    // (practiceCyclePolicy) and cannot drift between a query and a report.
    // Three days is ample for a single date in any timezone.
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    rows = await LetterAttempt.findAll({
      where: {
        ...normalLearningWhere(studentId),
        letter, case_type: caseType,
        created_at: { [Op.gte]: since },
      },
      attributes: ['session_key', 'attempt_number', 'passed', 'created_at'],
      order: [['created_at', 'ASC'], ['id', 'ASC']],
      raw: true,
    });
  } catch (err) {
    logger.error('Cycle usage read failed', {
      studentId, letter, caseType, errorMessage: err.message,
    });
    // Fails CLOSED on the cap question is wrong here: a read failure must not
    // silently block a child from practising. It reports the failure and
    // leaves the frontend's own in-interaction guard as the active limit.
    return { status: 'read_failed', ...empty, reason: CYCLE_CAP_REASON.READ_FAILED };
  }

  const onDate = groupIntoCycles(rows).filter(
    c => c.complete && toPracticeDate(c.lastAt) === targetDate,
  );
  const cycles = onDate.length;
  const passedCycles = onDate.filter(c => c.passed).length;
  const capReached = cycles >= MAX_CYCLES_PER_LETTER_PER_DATE;

  return {
    status: 'ok',
    date: targetDate,
    cycles,
    failedCycles: cycles - passedCycles,
    passedCycles,
    remaining: Math.max(0, MAX_CYCLES_PER_LETTER_PER_DATE - cycles),
    capReached,
    reason: capReached ? CYCLE_CAP_REASON.CAP_REACHED : CYCLE_CAP_REASON.WITHIN_CAP,
  };
}

/**
 * The letters that used BOTH of today's cycles and failed both, and are still
 * unmastered — the exact-letter home-practice candidates.
 *
 * Deliberately narrow: two failed cycles, same date, same case, not mastered.
 * It says nothing about families, windows or longitudinal difficulty; that is
 * the separate 10-cycle persistent-difficulty mechanism's job, and this does
 * not touch or weaken it.
 *
 * @param {{studentId: number, date?: string}} args
 * @returns {Promise<{status: string, date: string|null, letters: Array}>}
 */
async function getTwoCycleFailureLetters({ studentId, date = null }) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', date: null, letters: [] };
  }
  const targetDate = date ?? currentPracticeDate();
  if (!targetDate) return { status: 'invalid_input', date: null, letters: [] };

  let rows;
  try {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    rows = await LetterAttempt.findAll({
      where: { ...normalLearningWhere(studentId), created_at: { [Op.gte]: since } },
      attributes: ['letter', 'case_type', 'session_key', 'attempt_number', 'passed', 'created_at'],
      order: [['created_at', 'ASC'], ['id', 'ASC']],
      raw: true,
    });
  } catch (err) {
    logger.error('Two-cycle failure read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', date: targetDate, letters: [] };
  }

  // Group by (letter, case), then by cycle, then keep today's.
  const byPair = new Map();
  for (const row of rows) {
    const key = `${row.letter}|${row.case_type}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(row);
  }

  const failing = [];
  for (const [key, pairRows] of byPair) {
    const [letter, caseType] = key.split('|');
    const todays = groupIntoCycles(pairRows).filter(
      c => c.complete && toPracticeDate(c.lastAt) === targetDate,
    );
    if (todays.length < MAX_CYCLES_PER_LETTER_PER_DATE) continue;
    if (todays.some(c => c.passed)) continue; // mastered or passed today — no home practice
    failing.push({ letter, caseType, cycles: todays.length, lastAt: todays[todays.length - 1].lastAt });
  }

  if (failing.length === 0) return { status: 'ok', date: targetDate, letters: [] };

  // A letter the child has since mastered is never a home-practice candidate.
  let mastered;
  try {
    mastered = await LetterProgress.findAll({
      where: {
        student_id: studentId,
        mastered_at: { [Op.ne]: null },
        [Op.or]: failing.map(f => ({ letter: f.letter, case_type: f.caseType })),
      },
      attributes: ['letter', 'case_type'],
      raw: true,
    });
  } catch (err) {
    logger.error('Mastery filter read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', date: targetDate, letters: [] };
  }
  const masteredKey = new Set(mastered.map(m => `${m.letter}|${m.case_type}`));

  return {
    status: 'ok',
    date: targetDate,
    letters: failing
      .filter(f => !masteredKey.has(`${f.letter}|${f.caseType}`))
      .sort((a, b) => new Date(a.lastAt) - new Date(b.lastAt)),
  };
}

module.exports = {
  getCycleUsageForDate,
  getTwoCycleFailureLetters,
  // exported for tests
  groupIntoCycles,
};

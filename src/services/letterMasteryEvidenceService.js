'use strict';

/**
 * letterMasteryEvidenceService.js
 *
 * The writing a child actually produced on the attempt that mastered a letter.
 *
 * ── Why this is its own read ─────────────────────────────────────────────
 * stroke_points is the largest column in the schema — a full trajectory per
 * attempt. The report's bulk endpoints deliberately exclude it, and adding it
 * to every row of a 52-letter report to satisfy one modal would be a large
 * payload for a rarely-opened panel. So this is a targeted read: one letter,
 * one case, one attempt, fetched only when a teacher opens Letter Details.
 *
 * ── Provable, or nothing ─────────────────────────────────────────────────
 * There are exactly two durable links between a mastery event and the attempt
 * that caused it, and this reads only those:
 *
 *   LetterProgress.mastery_letter_attempt_id       every letter, from 2026-08-29
 *   LetterMotorMasteryEvidence.letter_attempt_id   the 20 reference letters
 *
 * When neither is present the answer is `unavailable`. This never falls back
 * to the best-scoring attempt, the most recent attempt, or any attempt found
 * by searching — under the current policy mastery is established by Attempt 3
 * of one specific session, and an attempt that did not establish mastery is
 * not mastery evidence no matter how good it looks.
 *
 * ── Case is part of the identity ─────────────────────────────────────────
 * Every lookup is keyed on (student, letter, case_type). Lowercase `s` and
 * uppercase `S` are different letters with different strokes; neither can ever
 * surface as the other's evidence.
 */

const { Op } = require('sequelize');
const { LetterProgress, LetterAttempt, LetterMotorMasteryEvidence } = require('../models');
const { MASTERY_ATTEMPT_NUMBER } = require('../config/masteryPolicy');
const logger = require('../utils/logger');

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

/** Reasons a caller gets no strokes, each meaning something different. */
const EVIDENCE_STATUS = Object.freeze({
  AVAILABLE:    'available',
  NOT_MASTERED: 'not_mastered',
  UNLINKED:     'unlinked',       // mastered before the link existed
  ATTEMPT_GONE: 'attempt_missing', // linked, but the row is not readable
  NO_STROKES:   'no_strokes',      // linked row exists, carries no trajectory
});

function isValidLetter(letter) {
  return typeof letter === 'string' && /^[A-Za-z]$/.test(letter);
}

/**
 * The attempt id that provably established mastery, or null.
 *
 * LetterProgress is asked first because it covers every letter; the Feature
 * 11B evidence table is the fallback for letters mastered before that column
 * existed but which happen to be reference letters. Both store the SAME kind
 * of fact — the attempt-3 row of the mastering session — so preferring one
 * over the other changes nothing about what is returned, only how often an
 * answer exists at all.
 */
async function resolveMasteryAttemptId({ studentId, letter, caseType }) {
  const progress = await LetterProgress.findOne({
    where: { student_id: studentId, letter, case_type: caseType },
    attributes: ['mastered_at', 'mastery_letter_attempt_id'],
  });

  // Row existence means nothing about mastery — the failure branch creates
  // rows purely to hold blocked_attempts. mastered_at is the mastery signal.
  if (!progress || progress.mastered_at == null) {
    return { mastered: false, attemptId: null };
  }
  if (progress.mastery_letter_attempt_id != null) {
    return { mastered: true, attemptId: progress.mastery_letter_attempt_id };
  }

  const frozen = await LetterMotorMasteryEvidence.findOne({
    where: { student_id: studentId, letter, case_type: caseType },
    attributes: ['letter_attempt_id'],
  });
  return { mastered: true, attemptId: frozen?.letter_attempt_id ?? null };
}

/**
 * One letter's mastery writing evidence.
 *
 * The caller is responsible for the ownership check BEFORE calling this —
 * see the controller, which runs teacherService.getOwnStudentById first.
 *
 * @returns {Promise<{status: string, evidence: Object|null}>} `evidence` is
 *   non-null only for status 'available'.
 */
async function getLetterMasteryEvidence({ studentId, letter, caseType }) {
  if (!Number.isInteger(studentId) || studentId <= 0) {
    return { status: EVIDENCE_STATUS.NOT_MASTERED, evidence: null };
  }
  if (!isValidLetter(letter) || !VALID_CASE_TYPES.includes(caseType)) {
    return { status: EVIDENCE_STATUS.NOT_MASTERED, evidence: null };
  }

  const { mastered, attemptId } = await resolveMasteryAttemptId({ studentId, letter, caseType });
  if (!mastered) return { status: EVIDENCE_STATUS.NOT_MASTERED, evidence: null };
  if (attemptId == null) return { status: EVIDENCE_STATUS.UNLINKED, evidence: null };

  // student_id, letter and case_type are re-asserted in the WHERE clause, not
  // merely trusted from the id: a link that somehow pointed at another
  // student's row must return nothing rather than that student's writing.
  const attempt = await LetterAttempt.findOne({
    where: {
      id: attemptId,
      student_id: studentId,
      letter,
      case_type: caseType,
    },
    attributes: [
      'id', 'attempt_number', 'best_score', 'threshold', 'passed',
      'stroke_points', 'canvas_width', 'canvas_height', 'created_at',
    ],
  });

  if (!attempt) {
    logger.warn('Mastery evidence: linked attempt row not readable', { studentId, letter, caseType, attemptId });
    return { status: EVIDENCE_STATUS.ATTEMPT_GONE, evidence: null };
  }
  if (!Array.isArray(attempt.stroke_points) || attempt.stroke_points.length === 0) {
    return { status: EVIDENCE_STATUS.NO_STROKES, evidence: null };
  }

  return {
    status: EVIDENCE_STATUS.AVAILABLE,
    evidence: {
      letter,
      case_type: caseType,
      attempt_id: attempt.id,
      // Reported as stored. Under the current policy this is always
      // MASTERY_ATTEMPT_NUMBER, and the UI labels it from this value rather
      // than assuming it.
      attempt_number: attempt.attempt_number,
      mastery_attempt_number: MASTERY_ATTEMPT_NUMBER,
      score: attempt.best_score,
      threshold: attempt.threshold,
      stroke_points: attempt.stroke_points,
      canvas_width: attempt.canvas_width,
      canvas_height: attempt.canvas_height,
      recorded_at: attempt.created_at,
    },
  };
}

/**
 * Which letters CAN show evidence, for a whole student, without sending any
 * strokes. Lets the report mark the letters worth opening.
 */
async function listLettersWithMasteryEvidence(studentId) {
  if (!Number.isInteger(studentId) || studentId <= 0) return [];
  const rows = await LetterProgress.findAll({
    where: {
      student_id: studentId,
      mastered_at: { [Op.ne]: null },
      mastery_letter_attempt_id: { [Op.ne]: null },
    },
    attributes: ['letter', 'case_type'],
  });
  return rows.map((r) => ({ letter: r.letter, caseType: r.case_type }));
}

module.exports = {
  EVIDENCE_STATUS,
  getLetterMasteryEvidence,
  listLettersWithMasteryEvidence,
  resolveMasteryAttemptId,
};

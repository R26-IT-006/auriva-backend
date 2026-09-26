'use strict';

/**
 * initialAssessmentStatusService.js
 *
 * Answers ONE product question: has this learner completed a usable initial
 * handwriting assessment, and should they proceed to normal practice?
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * GET /handwriting/initial-report returns `hasData`, which means (and has
 * always meant) "there is an assessment row I can render a report from". The
 * Welcome screen was using it as a ROUTING gate, where it needed to mean
 * something stricter — and the two are not the same thing.
 *
 * Student 41 is the proof. One non-collection assessment, `is_initial=true`,
 * six ShapeFeature rows... but `motor_profile=null`, `motor_score=null`, no
 * baseline, no thresholds. `hasData` was true, so Welcome skipped straight to
 * LetterHome and the child could never take the assessment through the real
 * product UI again — an unusable row locked them out permanently.
 *
 * `hasData` is deliberately LEFT ALONE. It has two other consumers (the
 * teacher report's initial-assessment section and the shape-preview loader)
 * for which "a row exists" is exactly the right question — a teacher should
 * still be able to see that an assessment was attempted. This module supplies
 * a SEPARATE, additive answer for the routing question.
 *
 * ── The predicate, and why this one ──────────────────────────────────────
 * Complete = at least one assessment that is
 *   - non-collection (research/Writing Check rows can never satisfy it), AND
 *   - eligible per isEligibleInitialMotorAssessment (valid motor_profile and
 *     motor_score — the SAME check the baseline selector applies), AND
 *   - backed by all six canonical linked ShapeFeature rows with finite
 *     motor scores.
 *
 * That is deliberately the same rule findEarliestEligibleAssessment uses, so
 * the routing gate and the baseline selector can never disagree about what a
 * usable assessment is.
 *
 * Four definitions were compared against the live database before choosing:
 *
 *   A  valid assessment only                 -> 10 students complete
 *   B  valid assessment + six shapes (this)  -> 10 students complete
 *   C  StudentMotorBaseline exists           ->  6 students complete
 *   D  A or C                                -> 10 students complete
 *
 * C was REJECTED on evidence: it would have forced FOUR legitimate learners
 * back through the initial assessment purely because their baseline rows
 * predate automatic baseline creation — including one student with 181
 * assessments and 59 eligible ones. Baseline existence is a marker of when
 * the baseline feature shipped, not of whether a child was assessed.
 *
 * A, B and D are currently identical on every student in the database (the
 * A-vs-B disagreement count is zero — every eligible assessment already
 * carries its six canonical shapes). B is chosen as the strictest of the
 * three that costs nothing today and matches the baseline selector exactly.
 */

const { HandwritingAssessment, ShapeFeature } = require('../models');
const {
  isEligibleInitialMotorAssessment, REQUIRED_SHAPES,
} = require('./motorBaselineService');
const logger = require('../utils/logger');

/** Additive status vocabulary. Semantic, never DB terminology. */
const ASSESSMENT_STATUS = Object.freeze({
  NOT_STARTED: 'not_started',
  INCOMPLETE:  'incomplete',
  COMPLETE:    'complete',
});

/** Why, for logs and diagnostics. Never rendered to a child. */
const ASSESSMENT_STATUS_REASON = Object.freeze({
  NONE:              'no_initial_assessment',
  INCOMPLETE:        'initial_assessment_incomplete',
  COMPLETE:          'initial_assessment_complete',
  READ_FAILED:       'initial_assessment_status_read_failed',
});

/**
 * @param {{ studentId: number }} args
 * @returns {Promise<{
 *   status: 'not_started'|'incomplete'|'complete',
 *   reason: string,
 *   usableAssessmentId: number|null,
 *   assessmentCount: number,
 * }>}
 */
async function getInitialAssessmentStatus({ studentId }) {
  const empty = { usableAssessmentId: null, assessmentCount: 0 };

  let assessments;
  try {
    assessments = await HandwritingAssessment.findAll({
      // collection_mode:false is the hard boundary — a research or Writing
      // Check capture can never satisfy the normal-learning gate.
      where: { student_id: studentId, collection_mode: false },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });
  } catch (err) {
    logger.error('Initial assessment status read failed', { studentId, errorMessage: err.message });
    // Fails toward SHOWING the assessment, never toward skipping it.
    //
    // The two failure modes are not equally bad. Wrongly showing the
    // assessment to an established learner costs one repeated assessment,
    // which a teacher sees immediately and which the earliest-fully-eligible
    // baseline selector ignores anyway. Wrongly SKIPPING it for a new learner
    // is silent: no baseline, no personalization, and — before this fix —
    // no route back. Consistent with WelcomeScreen's own long-standing
    // behaviour on a network error, which already shows the assessment.
    return { status: ASSESSMENT_STATUS.INCOMPLETE, reason: ASSESSMENT_STATUS_REASON.READ_FAILED, ...empty };
  }

  if (assessments.length === 0) {
    return { status: ASSESSMENT_STATUS.NOT_STARTED, reason: ASSESSMENT_STATUS_REASON.NONE, ...empty };
  }

  const eligible = assessments.filter(a => isEligibleInitialMotorAssessment(a).eligible);
  if (eligible.length === 0) {
    return {
      status: ASSESSMENT_STATUS.INCOMPLETE,
      reason: ASSESSMENT_STATUS_REASON.INCOMPLETE,
      usableAssessmentId: null,
      assessmentCount: assessments.length,
    };
  }

  // Canonical shape evidence, batched in ONE query for every candidate.
  let shapeRows;
  try {
    shapeRows = await ShapeFeature.findAll({
      where: {
        student_id: studentId,
        assessment_id: eligible.map(a => a.id),
        source: 'initial_assessment',
      },
      attributes: ['assessment_id', 'shape_type', 'motor_score'],
      raw: true,
    });
  } catch (err) {
    logger.error('Initial assessment shape evidence read failed', { studentId, errorMessage: err.message });
    // Same asymmetry as above — never claim completeness we could not verify.
    return { status: ASSESSMENT_STATUS.INCOMPLETE, reason: ASSESSMENT_STATUS_REASON.READ_FAILED,
             usableAssessmentId: null, assessmentCount: assessments.length };
  }

  const presentByAssessment = new Map();
  for (const r of shapeRows) {
    if (!Number.isFinite(r.motor_score)) continue;
    if (!presentByAssessment.has(r.assessment_id)) presentByAssessment.set(r.assessment_id, new Set());
    presentByAssessment.get(r.assessment_id).add(r.shape_type);
  }

  // An EARLIER broken assessment never blocks a LATER valid one — the child
  // simply has a usable assessment somewhere in their history.
  const usable = eligible.find(a => {
    const present = presentByAssessment.get(a.id);
    return present != null && REQUIRED_SHAPES.every(s => present.has(s));
  });

  if (!usable) {
    return {
      status: ASSESSMENT_STATUS.INCOMPLETE,
      reason: ASSESSMENT_STATUS_REASON.INCOMPLETE,
      usableAssessmentId: null,
      assessmentCount: assessments.length,
    };
  }

  return {
    status: ASSESSMENT_STATUS.COMPLETE,
    reason: ASSESSMENT_STATUS_REASON.COMPLETE,
    usableAssessmentId: usable.id,
    assessmentCount: assessments.length,
  };
}

module.exports = { getInitialAssessmentStatus, ASSESSMENT_STATUS, ASSESSMENT_STATUS_REASON };

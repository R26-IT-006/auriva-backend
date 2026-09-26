'use strict';

/**
 * authoritativeMotorBaselineService.js
 *
 * Motor Score Unification (spec §7/§8) — computes the AUTHORITATIVE
 * (computeMotorScore-domain) family-averaged initial-assessment profile
 * for a student, from the SAME ShapeFeature rows submitAssessment() ALREADY
 * writes (ShapeFeature.motor_score, computed by computeMotorScore() at
 * ingest time — see handwritingController.js:188). No new shape-scoring
 * formula is introduced here — this module only reads and family-averages
 * a value that already exists.
 *
 * Family mapping mirrors the documented convention in
 * config/letterBaselineFamilies.js's own header (itself mirroring
 * frontend/src/utils/adaptiveSequencing.js's calculateMotorProfile()):
 *   horizontal_line, vertical_line  -> straight
 *   full_circle,      half_circle    -> curved
 *   zigzag,            curve_wave     -> complex
 *
 * READ-ONLY with respect to HandwritingAssessment/ShapeFeature — never
 * recalculates or rewrites a shape's own motor_score. Writes ONLY the new
 * progression_* columns on StudentMotorBaseline (additive, spec §6
 * migration) — never touches straight_score/curved_score/complex_score,
 * which remain Feature 11A's frozen research-domain input untouched by
 * this phase (spec §21).
 */

const { ShapeFeature, StudentMotorBaseline } = require('../models');
const logger = require('../utils/logger');

const FAMILY_SHAPES = {
  straight: ['horizontal_line', 'vertical_line'],
  curved:   ['full_circle', 'half_circle'],
  complex:  ['zigzag', 'curve_wave'],
};

function average(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((s, v) => s + v, 0) / usable.length;
}

/**
 * @param {{studentId: number, assessmentId: number}} params
 * @returns {Promise<{status: string, scores: {straight:number|null, curved:number|null, complex:number|null}|null, reason: string|null}>}
 *   Possible statuses: computed, no_shape_features, invalid_input
 */
async function computeAuthoritativeFamilyProfile({ studentId, assessmentId }) {
  if (!Number.isInteger(studentId) || studentId <= 0 || !Number.isInteger(assessmentId) || assessmentId <= 0) {
    return { status: 'invalid_input', scores: null, reason: 'invalid_ids' };
  }

  // Read-only, one bounded query — never one query per shape/family.
  // collection_mode: false — a research-protocol assessment must never
  // silently become a student's progression baseline (spec §26).
  const rows = await ShapeFeature.findAll({
    where: { student_id: studentId, assessment_id: assessmentId, collection_mode: false },
    attributes: ['shape_type', 'motor_score'],
    raw: true,
  });

  if (rows.length === 0) {
    return { status: 'no_shape_features', scores: null, reason: 'no_shape_feature_rows' };
  }

  const byShape = {};
  for (const row of rows) {
    byShape[row.shape_type] = row.motor_score;
  }

  const scores = {
    straight: average(FAMILY_SHAPES.straight.map((s) => byShape[s])),
    curved:   average(FAMILY_SHAPES.curved.map((s) => byShape[s])),
    complex:  average(FAMILY_SHAPES.complex.map((s) => byShape[s])),
  };

  return { status: 'computed', scores, reason: null };
}

/**
 * Computes the authoritative family profile and writes it into the
 * EXISTING StudentMotorBaseline row for this assessment's baseline
 * (created moments earlier, in the same finalizeAssessment call, by the
 * pre-existing createInitialMotorBaseline()). Non-fatal by design — a
 * failure here must never roll back the baseline itself or block
 * finalizeAssessment's response (spec §7's "Always called... Non-fatal by
 * design" convention, mirrored from createInitialMotorBaseline's own).
 *
 * @param {{studentId: number, assessmentId: number}} params
 * @returns {Promise<{status: string, scores: Object|null, reason: string|null}>}
 *   Additional possible statuses beyond computeAuthoritativeFamilyProfile's
 *   own: baseline_not_found, save_failed.
 */
async function attachAuthoritativeFamilyProfile({ studentId, assessmentId }) {
  const profileResult = await computeAuthoritativeFamilyProfile({ studentId, assessmentId });
  if (profileResult.status !== 'computed') return profileResult;

  try {
    const baseline = await StudentMotorBaseline.findOne({
      where: { student_id: studentId, source_assessment_id: assessmentId },
    });
    if (!baseline) {
      logger.warn('Authoritative family profile computed but no baseline row exists to attach it to', {
        studentId, assessmentId, status: 'baseline_not_found',
      });
      return { status: 'baseline_not_found', scores: profileResult.scores, reason: null };
    }

    await baseline.update({
      progression_straight_score: profileResult.scores.straight,
      progression_curved_score:   profileResult.scores.curved,
      progression_complex_score:  profileResult.scores.complex,
    });

    return { status: 'computed', scores: profileResult.scores, reason: null };
  } catch (err) {
    logger.error('Failed to attach authoritative family profile to baseline', {
      studentId, assessmentId, status: 'save_failed', errorMessage: err.message,
    });
    return { status: 'save_failed', scores: profileResult.scores, reason: 'save_failed' };
  }
}

module.exports = { computeAuthoritativeFamilyProfile, attachAuthoritativeFamilyProfile, FAMILY_SHAPES };

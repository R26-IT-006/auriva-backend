'use strict';

/**
 * progressionThresholdResolver.js
 *
 * Feature 2 Step 7 — the FIRST place Feature 2 may affect the real child
 * progression gate (recordLetterCompletion). This is a pure, read-only
 * resolution layer that sits ABOVE both systems without merging them:
 *
 *   Feature 2 family target (student_threshold_history, via
 *   dynamicThresholdService.getCurrentFamilyThreshold)
 *     vs
 *   legacy per-letter/default target (students.personal_thresholds, via
 *   the same 3-tier priority thresholdUtils.getStudentThreshold already
 *   implements)
 *
 * These stay two separate systems in storage — this file never writes
 * either one, and never copies a Feature 2 family value into
 * personal_thresholds. It only decides, per letter-completion request,
 * WHICH already-existing value to use for gating.
 *
 * A Feature 2 family threshold is a pilot personalised progression target
 * derived from the child's initial motor-family baseline and later
 * performance — not a diagnostic or clinical cutoff.
 *
 * Resolution priority (highest first) — Section 7/8 Decision: an explicit
 * caller-supplied quality_threshold is preserved as the HIGHEST priority,
 * unchanged from the existing behavior it replaces
 * (`typeof quality_threshold === 'number' ? quality_threshold : ...`) —
 * this field exists for tests/research tooling/future controlled
 * experiments, and the real frontend (LetterWritingScreen.js,
 * UppercaseWritingScreen.js — confirmed by fresh inspection) never sends it
 * in normal child flow, so this priority choice has zero effect on real
 * children today.
 *   1. requestedQualityThreshold (explicit request override)
 *   2. Feature 2 current family threshold (only for a REVIEWED, non-
 *      ambiguous letter+case mapping, only when a Feature 2 target has
 *      actually been initialized for that family)
 *   3. legacy personal_thresholds[letter]
 *   4. legacy personal_thresholds.default
 *   5. global default (55)
 *
 * Never writes ThresholdHistory, Student, LetterAttempt, LetterProgress, or
 * StudentMotorBaseline. Never calls createInitialFamilyThresholds,
 * persistAutomaticThresholdDecisions, or setTeacherFamilyThreshold — Feature
 * 2 initialization/automatic-recalculation remains an explicit, separate
 * process; this file only ever READS whatever already exists.
 */

const { Student } = require('../models');
const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const { getCurrentFamilyThreshold } = require('./dynamicThresholdService');
const logger = require('../utils/logger');

// Mirrors thresholdUtils.js's own GLOBAL_DEFAULT exactly — see
// tests/progressionThresholdResolver.test.js's parity test, which proves
// this resolver's legacy-tier logic never diverges from
// thresholdUtils.getStudentThreshold's existing, unmodified behavior.
const GLOBAL_DEFAULT = 55;

const SOURCE_REQUEST_OVERRIDE = 'request_override';
const SOURCE_FEATURE2_FAMILY = 'feature2_family';
const SOURCE_LEGACY_LETTER = 'legacy_letter';
const SOURCE_LEGACY_DEFAULT = 'legacy_default';
const SOURCE_GLOBAL_DEFAULT = 'global_default';
// Section 28 Decision — explicit, intentional fail-open policy: a genuine
// DB error reading Feature 2's current target must never silently masquerade
// as "no target exists" (that would misreport provenance) and must never
// block a child mid-session either (continuity wins). Logged at error level
// with this exact, distinct source string every time, so it is always
// possible to audit how often this path fired — never a silent fallback.
const SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR = 'legacy_fallback_feature2_error';

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Deliberately NOT a call to thresholdUtils.getStudentThreshold() — that
// function only returns a bare number, with no way to tell the caller WHICH
// of its three tiers produced it. Re-implementing the same 3-line priority
// here (letter -> default -> global) keeps this resolver self-contained and
// able to report source/family, without changing getStudentThreshold's
// existing contract (Section 3 Decision: do not overload the legacy
// utility). Parity with the original is proven by a dedicated test, not
// merely assumed.
function resolveLegacyThreshold(personalThresholds, letter) {
  const thresholds = personalThresholds ?? {};
  if (typeof thresholds[letter] === 'number') {
    return { threshold: thresholds[letter], source: SOURCE_LEGACY_LETTER };
  }
  if (typeof thresholds.default === 'number') {
    return { threshold: thresholds.default, source: SOURCE_LEGACY_DEFAULT };
  }
  return { threshold: GLOBAL_DEFAULT, source: SOURCE_GLOBAL_DEFAULT };
}

async function fetchPersonalThresholds(studentId) {
  const student = await Student.findByPk(studentId, { attributes: ['personal_thresholds'] });
  return student?.personal_thresholds ?? {};
}

/**
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter
 * @param {string} params.caseType — 'lowercase'|'uppercase'
 * @param {number|null|undefined} params.requestedQualityThreshold
 * @returns {Promise<{
 *   status: 'resolved'|'invalid_input',
 *   threshold: number|null,
 *   source: string|null,
 *   family: 'straight'|'curved'|'complex'|null,
 *   historyId: number|null,
 * }>}
 */
async function resolveProgressionThreshold({ studentId, letter, caseType, requestedQualityThreshold } = {}) {
  // Priority 1 — checked FIRST, before any validation below, exactly
  // mirroring the original ternary's short-circuit (`typeof quality_threshold
  // === 'number' ? quality_threshold : await getStudentThreshold(...)`),
  // which never even evaluated studentId/letter validity when an explicit
  // value was supplied.
  if (typeof requestedQualityThreshold === 'number') {
    return { status: 'resolved', threshold: requestedQualityThreshold, source: SOURCE_REQUEST_OVERRIDE, family: null, historyId: null };
  }

  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', threshold: null, source: null, family: null, historyId: null };
  }

  // letter/caseType are NOT strictly validated here (no invalid_input path
  // for them) — the real caller (recordLetterCompletion) already validates
  // both before threshold resolution is ever reached, and getBaselineFamily
  // already degrades a malformed letter/caseType to `null` (no mapping)
  // gracefully rather than throwing, which is exactly the legacy system's
  // own existing tolerance (a bad `letter` key simply misses every
  // personal_thresholds lookup and falls through to the global default,
  // never an error). Preserving that tolerance here avoids introducing a
  // new rejection path into a flow that never had one.
  const family = getBaselineFamily(letter, caseType);

  if (family) {
    let currentResult;
    try {
      currentResult = await getCurrentFamilyThreshold({ studentId, family });
    } catch (err) {
      logger.error('Feature 2 threshold lookup threw unexpectedly during progression resolution', {
        studentId, letter, caseType, family, errorMessage: err.message,
      });
      currentResult = { status: 'read_failed' };
    }

    if (currentResult.status === 'found') {
      // Section 37 — logged only for the actually-Feature-2-selected case,
      // not for every legacy resolution (which is existing, unchanged
      // behavior and does not need new logging noise). No names, no raw
      // handwriting data.
      logger.debug('Feature 2 family threshold selected for progression gating', {
        studentId, letter, caseType, family, threshold: currentResult.currentThreshold, thresholdSource: SOURCE_FEATURE2_FAMILY,
      });
      return {
        status: 'resolved',
        threshold: currentResult.currentThreshold,
        source: SOURCE_FEATURE2_FAMILY,
        family,
        historyId: currentResult.sourceEvent.historyId,
      };
    }

    if (currentResult.status === 'read_failed') {
      logger.error('Feature 2 threshold read failed — falling back to legacy threshold (intentional fail-open policy)', {
        studentId, letter, caseType, family,
      });
      const personalThresholds = await fetchPersonalThresholds(studentId);
      const legacy = resolveLegacyThreshold(personalThresholds, letter);
      return { status: 'resolved', threshold: legacy.threshold, source: SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR, family, historyId: null };
    }

    // currentResult.status === 'no_target' — mapped family, but not yet
    // initialized. Section 6 Decision: never auto-initialize here; fall
    // through to legacy exactly like an unmapped letter would.
  }

  const personalThresholds = await fetchPersonalThresholds(studentId);
  const legacy = resolveLegacyThreshold(personalThresholds, letter);
  return { status: 'resolved', threshold: legacy.threshold, source: legacy.source, family: family ?? null, historyId: null };
}

module.exports = {
  resolveProgressionThreshold,
  GLOBAL_DEFAULT,
  SOURCE_REQUEST_OVERRIDE,
  SOURCE_FEATURE2_FAMILY,
  SOURCE_LEGACY_LETTER,
  SOURCE_LEGACY_DEFAULT,
  SOURCE_GLOBAL_DEFAULT,
  SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR,
};

'use strict';

/**
 * worksheetRecommendationService.js
 *
 * Feature 8 Step 3 — READ-ONLY, student-wide worksheet-recommendation
 * evaluation. Composes Feature 7's `evaluatePersistentDifficulty()`
 * (the sole source of truth for persistent difficulty) with Step 2's
 * `buildWorksheetRecommendation()` policy helper — it duplicates the
 * internal logic of neither, exactly mirroring every prior feature's own
 * "service composes, never re-derives" discipline (Feature 6's
 * demoSpeedRecommendationService.js composing Feature 2/3 is the closest
 * precedent; Feature 8 itself composes only ONE other feature's service).
 *
 * ── One Feature 7 evaluation per request (Step 3 spec §3) ──────────────────
 * `evaluatePersistentDifficulty({studentId})` is called EXACTLY ONCE per
 * `evaluateWorksheetRecommendations()` call. All six streams' worth of
 * recommendation-building work derives from that single result — there is
 * no second Feature 7 call, and certainly no direct `LetterAttempt` query
 * of Feature 8's own (Step 3 spec §2/§29/§36).
 *
 * ── What this module never does ────────────────────────────────────────────
 *   - never imports `../models`, `LetterAttempt`, `ThresholdHistory`,
 *     `StudentMotorBaseline`, or `ShapeFeature` — zero database access of
 *     its own; the only DB-touching call anywhere in the chain is Feature
 *     7's own `fetchCandidateCycles()`, several layers away;
 *   - never calls `dynamicThresholdService`/`adaptiveSupportService`/
 *     `adaptivePreWritingService`/`repetitionRecommendationService`/
 *     `demoSpeedRecommendationService` — Feature 8's only adaptive-input
 *     dependency is `persistentDifficultyService`, plus the pure
 *     `worksheetRecommendationPolicy` config (Step 3 spec §35);
 *   - never recomputes persistence, never re-derives `affectedLetters`,
 *     never re-sorts focus letters — every one of those stays entirely
 *     Feature 7's/Step 2's own responsibility;
 *   - never writes anything — see
 *     tests/worksheetRecommendationServiceReadOnly.test.js.
 *
 * ── Feature 9 Step 5: additive `recommendationFingerprint` only ───────────
 * Each persistent recommendation now also carries an opaque
 * `recommendationFingerprint` (Step 5 spec §1/§10) — a Feature-9-owned
 * provenance value a teacher's client echoes back when validating a
 * recommendation, computed via the pure `feature9Provenance.js` helpers
 * (Step 2) using the SAME `stream` object (`earlierWindow`/`recentWindow`/
 * `affectedLetters`) already in scope here — this deliberately avoids a
 * second `evaluatePersistentDifficulty()` call (Step 5 spec §3/§4). This
 * file gains ONLY fingerprint/version knowledge, never Feature 9's
 * persisted-validation concepts: it does not import
 * `teacherRecommendationValidationService.js`,
 * `TeacherRecommendationValidation`, or any table/model, and has no
 * awareness of `confirmed`/`dismissed`/teacher notes/history/latest state
 * (Step 5 spec §5/§6 — the hard boundary between recommendation identity
 * and teacher judgement).
 *
 * ── Research framing ────────────────────────────────────────────────────────
 * A worksheet recommendation means: "a teacher-facing educational
 * handwriting practice suggestion, based on an already-established Feature
 * 7 persistent stream." Never a therapy plan, clinical intervention,
 * diagnosis, or motor-impairment treatment.
 */

const { evaluatePersistentDifficulty } = require('./persistentDifficultyService');
const { buildWorksheetRecommendation } = require('../config/worksheetRecommendationPolicy');
const { PERSISTENT_DIFFICULTY_STATUSES } = require('../config/persistentDifficultyPolicy');
const {
  computePersistentEvidenceFingerprint, computeWorksheetRecommendationFingerprint,
  PERSISTENT_DIFFICULTY_POLICY_VERSION, WORKSHEET_RECOMMENDATION_POLICY_VERSION,
} = require('../config/feature9Provenance');
const { MAPPING_VERSION } = require('../config/letterBaselineFamilies');
const logger = require('../utils/logger');

// Exactly the six streams Feature 7 itself evaluates (Step 3 spec §11) —
// never dynamically invented, and iterated in the SAME order Feature 7's
// own service uses, so recommendation order is deterministic and matches
// Feature 7's own established traversal (Step 3 spec §12/§25).
const CASE_TYPES = ['lowercase', 'uppercase'];
const FAMILIES = ['straight', 'curved', 'complex'];

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Read-only, student-wide worksheet-recommendation evaluation. Persists
 * nothing, computed fresh on every call from Feature 7's own live result.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{
 *   status: 'evaluated'|'invalid_input'|'read_failed',
 *   studentId: number|null,
 *   evaluatedAt: string|null,
 *   recommendations: Array<Object>|null,
 *   summary: {evaluatedStreamCount: number, persistentStreamCount: number,
 *     notPersistentCount: number, insufficientDataCount: number,
 *     recommendationCount: number}|null,
 * }>}
 */
async function evaluateWorksheetRecommendations({ studentId } = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, evaluatedAt: null, recommendations: null, summary: null };
  }

  // ── The ONE Feature 7 evaluation for this whole request (Step 3 spec §3) ──
  let feature7Result;
  try {
    feature7Result = await evaluatePersistentDifficulty({ studentId });
  } catch (err) {
    logger.error('Worksheet recommendation evaluation threw unexpectedly', { studentId, errorMessage: err.message });
    return { status: 'read_failed', studentId, evaluatedAt: null, recommendations: null, summary: null };
  }

  if (feature7Result.status !== 'evaluated') {
    // 'invalid_input' is unreachable here in practice (studentId already
    // validated above with an identical rule) but propagated defensively
    // rather than assumed unreachable; 'read_failed' is the realistic
    // case — and it propagates as Feature 8's own read_failed, never a
    // fabricated empty recommendation list (Step 3 spec §7/§8 — "read
    // failure ≠ zero recommendations").
    return {
      status: feature7Result.status,
      studentId, evaluatedAt: null, recommendations: null, summary: null,
    };
  }

  const recommendations = [];
  let persistentStreamCount = 0;
  let notPersistentCount = 0;
  let insufficientDataCount = 0;

  for (const caseType of CASE_TYPES) {
    for (const family of FAMILIES) {
      // Reads the actual stream entry, never `summary.persistentStreams`
      // alone (Step 3 spec §10) — the stream object is what carries
      // `affectedLetters`/`earlierWindow`/`recentWindow`, none of which the
      // summary-only list provides.
      const stream = feature7Result.streams[caseType][family];

      if (stream.status === PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT) {
        persistentStreamCount += 1;

        const recommendation = buildWorksheetRecommendation({
          caseType: stream.caseType,
          family: stream.family,
          affectedLetters: stream.affectedLetters,
          earlierWindow: stream.earlierWindow,
          recentWindow: stream.recentWindow,
        });

        if (recommendation) {
          // ── Provenance fingerprints (Step 5 spec §7/§8) ─────────────────
          // Reuses the SAME stream object's earlierWindow/recentWindow/
          // affectedLetters already fetched above — no second Feature 7
          // call. computeWorksheetRecommendationFingerprint() internally
          // rejects a non-hex evidenceFingerprint, so passing through a
          // possible `null` evidence fingerprint (§9's "should succeed but
          // don't trust that blindly" caution) safely yields
          // recommendationFingerprint === null rather than a crash.
          const evidenceFingerprint = computePersistentEvidenceFingerprint({
            studentId,
            caseType: stream.caseType,
            family: stream.family,
            earlierWindow: stream.earlierWindow,
            recentWindow: stream.recentWindow,
            affectedLetters: stream.affectedLetters,
            persistentPolicyVersion: PERSISTENT_DIFFICULTY_POLICY_VERSION,
            mappingVersion: MAPPING_VERSION,
          });
          const recommendationFingerprint = computeWorksheetRecommendationFingerprint({
            studentId,
            caseType: recommendation.caseType,
            family: recommendation.family,
            recommendationType: recommendation.recommendationType,
            focusLetters: recommendation.focusLetters,
            evidenceFingerprint,
            recommendationPolicyVersion: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
          });

          if (recommendationFingerprint) {
            // Additive only (Step 5 spec §10/§12) — every existing field
            // stays exactly as buildWorksheetRecommendation() produced it;
            // recommendationFingerprint is appended, never inserted before
            // or replacing anything.
            recommendations.push({ ...recommendation, recommendationFingerprint });
          } else {
            // A real persistent stream's window/affectedLetters shape
            // should always fingerprint successfully (Step 5 spec §9) —
            // this is defensive-only, mirroring the exact same "skip
            // safely, log, never abort the whole evaluation" discipline as
            // the null-builder-result branch below, rather than returning
            // a recommendation with no stable identity at all.
            logger.warn('Worksheet recommendation fingerprint computation failed for a persistent stream — skipped', {
              studentId, caseType: stream.caseType, family: stream.family,
            });
          }
        } else {
          // Defensive only — buildWorksheetRecommendation() returns null
          // only for a family outside Feature 7's own three values, which
          // a real Feature 7 stream should never produce. Skip safely
          // rather than let one malformed stream abort the whole
          // evaluation (Step 3 spec §14).
          logger.warn('Worksheet recommendation builder returned null for a persistent stream — skipped', {
            studentId, caseType: stream.caseType, family: stream.family,
          });
        }
      } else if (stream.status === PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT) {
        notPersistentCount += 1;
      } else {
        insufficientDataCount += 1;
      }
    }
  }

  return {
    status: 'evaluated',
    studentId,
    // Reuses Feature 7's own evaluatedAt (Step 3 spec §16) — both results
    // describe the exact same underlying evaluation, so there is only ever
    // one meaningful timestamp, never two competing ones.
    evaluatedAt: feature7Result.evaluatedAt,
    recommendations,
    summary: {
      evaluatedStreamCount: CASE_TYPES.length * FAMILIES.length,
      persistentStreamCount,
      notPersistentCount,
      insufficientDataCount,
      recommendationCount: recommendations.length,
    },
  };
}

module.exports = { evaluateWorksheetRecommendations };

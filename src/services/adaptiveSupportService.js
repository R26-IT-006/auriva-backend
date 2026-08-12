'use strict';

/**
 * adaptiveSupportService.js
 *
 * Feature 3 Step 4 — READ-ONLY Support Performance Reconstruction.
 *
 * Answers, per student and per REVIEWED baseline family (straight/curved/
 * complex): "how has this child performed under each support level (high/
 * medium/low)?" Nothing here chooses, recommends, or applies a support
 * level — this module only reconstructs and reports evidence, mirroring
 * exactly the same read-only-evidence discipline Feature 2 Step 4
 * (getRecentFamilyPerformance in dynamicThresholdService.js) already
 * established for threshold decisions. That file's query/dedup/exclusion
 * PATTERNS are reused here; its threshold-specific DECISIONS (attempt_number
 * === 3 only, session_key-alone dedup) are deliberately NOT reused — see
 * the per-section comments below for why each one differs for Feature 3.
 *
 * This is educational/adaptive-learning evidence reconstruction, not a
 * clinical or diagnostic measurement — "observed handwriting performance
 * under different software support presentations", nothing stronger. No
 * conclusion about motor ability, and no support recommendation, is drawn
 * here or anywhere in this file.
 *
 * ── What this module never does ──────────────────────────────────────────
 *   - never calls LetterAttempt.create/bulkCreate/update/destroy/save, and
 *     never opens a transaction — read-only via .findAll()/.count() only
 *     (see tests/adaptiveSupportServiceReadOnly.test.js);
 *   - never writes support_level (Feature 3 Step 3's column) — only reads it;
 *   - getSupportPerformanceByFamily() (Step 4) never reads Feature 2's
 *     current family target or support_review — evidence reconstruction
 *     stays fully independent of any decision system;
 *   - evaluateSupportRecommendations() (Step 5, below) reads Feature 2's
 *     current family target via getCurrentFamilyThreshold() ONLY as a
 *     read-only performance reference — see that function's own header for
 *     the full separation-of-concerns rationale. It still never reads
 *     support_review (Step 5 spec §19 — kept decoupled deliberately; Step 7
 *     may later combine the two independently-derived signals);
 *   - neither function ever writes ThresholdHistory, personal_thresholds,
 *     support_level, or any new "support history" table — Step 5 computes a
 *     recommendation and returns it; nothing is persisted, and nothing in
 *     this codebase yet applies it to frontend rendering.
 *
 * ── Source of truth for support identity ─────────────────────────────────
 * src/utils/attemptSupportResolution.js's resolveAttemptSupportLevel() —
 * explicit `support_level` (Feature 3 Step 3) wins whenever present and
 * valid, regardless of attempt_number; the historical attempt_number proxy
 * only applies to normal-mode rows with no explicit value. See that file's
 * header for the full priority/collection-mode rationale.
 *
 * ── Source of truth for performance score ────────────────────────────────
 * src/utils/attemptPerformanceScore.js's deriveAttemptPerformanceScore() —
 * reused completely unmodified (same function Feature 2 uses). Never
 * best_score/passed/threshold_passed, which are session-level values copied
 * across every row of a session (see that file's own header) and cannot
 * tell one attempt's performance apart from another's.
 *
 * ── Source of truth for family mapping ───────────────────────────────────
 * src/config/letterBaselineFamilies.js's getBaselineFamily() only — never a
 * second/derived taxonomy. An ambiguous or unmapped letter is excluded from
 * family-specific analysis entirely, never guessed.
 */

const { Op } = require('sequelize');
const { LetterAttempt } = require('../models');
const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const { deriveAttemptPerformanceScore } = require('../utils/attemptPerformanceScore');
const { resolveAttemptSupportLevel, SUPPORT_SOURCE } = require('../utils/attemptSupportResolution');
const { LETTER_SUPPORT_LEVELS } = require('../config/letterSupportLevels');
// Feature 3 Step 5 — reuses Feature 2's existing, unmodified, read-only
// getCurrentFamilyThreshold() as a PERFORMANCE REFERENCE only (Step 5 spec
// §8/§9/§32). This is the one and only Feature 2 import in this file, and
// it is a read (ThresholdHistory.findOne, never a write) — see that
// function's own implementation in dynamicThresholdService.js, untouched by
// this step. Reusing it does NOT merge the two systems: Feature 2's
// currentThreshold keeps meaning exactly what it always meant ("the
// progression target"); Step 5 only asks "can the child meet that existing
// number at this support level", never writes to it, never lowers it, and
// never derives a new one.
const { getCurrentFamilyThreshold } = require('./dynamicThresholdService');
const logger = require('../utils/logger');

// Pilot engineering default — NOT clinically validated. Same "explicit,
// centralized, never a scattered magic number" discipline as Feature 2's
// RECENT_FAMILY_WINDOW_SIZE/INITIAL_THRESHOLD_MARGIN.
const SUPPORT_PERFORMANCE_WINDOW_SIZE = 5;

const FAMILIES = ['straight', 'curved', 'complex'];

// A candidate row for Feature 3 support-performance evidence is:
//   - collection_mode === false  — collection data is EXCLUDED from Feature
//     3 personalization entirely (Step 4 spec §6): collection attempt 3's
//     protocol-specific guide override means attempt_number cannot be
//     trusted as a support proxy there, and even an explicit support_level
//     on a collection row would still reflect a fixed-research-protocol
//     session, not the child's normal independent practice pattern this
//     evidence is meant to represent. Filtered at the query level — see
//     Feature 2's own getRecentFamilyPerformance for the identical
//     query-level exclusion pattern, reused here.
//   - capture_status === 'complete' — incomplete/abandoned/network_failed
//     rows never had a full, real writing attempt behind them.
// Deliberately NOT filtered on attempt_number (unlike Feature 2, which only
// ever wants attempt_number===3): Feature 3 needs performance evidence
// under EVERY support level, so attempts 1, 2, AND 3 all matter here — see
// Step 4 spec §12.
// Deliberately NOT filtered on `passed`/`threshold_passed` (same rationale
// Feature 2 already established): those are session-level values that would
// silently exclude legitimate performance evidence — a failed attempt is
// still real evidence of how the child performed under that support level.
const CANDIDATE_CAPTURE_STATUS = 'complete';

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidWindowSize(value) {
  return isPositiveInteger(value);
}

// ─── Per-row processing ─────────────────────────────────────────────────────

/**
 * Deduplication identity for Feature 3 — deliberately session_key +
 * attempt_number, NOT session_key alone (Step 4 spec §19/§20).
 *
 * Feature 2's getRecentFamilyPerformance dedupes on session_key alone
 * because it only ever looks at attempt_number===3 rows — within that
 * already-filtered set, one session can contribute at most one legitimate
 * row, so session_key alone IS the correct attempt identity there.
 *
 * Feature 3 has no such pre-filter: a single legitimate session normally
 * contains THREE distinct rows (attempt 1, 2, 3) sharing one session_key.
 * Deduping on session_key alone would incorrectly collapse a real
 * high/medium/low triple down to just the newest of the three. Only a
 * genuine duplicate — two rows sharing BOTH the same session_key AND the
 * same attempt_number (the data-quality anomaly the Step 1 audit found) —
 * should ever be deduped.
 */
function attemptIdentity(row) {
  return `${row.session_key}|${row.attempt_number}`;
}

function emptyBuckets() {
  const buckets = {};
  for (const family of FAMILIES) {
    buckets[family] = {};
    for (const level of LETTER_SUPPORT_LEVELS) buckets[family][level] = [];
  }
  return buckets;
}

/**
 * Single pass over every candidate row (already ordered newest-first —
 * created_at DESC, id DESC, same deterministic tiebreak Feature 2 uses),
 * building all 9 (family × support level) windows at once, each capped at
 * `windowSize`. One pass is sufficient because each row can contribute to
 * at most one (family, supportLevel) bucket — unlike Feature 2's per-family
 * loop, there is no need to run this multiple times.
 *
 * Processing order per row (first check that excludes wins — a row is
 * counted in exactly one exclusion bucket, never double-counted):
 *   1. duplicate identity (session_key + attempt_number) → duplicateAttempt
 *   2. unmapped/ambiguous letter → unmappedLetter
 *   3. unresolvable support level → invalidSupport
 *   4. malformed features (score not derivable) → malformedFeatures
 *   5. bucket already at windowSize → silently skipped, NOT an exclusion —
 *      exactly Feature 2's own documented rule: "rows never reached because
 *      the window already filled are not examined (nothing 'recent' would
 *      be gained by looking further back once windowSize is satisfied)".
 *
 * "First-seen wins" for duplicates: rows are walked newest-first, and the
 * identity is marked seen BEFORE any further validity check — so if the
 * newest row for a given (session_key, attempt_number) happens to be
 * malformed, that identity is malformed/excluded, never silently retried
 * against an older duplicate. Deterministic by construction (Step 4 §19).
 */
function buildWindows(rows, windowSize) {
  const buckets = emptyBuckets();
  const seenIdentities = new Set();

  let duplicateAttempt = 0;
  let unmappedLetter = 0;
  let invalidSupport = 0;
  let malformedFeatures = 0;

  for (const row of rows) {
    const identity = attemptIdentity(row);
    if (seenIdentities.has(identity)) {
      duplicateAttempt++;
      continue;
    }
    seenIdentities.add(identity);

    const family = getBaselineFamily(row.letter, row.case_type);
    if (!family) {
      unmappedLetter++;
      continue;
    }

    const supportResult = resolveAttemptSupportLevel(row);
    if (supportResult.status !== 'resolved') {
      invalidSupport++;
      continue;
    }

    const scoreResult = deriveAttemptPerformanceScore(row);
    if (scoreResult.status !== 'valid') {
      malformedFeatures++;
      continue;
    }

    const bucket = buckets[family][supportResult.supportLevel];
    if (bucket.length >= windowSize) continue; // window already full — not an exclusion

    bucket.push({
      attemptId: row.id,
      sessionKey: row.session_key,
      letter: row.letter,
      caseType: row.case_type,
      family,
      attemptNumber: row.attempt_number,
      supportLevel: supportResult.supportLevel,
      supportSource: supportResult.source,
      performanceScore: scoreResult.score,
      createdAt: row.created_at,
    });
  }

  return { buckets, duplicateAttempt, unmappedLetter, invalidSupport, malformedFeatures };
}

// ─── Aggregate statistics ───────────────────────────────────────────────────

/**
 * @param {Array<{performanceScore: number}>} attempts
 * @returns {{averageScore: number|null, minScore: number|null, maxScore: number|null}}
 *   null (never 0) when `attempts` is empty — a window with no evidence has
 *   no average, not a zero average (Step 4 spec §17).
 */
function computeAggregates(attempts) {
  if (attempts.length === 0) return { averageScore: null, minScore: null, maxScore: null };
  const scores = attempts.map(a => a.performanceScore);
  const sum = scores.reduce((s, v) => s + v, 0);
  return {
    averageScore: sum / scores.length, // exact precision — rounding is a display/CLI concern, not a service concern
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
  };
}

function buildFamilyWindows(buckets, windowSize) {
  const families = {};
  for (const family of FAMILIES) {
    families[family] = {};
    for (const level of LETTER_SUPPORT_LEVELS) {
      const attempts = buckets[family][level];
      const { averageScore, minScore, maxScore } = computeAggregates(attempts);
      families[family][level] = {
        count: attempts.length,
        windowComplete: attempts.length >= windowSize,
        attempts,
        averageScore,
        minScore,
        maxScore,
      };
    }
  }
  return families;
}

function tallySupportSources(families) {
  let explicit = 0;
  let historicalProxy = 0;
  for (const family of FAMILIES) {
    for (const level of LETTER_SUPPORT_LEVELS) {
      for (const a of families[family][level].attempts) {
        if (a.supportSource === SUPPORT_SOURCE.EXPLICIT) explicit++;
        else if (a.supportSource === SUPPORT_SOURCE.HISTORICAL_PROXY) historicalProxy++;
      }
    }
  }
  return { explicit, historicalProxy };
}

/**
 * Diagnostic only (Step 4 spec §21) — reports how many DISTINCT sessions
 * among the candidate rows do NOT have exactly {1, 2, 3} as their
 * attempt_number set (e.g. the audit's known "one attempt-3-only session").
 * Purely informational: a malformed session's individual valid rows are
 * still eligible support-performance evidence (see buildWindows above,
 * which analyzes ATTEMPTS, not session completeness) — this count never
 * excludes anything, it only reports a data-quality signal alongside the
 * real windows.
 */
function computeSessionDiagnostics(rows) {
  const bySession = new Map();
  for (const row of rows) {
    if (!bySession.has(row.session_key)) bySession.set(row.session_key, new Set());
    bySession.get(row.session_key).add(row.attempt_number);
  }
  let malformedSessionCount = 0;
  for (const attemptNumbers of bySession.values()) {
    const isCompleteTriple = attemptNumbers.size === 3
      && attemptNumbers.has(1) && attemptNumbers.has(2) && attemptNumbers.has(3);
    if (!isCompleteTriple) malformedSessionCount++;
  }
  return { totalSessions: bySession.size, malformedSessionCount };
}

// ─── Main service function ─────────────────────────────────────────────────

/**
 * Reads (never writes) per-family, per-support-level performance evidence
 * for a student, reconstructed from normal-mode LetterAttempt rows only.
 *
 * Query strategy (Step 4 spec §22): one single query fetches every
 * normal-mode, capture_status=complete row for the student, newest-first,
 * with no DB-side LIMIT — matching Feature 2's own documented "correctness
 * over a premature pagination optimization that isn't yet justified by
 * data volume" decision (774 total letter_attempts rows today). All family/
 * support windowing, deduplication, and aggregation happens in memory in
 * one pass (buildWindows above) — simplest and safest given current data
 * size, and avoids nine separate per-(family,level) queries.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.windowSize=SUPPORT_PERFORMANCE_WINDOW_SIZE]
 * @returns {Promise<{
 *   status: 'found'|'invalid_input'|'invalid_window_size'|'read_failed',
 *   studentId: number|null,
 *   windowSize: number|null,
 *   families: {straight: Object, curved: Object, complex: Object}|null,
 *   supportSourceCounts: {explicit: number, historicalProxy: number}|null,
 *   exclusions: Object|null,
 *   diagnostics: Object|null,
 * }>}
 */
async function getSupportPerformanceByFamily({ studentId, windowSize = SUPPORT_PERFORMANCE_WINDOW_SIZE } = {}) {
  const empty = { families: null, supportSourceCounts: null, exclusions: null, diagnostics: null };

  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, windowSize: null, ...empty };
  }
  if (!isValidWindowSize(windowSize)) {
    return { status: 'invalid_window_size', studentId, windowSize: null, ...empty };
  }

  let rows;
  try {
    rows = await LetterAttempt.findAll({
      where: {
        student_id: studentId,
        collection_mode: false,
        capture_status: CANDIDATE_CAPTURE_STATUS,
      },
      order: [['created_at', 'DESC'], ['id', 'DESC']],
    });
  } catch (err) {
    logger.error('Support performance reconstruction query failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return { status: 'read_failed', studentId, windowSize, families: null, supportSourceCounts: null, exclusions: null, diagnostics: null };
  }

  const { buckets, duplicateAttempt, unmappedLetter, invalidSupport, malformedFeatures } = buildWindows(rows, windowSize);
  const families = buildFamilyWindows(buckets, windowSize);
  const supportSourceCounts = tallySupportSources(families);
  const diagnostics = computeSessionDiagnostics(rows);

  // Global, student-wide exclusion counts NOT visible from the candidate
  // query itself (collection-mode rows and non-complete-capture rows were
  // never loaded into `rows` at all) — best-effort/non-fatal, matching
  // Feature 2's own exclusion-count discipline: a failure here must not
  // invalidate the windows already computed above.
  let collectionModeExcluded = null;
  let invalidCaptureStatusExcluded = null;
  try {
    [collectionModeExcluded, invalidCaptureStatusExcluded] = await Promise.all([
      LetterAttempt.count({ where: { student_id: studentId, collection_mode: true } }),
      LetterAttempt.count({ where: { student_id: studentId, collection_mode: false, capture_status: { [Op.ne]: CANDIDATE_CAPTURE_STATUS } } }),
    ]);
  } catch (err) {
    logger.error('Support performance exclusion-count lookup failed', { studentId, errorMessage: err.message });
  }

  return {
    status: 'found',
    studentId,
    windowSize,
    families,
    supportSourceCounts,
    exclusions: {
      collectionMode: collectionModeExcluded,
      invalidCaptureStatus: invalidCaptureStatusExcluded,
      unmappedLetter,
      invalidSupport,
      malformedFeatures,
      duplicateAttempt,
    },
    diagnostics,
  };
}

// ─── Step 5: read-only adaptive support RECOMMENDATION ─────────────────────
//
// Everything below is READ-ONLY / DECISION SIMULATION ONLY — no different
// in spirit from Feature 2 Step 5's evaluateDynamicThresholds(): a decision
// is COMPUTED and RETURNED, never persisted, never applied to frontend
// rendering, never written to support_level, ThresholdHistory, or any new
// "support history" table (none exists yet — Step 5 spec explicitly defers
// that). See tests/adaptiveSupportServiceRecommendationReadOnly.test.js.
//
// ── Core question ────────────────────────────────────────────────────────
// "For this student and baseline family, what support level should be
// recommended for the NEXT normal handwriting session?" — high | medium |
// low, or an explicit "not enough evidence yet" / "review needed" outcome.
//
// ── The lowest-successful-support principle (Step 5 spec §15) ───────────
// Recommend the LOWEST support level for which there is sufficient COMPLETE
// evidence that the child can meet the CURRENT family target — checked in
// order low → medium → high, first qualifying level wins. This is
// deliberately NOT "which support level has the highest average score":
// the goal is the least assistance needed for successful performance, not
// the highest score attainable (Step 5 spec §24) — a child scoring higher
// under high support while ALREADY reliably meeting the target under medium
// should still be recommended medium, not high.
//
// ── Feature 2 target as reference only (Step 5 spec §4/§8/§9) ───────────
// "Meeting the target" means performanceScore >= the CURRENT Feature 2
// family threshold, read fresh via getCurrentFamilyThreshold() every call.
// This never merges the two systems: Feature 2's threshold keeps meaning
// "the progression target" and is never modified, lowered, or written to by
// anything in this file. If no target has been initialized for a family
// yet, Step 5 does NOT fabricate one (never the legacy global default 55) —
// it reports decision='insufficient_target' instead.
//
// ── Window completeness gates every decision (Step 5 spec §6/§13) ───────
// A support level can only drive a confident decision when its window is
// windowComplete (>= windowSize observations). An incomplete window is
// simply skipped in the low→medium→high scan — never treated as "failing",
// never treated as grounds to recommend a higher level. If NO level has a
// complete window, the decision is insufficient_data — sparse evidence is
// never treated as proof of difficulty (spec §13/§31).
//
// ── support_review (Step 5 spec §17) ─────────────────────────────────────
// If low and medium both fail to qualify (either incomplete or complete-
// but-below-the-success-bar) AND high's window IS complete but ALSO fails
// the success bar, there is no higher software support left to try. Rather
// than inventing a fourth, nonexistent support level, the decision is
// support_review with recommendedSupport='high' (the maximum real support
// this system can offer) and requiresReview=true, signalling a teacher/
// system should look further. If high's window is instead merely
// INCOMPLETE (not complete-and-failing), the correct decision is
// insufficient_data, not support_review — declaring "review needed" from
// sparse high-support evidence would overstate what the data shows.

// Pilot engineering default — NOT clinically validated. Reuses Feature 2's
// own "4 of latest 5" pattern (see dynamicThresholdService.js's
// REASON_4_OR_5_MET_TARGET / metTargetCount >= 4) for consistency, with the
// exact same characteristic that formula has there: this is a fixed
// ABSOLUTE count, not proportionally scaled to a non-default windowSize. A
// caller overriding windowSize to e.g. 10 does not make this "8 of 10" — it
// stays "4 of the latest N", exactly mirroring Feature 2's own existing,
// documented behavior rather than inventing new scaling logic Step 5 was
// never asked to add.
const SUPPORT_SUCCESS_MET_COUNT = 4;

const SUPPORT_LEVEL_ORDER = ['low', 'medium', 'high'];

const DECISION_INSUFFICIENT_DATA   = 'insufficient_data';
const DECISION_INSUFFICIENT_TARGET = 'insufficient_target';
const DECISION_SUPPORT_REVIEW      = 'support_review';

const REASON_TARGET_NOT_INITIALIZED = 'target_not_initialized';
const REASON_NO_COMPLETE_WINDOW     = 'no_support_level_has_a_complete_window';
const REASON_HIGH_INSUFFICIENT      = 'high_support_window_complete_but_success_rate_below_pilot_threshold';

/**
 * Per-support-level diagnostic counts (Step 5 spec §22/§23) — metTargetCount
 * is computed ONLY from the reconstructed per-attempt performanceScore
 * (Step 4's own output), never `passed`/`threshold_passed`/`best_score`
 * (session-level values — see Step 4's own module header for why those are
 * unusable here). `metTargetCount` is `null` (not 0, not omitted) whenever
 * `currentTarget` is unavailable (no_target) — there is no target to have
 * met, which is a different fact from "met by nobody".
 */
function buildSupportResults(familyWindows, currentTarget) {
  const results = {};
  for (const level of SUPPORT_LEVEL_ORDER) {
    const window = familyWindows[level];
    const metTargetCount = currentTarget == null
      ? null
      : window.attempts.filter(a => a.performanceScore >= currentTarget).length;
    results[level] = { count: window.count, metTargetCount, windowComplete: window.windowComplete };
  }
  return results;
}

/**
 * Evidence-provenance transparency (Step 5 spec §20) — never gates or
 * blocks a recommendation; purely informational. Computed across ALL
 * attempts contributing to any of the family's three windows, regardless of
 * which level ultimately drove the decision, so a teacher/researcher can
 * always see the full provenance picture for that family.
 */
function computeEvidenceQuality(attempts) {
  const explicitCount = attempts.filter(a => a.supportSource === SUPPORT_SOURCE.EXPLICIT).length;
  const historicalProxyCount = attempts.filter(a => a.supportSource === SUPPORT_SOURCE.HISTORICAL_PROXY).length;
  return { explicitCount, historicalProxyCount, containsHistoricalProxy: historicalProxyCount > 0 };
}

/**
 * Descriptive provenance label (Step 5 spec §21 — preferred over an
 * invented statistical confidence score). `null` when there is no evidence
 * at all for this family (e.g. a family the student has never practiced) —
 * distinct from either real-evidence case, never guessed as
 * 'historical_proxy_only' by default.
 */
function computeEvidenceBasis(attempts) {
  if (attempts.length === 0) return null;
  const hasExplicit = attempts.some(a => a.supportSource === SUPPORT_SOURCE.EXPLICIT);
  const hasProxy = attempts.some(a => a.supportSource === SUPPORT_SOURCE.HISTORICAL_PROXY);
  if (hasExplicit && hasProxy) return 'mixed';
  return hasExplicit ? 'explicit_only' : 'historical_proxy_only';
}

/**
 * Evaluates ONE family's recommendation from its already-reconstructed
 * support windows (Step 4 output, reused verbatim — no re-derivation) and
 * its current Feature 2 family target (read-only reference).
 */
function evaluateFamilySupportDecision(family, familyWindows, targetResult) {
  const allAttempts = SUPPORT_LEVEL_ORDER.flatMap(level => familyWindows[level].attempts);
  const evidenceQuality = computeEvidenceQuality(allAttempts);
  const evidenceBasis = computeEvidenceBasis(allAttempts);

  if (targetResult.status === 'no_target') {
    return {
      family,
      currentTarget: null,
      recommendedSupport: null,
      decision: DECISION_INSUFFICIENT_TARGET,
      reason: REASON_TARGET_NOT_INITIALIZED,
      requiresReview: false,
      supportResults: buildSupportResults(familyWindows, null),
      evidenceQuality,
      evidenceBasis,
    };
  }

  // targetResult.status === 'found' is the only remaining possibility here:
  // invalid_input/invalid_family are unreachable (studentId/family are
  // already validated before this function is ever called), and
  // read_failed already aborted the whole evaluation at the top level
  // (see evaluateSupportRecommendations) before any family is evaluated.
  const currentTarget = targetResult.currentThreshold;
  const supportResults = buildSupportResults(familyWindows, currentTarget);

  for (const level of SUPPORT_LEVEL_ORDER) {
    if (!familyWindows[level].windowComplete) continue; // insufficient evidence at this level — skip, never treated as failing

    if (supportResults[level].metTargetCount >= SUPPORT_SUCCESS_MET_COUNT) {
      return {
        family, currentTarget,
        recommendedSupport: level,
        decision: `recommend_${level}`,
        reason: `${level}_is_lowest_complete_support_meeting_target`,
        requiresReview: false,
        supportResults, evidenceQuality, evidenceBasis,
      };
    }

    if (level === 'high') {
      // Complete evidence at the MAXIMUM available software support still
      // falls below the success bar — never invent a higher level (spec §17).
      return {
        family, currentTarget,
        recommendedSupport: 'high',
        decision: DECISION_SUPPORT_REVIEW,
        reason: REASON_HIGH_INSUFFICIENT,
        requiresReview: true,
        supportResults, evidenceQuality, evidenceBasis,
      };
    }
    // low/medium complete but below the bar — keep scanning upward.
  }

  // No level ever had a complete window (the only way to exit the loop
  // above without returning) — sparse evidence, never treated as proof of
  // difficulty (spec §13/§31).
  return {
    family, currentTarget,
    recommendedSupport: null,
    decision: DECISION_INSUFFICIENT_DATA,
    reason: REASON_NO_COMPLETE_WINDOW,
    requiresReview: false,
    supportResults, evidenceQuality, evidenceBasis,
  };
}

/**
 * Read-only support-level RECOMMENDATION for a student, across all three
 * baseline families: reconstructed support-performance evidence (Step 4,
 * reused verbatim) + the current Feature 2 family target (read-only
 * reference) -> a recommended support level, or an explicit
 * insufficient_data / insufficient_target / support_review outcome.
 * Persists nothing — see module header.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.windowSize=SUPPORT_PERFORMANCE_WINDOW_SIZE]
 * @returns {Promise<{
 *   status: 'evaluated'|'invalid_input'|'invalid_window_size'|'read_failed',
 *   studentId: number|null,
 *   windowSize: number|null,
 *   families: {straight: Object, curved: Object, complex: Object}|null,
 * }>}
 */
async function evaluateSupportRecommendations({ studentId, windowSize = SUPPORT_PERFORMANCE_WINDOW_SIZE } = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, windowSize: null, families: null };
  }
  if (!isValidWindowSize(windowSize)) {
    return { status: 'invalid_window_size', studentId, windowSize: null, families: null };
  }

  // Reuses getSupportPerformanceByFamily() directly — Step 4 remains the
  // single, authoritative source for query/dedup/family-mapping/support-
  // resolution/score-reconstruction logic. No second copy of any of it here.
  const performanceResult = await getSupportPerformanceByFamily({ studentId, windowSize });
  if (performanceResult.status !== 'found') {
    // invalid_input/invalid_window_size are unreachable here (already
    // validated above with identical rules) but propagated defensively
    // rather than assumed unreachable; read_failed is the realistic case.
    return { status: performanceResult.status, studentId, windowSize, families: null };
  }

  let straightTarget, curvedTarget, complexTarget;
  try {
    [straightTarget, curvedTarget, complexTarget] = await Promise.all([
      getCurrentFamilyThreshold({ studentId, family: 'straight' }),
      getCurrentFamilyThreshold({ studentId, family: 'curved' }),
      getCurrentFamilyThreshold({ studentId, family: 'complex' }),
    ]);
  } catch (err) {
    logger.error('Support recommendation target lookup threw unexpectedly', { studentId, errorMessage: err.message });
    return { status: 'read_failed', studentId, windowSize, families: null };
  }

  const targets = { straight: straightTarget, curved: curvedTarget, complex: complexTarget };

  // A genuine DB error reading Feature 2's target must never be silently
  // reported as "no target" (that would misreport provenance) and must
  // never produce a partial/inconsistent result — same fail-closed
  // discipline Feature 2's own evaluateDynamicThresholds() already uses for
  // this exact situation.
  if (FAMILIES.some(family => targets[family].status === 'read_failed')) {
    return { status: 'read_failed', studentId, windowSize, families: null };
  }

  const families = {};
  for (const family of FAMILIES) {
    families[family] = evaluateFamilySupportDecision(family, performanceResult.families[family], targets[family]);
  }

  return { status: 'evaluated', studentId, windowSize, families };
}

module.exports = {
  SUPPORT_PERFORMANCE_WINDOW_SIZE,
  SUPPORT_SUCCESS_MET_COUNT,
  getSupportPerformanceByFamily,
  evaluateSupportRecommendations,
};

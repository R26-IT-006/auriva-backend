'use strict';

const { randomUUID } = require('crypto');

const {
  HandwritingAssessment,
  LetterProgress,
  Student,
  ExplanationResult,
  RecommendationHistory,
  StudentMotorFeature,
  ShapeFeature,
  LetterAttempt,
} = require('../models');
const { fn, col } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { LETTER_TO_PRIMITIVE, PRIMITIVE_LABELS } = require('../config/letterMotorPrimitives');
const logger   = require('../utils/logger');
const { getStudentThreshold } = require('../utils/thresholdUtils');
const { resolveProgressionThreshold } = require('../services/progressionThresholdResolver');
const { processDynamicThresholdAfterLetterSession } = require('../services/dynamicThresholdService');
const { analyzeMotorDifficulty } = require('../services/explainabilityService');
const { createInitialMotorBaseline, getStudentMotorBaseline } = require('../services/motorBaselineService');
const teacherService = require('../services/teacherService');
const { normalizeShapeFeatures, normalizeLetterFeatures } = require('../utils/featureNormalization');
const { computeMotorScore } = require('../utils/motorScore');
const { isValidLetterSupportLevel } = require('../config/letterSupportLevels');
const { isValidDemoSpeedLevel } = require('../config/demoSpeedPolicy');
// Feature 3 Step 6 — read-only support-recommendation endpoint. Reuses
// Step 5's evaluateSupportRecommendations() and Feature 2's own
// getBaselineFamily() directly; no recommendation logic is duplicated here.
const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const { evaluateSupportRecommendations } = require('../services/adaptiveSupportService');
// Feature 4 Step 5 — read-only pre-writing recommendation endpoint. Reuses
// Step 4's evaluatePreWritingRecommendation() directly; no recommendation
// logic is duplicated here.
const { evaluatePreWritingRecommendation } = require('../services/adaptivePreWritingService');
// Feature 5 Step 3 — read-only repetition recommendation endpoint. Reuses
// Step 2's evaluateRepetitionRecommendation() directly; no recommendation
// logic is duplicated here.
const { evaluateRepetitionRecommendation } = require('../services/repetitionRecommendationService');
// Feature 6 Step 3 — read-only demo-speed recommendation endpoint. Reuses
// evaluateDemoSpeedRecommendation() directly; no recommendation logic is
// duplicated here.
const { evaluateDemoSpeedRecommendation } = require('../services/demoSpeedRecommendationService');
// Feature 7 Step 3 — read-only, student-wide persistent-difficulty
// detection endpoint. Reuses evaluatePersistentDifficulty() directly; no
// evidence-reconstruction or decision logic is duplicated here.
const { evaluatePersistentDifficulty } = require('../services/persistentDifficultyService');

// item 7 / item 8: a row only counts as fully captured for ML if it has both
// raw points and a non-empty features object — used to set capture_status
// uniformly for both normal and collection mode (never blocks a save).
function rowCaptureStatus({ strokePoints, features }) {
  const hasStrokes  = Array.isArray(strokePoints) && strokePoints.length > 0;
  const hasFeatures = features != null && typeof features === 'object' && Object.keys(features).length > 0;
  return hasStrokes && hasFeatures ? 'complete' : 'incomplete';
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const CURVE_SHAPES = ['half_circle', 'full_circle', 'curve_wave'];
const LINE_SHAPES  = ['horizontal_line', 'vertical_line'];

function average(values) {
  const validValues = values.filter(value => Number.isFinite(value));
  if (validValues.length === 0) return null;
  return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildMotorFeatureSummary(shapes) {
  const safeShapes = Array.isArray(shapes) ? shapes : [];

  const avg_duration_ms = average(safeShapes.map(shape => toNumber(shape.features?.duration_ms)));
  const avg_total_distance = average(safeShapes.map(shape => toNumber(shape.features?.total_distance)));
  const avg_speed = average(safeShapes.map(shape => toNumber(shape.features?.avg_speed)));
  const avg_smoothness = average(safeShapes.map(shape => toNumber(shape.features?.smoothness)));
  const avg_pause_count = average(safeShapes.map(shape => toNumber(shape.features?.pause_count)));
  const avg_accuracy = average(safeShapes.map(shape => toNumber(shape.features?.accuracy)));
  const avg_stroke_count = average(safeShapes.map(shape => toNumber(shape.stroke_count)));

  return {
    shape_count: safeShapes.length,
    avg_duration_ms,
    avg_total_distance,
    avg_speed,
    avg_smoothness,
    avg_pause_count,
    avg_accuracy,
    avg_stroke_count,
    feature_vector: {
      avg_duration_ms,
      avg_total_distance,
      avg_speed,
      avg_smoothness,
      avg_pause_count,
      avg_accuracy,
      avg_stroke_count,
    },
  };
}

function deriveReason(shapes) {
  if (!Array.isArray(shapes)) return 'Continue regular letter practice.';

  const curveIssue = shapes.some(s =>
    CURVE_SHAPES.includes(s.shape_id) && (s.features?.smoothness ?? 0) > 0.3
  );
  if (curveIssue) return 'Curve control practice is required.';

  const lineIssue = shapes.some(s =>
    LINE_SHAPES.includes(s.shape_id) && (s.features?.avg_deviation ?? 0) > 20
  );
  if (lineIssue) return 'Straight line control practice is required.';

  const zigzag = shapes.find(s => s.shape_id === 'zigzag');
  if (zigzag && (zigzag.features?.smoothness ?? 0) > 0.4) {
    return 'Direction change control practice is required.';
  }

  return 'Continue regular letter practice.';
}

async function submitAssessment(req, res) {
  const {
    student_id, session_start, session_end, shapes, collection_mode,
    collection_session_id, protocol_version, device_type, app_version,
    feature_version, template_version, normalization_version,
  } = req.body;

  if (!student_id || !session_start || !session_end || !Array.isArray(shapes) || shapes.length === 0) {
    throw new ApiError(422, 'student_id, session_start, session_end, and shapes are required');
  }

  const existingCount = await HandwritingAssessment.count({ where: { student_id } });
  const is_initial    = existingCount === 0;

  const assessment = await HandwritingAssessment.create({
    student_id,
    session_start,
    session_end,
    shapes,
    is_initial,
    collection_mode:        collection_mode ?? false,
    collection_session_id:  collection_session_id ?? null,
    protocol_version:       protocol_version ?? null,
    capture_status:         'complete',
  });

  // ML: persist per-shape features + raw strokes — additive, does not replace shapes JSON
  try {
    if (Array.isArray(shapes) && shapes.length > 0) {
      await ShapeFeature.bulkCreate(
        shapes.map((shape, index) => {
          const { normalized, validity } = normalizeShapeFeatures(shape.features, {
            strokeCount:  shape.stroke_count,
            strokePoints: shape.strokes,
          });
          const { motor_score, quality_score, score_version } = computeMotorScore(normalized);

          return {
            assessment_id:   assessment.id,
            student_id,
            shape_type:      shape.shape_id,
            attempt_number:  1,
            features:        shape.features ?? {},
            stroke_points:   shape.strokes  ?? [],
            collection_mode: collection_mode ?? false,

            collection_session_id, // undefined -> Sequelize stores NULL
            protocol_version,
            task_order:      index,
            capture_status:  rowCaptureStatus({ strokePoints: shape.strokes, features: shape.features }),

            canvas_width:    shape.canvas_width  ?? null,
            canvas_height:   shape.canvas_height ?? null,
            device_type,
            app_version,
            feature_version,
            template_version,
            normalization_version,

            normalized_features: normalized,
            feature_validity:    validity,
            motor_score,
            quality_score,
            score_version,
            collection_accepted: true,
            // Always null for shapes today — no multi-stroke template concept
            // for zigzag/curve_wave (see computeMultiStrokeDTW, letters only).
            stroke_order_matches_template: normalized.stroke_order_meta?.strokeOrderMatchesTemplate ?? null,
          };
        })
      );
    }
  } catch (dbErr) {
    console.error('ShapeFeature save error (non-fatal):', dbErr.message);
  }

  try {
    const featureSummary = buildMotorFeatureSummary(shapes);
    await StudentMotorFeature.create({
      student_id,
      assessment_id: assessment.id,
      is_initial,
      ...featureSummary,
    });
  } catch (dbErr) {
    console.error('StudentMotorFeature save error (non-fatal):', dbErr.message);
  }

  res.status(201).json({ id: assessment.id, is_initial, message: 'Assessment saved' });
}

// Pre-writing warm-up activities (shown before a letter set that shares a
// motor primitive — see frontend constants/preWritingActivities.js and
// PreWritingActivityScreen.js). Same shape_features row shape and the same
// normalizeShapeFeatures/computeMotorScore pipeline as submitAssessment, but
// deliberately does NOT create a handwriting_assessments or
// student_motor_features row — warm-up attempts are not part of the initial
// 6-shape battery and must not feed the adaptive-sequencing motor profile.
async function submitPreWritingActivity(req, res) {
  const {
    student_id, results, collection_mode,
    device_type, app_version, feature_version, template_version, normalization_version,
    canvas_width, canvas_height,
  } = req.body;

  if (!student_id || !Array.isArray(results) || results.length === 0) {
    throw new ApiError(422, 'student_id and a non-empty results array are required');
  }

  // Warm-ups are additive practice, never part of the fixed research
  // protocol — reject rather than silently mislabeling collection-mode data.
  if (collection_mode === true) {
    throw new ApiError(422, 'Pre-writing warm-ups are not part of collection mode');
  }

  const rows = results.map((result, index) => {
    const { normalized, validity } = normalizeShapeFeatures(
      { duration_ms: result.duration_ms, smoothness: result.smoothness, dtw_distance: result.dtw_distance },
      { strokeCount: result.strokes?.length, strokePoints: result.strokes },
    );
    const { motor_score, quality_score, score_version } = computeMotorScore(normalized);

    return {
      assessment_id:   null,
      student_id,
      source:          'pre_writing_warmup',
      shape_type:      result.activity_id,
      attempt_number:  result.attempt_count ?? 1,
      features:        { duration_ms: result.duration_ms, smoothness: result.smoothness, dtw_distance: result.dtw_distance },
      stroke_points:   result.strokes ?? [],
      collection_mode: false,

      task_order:      index,
      capture_status:  rowCaptureStatus({ strokePoints: result.strokes, features: { dtw_distance: result.dtw_distance } }),

      canvas_width:    canvas_width  ?? null,
      canvas_height:   canvas_height ?? null,
      device_type,
      app_version,
      feature_version,
      template_version,
      normalization_version,

      normalized_features: normalized,
      feature_validity:    validity,
      motor_score,
      quality_score,
      score_version,
      collection_accepted: !result.skipped,
      threshold_passed:    result.skipped ? null : !!result.passed,
    };
  });

  const created = await ShapeFeature.bulkCreate(rows);
  res.status(201).json({ count: created.length, message: 'Pre-writing activity results saved' });
}

async function getProgress(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  const [latest, lowercase_completed, uppercase_completed] = await Promise.all([
    HandwritingAssessment.findOne({
      where: { student_id: studentId },
      order: [['created_at', 'DESC']],
    }),
    LetterProgress.count({ where: { student_id: studentId, case_type: 'lowercase' } }),
    LetterProgress.count({ where: { student_id: studentId, case_type: 'uppercase' } }),
  ]);

  const reason = latest ? deriveReason(latest.shapes) : 'Continue regular letter practice.';

  res.json({
    lowercase_completed,
    uppercase_completed,
    next_lowercase_letter: lowercase_completed < 26 ? LETTERS[lowercase_completed] : null,
    next_uppercase_letter: uppercase_completed < 26 ? LETTERS[uppercase_completed].toUpperCase() : null,
    reason,
  });
}

// Feature 3 Step 3 — resolves the per-attempt support_level to persist,
// tolerant of older clients that don't send it at all. Never rejects the
// whole letter-completion request over a missing/invalid value — matches
// this file's existing tolerant-ingestion style (e.g. rowCaptureStatus()
// above never blocks a save either; normalizeLetterFeatures() degrades
// gracefully rather than throwing on malformed features).
//
// Distinguishes two cases:
//   - absent (undefined/null)   → null, silently. Expected for older app
//     builds, tests, and any legacy client that predates Feature 3 Step 2 —
//     not a real problem, so not logged.
//   - present but not one of 'high'|'medium'|'low' → null, WITH a logged
//     warning. A real, current client sending a garbled value is worth
//     knowing about even though it must never block the save (see Step 3
//     spec §13/§14: invalid explicit value → null + warning, never a
//     silent attempt_number-derived guess, and never a request rejection).
function resolveAttemptSupportLevel(rawValue, context) {
  if (rawValue == null) return null;
  if (isValidLetterSupportLevel(rawValue)) return rawValue;

  logger.warn('LetterAttempt received an invalid support_level — persisting null', {
    ...context,
    rawValue: typeof rawValue === 'string' ? rawValue : typeof rawValue,
  });
  return null;
}

// Feature 6 Step 5 — resolves the per-attempt demo_speed_level to persist.
// Mirrors resolveAttemptSupportLevel() above exactly (same tolerant-ingestion
// discipline, same absent-vs-invalid distinction), applied to Feature 6's
// 'standard'|'slow' vocabulary instead of Feature 3's 'high'|'medium'|'low'.
//
// Deliberately NOT reconstructed here from support_level/attempt_number/any
// backend recommendation (Step 5 spec §41) — the frontend is the sole
// authority on what was actually rendered (resolveActualDemoSpeedLevel()),
// since only it knows whether reduce-motion was active, whether the tracer
// component actually mounted, and the true collection-mode state for this
// exact attempt. This function only validates the client's own claim; it
// never derives one.
//
//   - absent (undefined/null) → null, silently. Expected whenever no tracer
//     was actually shown for this attempt (MEDIUM/LOW support, reduce-motion,
//     collection mode) — see buildSessionAttemptRecord() on the frontend,
//     which already sends null in exactly these cases — and for any client
//     older than Feature 6 Step 5.
//   - present but not one of 'standard'|'slow' → null, WITH a logged
//     warning — a real, current client sending a garbled value is worth
//     knowing about even though it must never block the save (same
//     "invalid → null + warning, never a guess, never a rejection" contract
//     as support_level, Step 5 spec §40).
function resolveAttemptDemoSpeedLevel(rawValue, context) {
  if (rawValue == null) return null;
  if (isValidDemoSpeedLevel(rawValue)) return rawValue;

  logger.warn('LetterAttempt received an invalid demo_speed_level — persisting null', {
    ...context,
    rawValue: typeof rawValue === 'string' ? rawValue : typeof rawValue,
  });
  return null;
}

// ML: bulk-insert one immutable row per attempt element from a single POST call.
// All rows share the same session_key so the full session is always queryable.
// Never updates existing rows — true append-only store.
function saveLetterAttempts(attempts, {
  student_id, letter, case_type, sessionKey, passed, bestScore, threshold, collection_mode,
  collection_session_id, protocol_version, device_type, app_version,
  feature_version, template_version, normalization_version, task_order, canvas_width, canvas_height,
}) {
  if (!Array.isArray(attempts) || attempts.length === 0) return Promise.resolve();

  const thresholdPassed = (bestScore != null && threshold != null) ? bestScore >= threshold : null;

  return LetterAttempt.bulkCreate(
    attempts.map(a => {
      const { normalized, validity } = normalizeLetterFeatures(a.features, { strokePoints: a.strokes });
      const { motor_score, quality_score, score_version } = computeMotorScore(normalized);

      return {
        student_id,
        letter,
        case_type,
        session_key:     sessionKey,
        attempt_number:  a.attempt_number ?? 1,
        passed,
        best_score:      bestScore ?? null,
        threshold:       threshold ?? null,
        features:        a.features ?? null,
        stroke_points:   a.strokes  ?? null,
        // Feature 3 Step 3 — read from THIS attempt's own payload object,
        // never derived from attempt_number and never a single session-level
        // value copied across rows (each attempt in `attempts` can — and,
        // once adaptive support exists, eventually will — carry a different
        // support_level; see resolveAttemptSupportLevel() above).
        support_level: resolveAttemptSupportLevel(a.support_level, {
          student_id, letter, case_type, sessionKey, attemptNumber: a.attempt_number ?? 1,
        }),
        // Feature 6 Step 5 — read from THIS attempt's own payload object,
        // same per-attempt (never session-level) discipline as support_level
        // immediately above. See resolveAttemptDemoSpeedLevel()'s own
        // comment for why this is never reconstructed server-side.
        demo_speed_level: resolveAttemptDemoSpeedLevel(a.demo_speed_level, {
          student_id, letter, case_type, sessionKey, attemptNumber: a.attempt_number ?? 1,
        }),
        collection_mode: collection_mode ?? false,

        collection_session_id,
        protocol_version,
        task_order,
        capture_status:  rowCaptureStatus({ strokePoints: a.strokes, features: a.features }),

        canvas_width:  canvas_width  ?? null,
        canvas_height: canvas_height ?? null,
        device_type,
        app_version,
        feature_version,
        template_version,
        normalization_version,

        normalized_features: normalized,
        feature_validity:    validity,
        motor_score,
        quality_score,
        score_version,

        // collection_accepted = row saved successfully — NEVER an ML quality
        // label. threshold_passed is the real bestScore >= threshold
        // comparison; in collection mode it's computed but never gates.
        collection_accepted: true,
        threshold_passed:    thresholdPassed,
        // Flat copy of normalized.stroke_order_meta.strokeOrderMatchesTemplate
        // (multi-stroke letters only) — null when no stroke-order comparison
        // was possible (single-stroke letter/template).
        stroke_order_matches_template: normalized.stroke_order_meta?.strokeOrderMatchesTemplate ?? null,
      };
    })
  );
}

// Feature 2 Step 8 — the ONLY trigger point for automatic Feature 2
// re-evaluation: called after saveLetterAttempts has succeeded (never
// before — Step 4's recent-window read needs the just-persisted rows to
// exist), from EITHER the failure or success branch of normal-mode
// completion, never from collection mode. Non-fatal by design: adaptation
// failing must never turn a successful/failed letter-completion response
// into a server error, and must never retroactively change the threshold
// that already gated THIS session (see progressionThresholdResolver.js —
// threshold was already resolved and used before this ever runs).
async function runDynamicThresholdOrchestration({ studentId, letter, caseType, sessionKey, attempts, requestedQualityThreshold }) {
  // Section 5 — cheap, local guard computed from the request's own
  // attempts array (already in scope, no extra query): only a session that
  // actually included an attempt_number=3 record could possibly have
  // changed a family's recent independent-performance window.
  const hasAttempt3Evidence = Array.isArray(attempts) && attempts.some(a => a?.attempt_number === 3);
  try {
    return await processDynamicThresholdAfterLetterSession({
      studentId, letter, caseType, sessionKey, hasAttempt3Evidence, requestedQualityThreshold,
    });
  } catch (err) {
    // Defense in depth — processDynamicThresholdAfterLetterSession is
    // itself already designed to catch its own expected failure modes and
    // return status:'error' rather than throw; this catch exists only for
    // a genuinely unexpected exception, so a Feature 2 bug can never
    // surface as a 500 to the child.
    logger.error('Dynamic threshold orchestration threw unexpectedly (non-fatal)', {
      studentId, letter, caseType, sessionKey, errorMessage: err.message,
    });
    return { status: 'error', family: null, decision: null, newThreshold: null, historyId: null };
  }
}

async function recordLetterCompletion(req, res) {
  const { student_id, letter, case_type, attempt_scores, quality_threshold, wrote_correctly,
          attempts, collection_mode,
          collection_session_id, protocol_version, device_type, app_version,
          feature_version, template_version, normalization_version, task_order,
          canvas_width, canvas_height } = req.body;   // ML: attempts is optional — old clients omit it

  if (!student_id || !letter || !case_type) {
    throw new ApiError(422, 'student_id, letter, and case_type are required');
  }
  if (!['lowercase', 'uppercase'].includes(case_type)) {
    throw new ApiError(422, 'case_type must be lowercase or uppercase');
  }

  // ML: one UUID groups all attempt rows from this single POST call
  const sessionKey = randomUUID();
  const metaFields = {
    collection_session_id, protocol_version, device_type, app_version,
    feature_version, template_version, normalization_version, task_order, canvas_width, canvas_height,
  };

  // Collection mode: skip all threshold/blocking logic, always complete
  if (collection_mode === true) {
    const colBestScore = Array.isArray(attempt_scores) && attempt_scores.length > 0
      ? Math.max(...attempt_scores)
      : null;
    let colThreshold = typeof quality_threshold === 'number' ? quality_threshold : null;
    // item 6: still compute the real threshold comparison in collection mode
    // (for `threshold_passed`) even though it never gates here — frontend
    // does not send quality_threshold today, so fall back to the same
    // lookup normal mode uses. Best-effort: never blocks collection on failure.
    if (colThreshold == null) {
      try {
        colThreshold = await getStudentThreshold(student_id, letter);
      } catch (thresholdErr) {
        console.error('Threshold lookup failed in collection mode (non-fatal):', thresholdErr.message);
      }
    }
    try {
      await saveLetterAttempts(attempts, {
        student_id, letter, case_type, sessionKey,
        passed: true, bestScore: colBestScore, threshold: colThreshold,
        collection_mode: true,
        ...metaFields,
      });
    } catch (dbErr) {
      console.error('LetterAttempt save error (non-fatal):', dbErr.message);
    }
    return res.status(200).json({ completed: true, collection_mode: true });
  }

  let bestScore = null;
  let threshold = null;
  // Feature 2 Step 7 — additive response/diagnostic metadata only; the
  // gate itself is still exactly `bestScore < threshold` below, unchanged.
  let thresholdSource = null;
  let thresholdFamily = null;

  if (Array.isArray(attempt_scores) && attempt_scores.length > 0) {
    bestScore = Math.max(...attempt_scores);

    // Feature 2 Step 7: resolveProgressionThreshold() replaces the old
    // inline ternary (`typeof quality_threshold === 'number' ? ... :
    // await getStudentThreshold(...)`) with a priority chain that ALSO
    // considers a student's current Feature 2 family target — see
    // src/services/progressionThresholdResolver.js for the full priority
    // order and rationale. `status !== 'resolved'` should not be
    // reachable here (student_id/case_type are already validated above),
    // but falls back to the untouched legacy getStudentThreshold() as a
    // last-resort safety net rather than ever leaving threshold unresolved.
    const thresholdResolution = await resolveProgressionThreshold({
      studentId: student_id, letter, caseType: case_type, requestedQualityThreshold: quality_threshold,
    });
    if (thresholdResolution.status === 'resolved') {
      threshold = thresholdResolution.threshold;
      thresholdSource = thresholdResolution.source;
      thresholdFamily = thresholdResolution.family;
    } else {
      threshold = await getStudentThreshold(student_id, letter);
      thresholdSource = 'legacy_fallback_resolver_error';
      thresholdFamily = null;
    }

    if (bestScore < threshold) {
      const [rec] = await LetterProgress.findOrCreate({
        where:    { student_id, letter, case_type },
        defaults: { student_id, letter, case_type, blocked_attempts: 0 },
      });
      await rec.increment('blocked_attempts', { by: 1 });
      const updatedRec = await LetterProgress.findOne({
        where: { student_id, letter, case_type },
      });
      if (updatedRec.blocked_attempts > 3) {
        const student = await Student.findByPk(student_id);
        const current    = student.personal_thresholds ?? {};
        const currentVal = current[letter] ?? current.default ?? 55;
        const newVal     = Math.max(20, currentVal - 5);
        await student.update({
          personal_thresholds: { ...current, [letter]: newVal },
        });
        logger.info(`Auto-lowered threshold: student=${student_id} ` +
          `letter=${letter} ${currentVal} → ${newVal} ` +
          `(blocked_attempts=${updatedRec.blocked_attempts})`);
      }
      // ML: persist attempt_data for failed attempts — latest-attempt convenience field.
      // Note: overwrites on retry; immutable records below are the ML source of truth.
      if (Array.isArray(attempts) && attempts.length > 0) {
        await rec.update({ attempt_data: attempts });
      }
      // ML: immutable per-attempt records — append-only, survive every retry
      let attemptsSaved = false;
      try {
        await saveLetterAttempts(attempts, {
          student_id, letter, case_type, sessionKey, passed: false, bestScore, threshold,
          collection_mode: false,
          ...metaFields,
        });
        attemptsSaved = true;
      } catch (dbErr) {
        console.error('LetterAttempt save error (non-fatal):', dbErr.message);
      }

      // Feature 2 Step 8 — orchestration runs only AFTER a successful save
      // (Section 2), regardless of whether THIS session itself passed
      // (Section 4/10 — a failed independent attempt is still valid recent-
      // window evidence). Non-fatal, additive-only response metadata.
      let dynamicThresholdStatus = null;
      let dynamicThresholdNextThreshold = null;
      if (attemptsSaved) {
        const orchestrationResult = await runDynamicThresholdOrchestration({
          studentId: student_id, letter, caseType: case_type, sessionKey, attempts,
          requestedQualityThreshold: quality_threshold,
        });
        dynamicThresholdStatus = orchestrationResult.status;
        dynamicThresholdNextThreshold = orchestrationResult.newThreshold;
      }

      logger.info(`Letter blocked: student=${student_id} ` +
        `letter=${letter} bestScore=${bestScore} ` +
        `threshold=${threshold} wroteCorrectly=${wrote_correctly}`);
      return res.status(200).json({
        completed: false, bestScore, threshold,
        thresholdSource, thresholdFamily,
        dynamicThresholdStatus, dynamicThresholdNextThreshold,
        message: 'Quality threshold not met'
      });
    }
  }

  const [record, created] = await LetterProgress.findOrCreate({
    where:    { student_id, letter, case_type },
    defaults: { student_id, letter, case_type, blocked_attempts: 0 },
  });

  const recentPasses = await LetterProgress.findAll({
    where: { student_id, case_type },
    order: [['completed_at', 'DESC']],
    limit: 5,
  });
  if (recentPasses.length === 5 &&
      recentPasses.every(r => r.blocked_attempts === 0)) {
    const student        = await Student.findByPk(student_id);
    const current        = student.personal_thresholds ?? {};
    const currentDefault = current.default ?? 55;
    const newDefault     = Math.min(85, currentDefault + 5);
    if (newDefault !== currentDefault) {
      await student.update({
        personal_thresholds: { ...current, default: newDefault },
      });
      logger.info(`Auto-raised default threshold: student=${student_id} ` +
        `${currentDefault} → ${newDefault} (5 clean consecutive passes)`);
    }
  }

  // ML: persist per-attempt raw data when the new client sends it (latest-attempt convenience)
  if (Array.isArray(attempts) && attempts.length > 0) {
    await record.update({ attempt_data: attempts });
  }
  // ML: immutable per-attempt records — append-only, survive every retry
  let attemptsSaved = false;
  try {
    await saveLetterAttempts(attempts, {
      student_id, letter, case_type, sessionKey, passed: true, bestScore, threshold,
      collection_mode: false,
      ...metaFields,
    });
    attemptsSaved = true;
  } catch (dbErr) {
    console.error('LetterAttempt save error (non-fatal):', dbErr.message);
  }

  // Feature 2 Step 8 — orchestration runs only AFTER a successful save,
  // from the success branch too (Section 10) — a passing session is just
  // as valid recent-window evidence as a failing one. Non-fatal,
  // additive-only response metadata.
  let dynamicThresholdStatus = null;
  let dynamicThresholdNextThreshold = null;
  if (attemptsSaved) {
    const orchestrationResult = await runDynamicThresholdOrchestration({
      studentId: student_id, letter, caseType: case_type, sessionKey, attempts,
      requestedQualityThreshold: quality_threshold,
    });
    dynamicThresholdStatus = orchestrationResult.status;
    dynamicThresholdNextThreshold = orchestrationResult.newThreshold;
  }

  logger.info(`Letter complete: student=${student_id} ` +
    `letter=${letter} bestScore=${bestScore ?? 'n/a'} ` +
    `threshold=${threshold ?? 'default'} wroteCorrectly=${wrote_correctly}`);
  res.status(created ? 201 : 200).json({
    id: record.id, letter, case_type,
    threshold, thresholdSource, thresholdFamily,
    dynamicThresholdStatus, dynamicThresholdNextThreshold,
  });
}

/**
 * POST /handwriting/explain
 *
 * Accepts shape-assessment data + optional letter metrics, runs the
 * rule-based explainability engine, stores the result, and returns a
 * structured teacher-friendly explanation with feature contributions.
 *
 * Request body:
 *  {
 *    student_id       : number,
 *    assessment_id    : number  (optional – link to an existing assessment)
 *    shapes           : [{ shapeId, features: { smoothness, avg_deviation } }],
 *    letter_metrics   : { avgPauses, avgTime }  (optional)
 *    motor_score      : number  (optional pre-computed score)
 *  }
 */
async function explainAssessment(req, res) {
  const { student_id, assessment_id, shapes, letter_metrics, motor_score } = req.body;

  if (!student_id || !Array.isArray(shapes) || shapes.length === 0) {
    throw new ApiError(422, 'student_id and shapes array are required');
  }

  const result = analyzeMotorDifficulty(shapes, letter_metrics ?? {}, motor_score ?? null);

  // Persist explanation result (fire-and-forget — don't block response on DB error)
  try {
    const saved = await ExplanationResult.create({
      assessment_id:        assessment_id ?? null,
      student_id,
      difficulty_type:      result.difficultyKey,
      difficulty_label:     result.difficulty,
      confidence_score:     result.confidence ?? null,
      motor_score:          result.motorScore ?? null,
      feature_contributions: result.featureContributions,
      explanation_lines:    result.explanation,
      recommendations:      result.recommendations,
    });

    // Record in recommendation history only when a real difficulty was detected
    if (result.difficultyKey && result.difficultyKey !== 'NONE') {
      await RecommendationHistory.create({
        student_id,
        difficulty_type:  result.difficultyKey,
        difficulty_label: result.difficulty,
        recommendations:  result.recommendations,
      });
    }

    res.status(201).json({
      id:                   saved.id,
      difficulty:           result.difficulty,
      difficultyKey:        result.difficultyKey,
      confidence:           result.confidence,
      motorScore:           result.motorScore,
      description:          result.description,
      featureContributions: result.featureContributionsMap,
      explanation:          result.explanation,
      recommendations:      result.recommendations.map(r => r.text),
      letterFocus:          result.letterFocus,
      secondaryDifficulty:  result.secondaryDifficulty ?? null,
    });
  } catch (dbErr) {
    // DB storage failed — still return analysis so teacher can see it
    console.error('ExplanationResult save error (non-fatal):', dbErr.message);
    res.status(200).json({
      difficulty:           result.difficulty,
      difficultyKey:        result.difficultyKey,
      confidence:           result.confidence,
      motorScore:           result.motorScore,
      description:          result.description,
      featureContributions: result.featureContributionsMap,
      explanation:          result.explanation,
      recommendations:      result.recommendations.map(r => r.text),
      letterFocus:          result.letterFocus,
      secondaryDifficulty:  result.secondaryDifficulty ?? null,
      _warning:             'Result could not be saved to database.',
    });
  }
}

/**
 * GET /handwriting/explanation/:studentId
 *
 * Fetches the most recent explanation result for a student.
 */
async function getLatestExplanation(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  const record = await ExplanationResult.findOne({
    where: { student_id: studentId },
    order: [['created_at', 'DESC']],
  });

  if (!record) {
    return res.json({ message: 'No explanation found for this student', data: null });
  }

  res.json({
    id:                   record.id,
    difficulty:           record.difficulty_label,
    difficultyKey:        record.difficulty_type,
    confidence:           record.confidence_score,
    motorScore:           record.motor_score,
    featureContributions: record.feature_contributions,
    explanation:          record.explanation_lines,
    recommendations:      record.recommendations,
    createdAt:            record.created_at,
  });
}

// ─── Finalize idempotency helpers (private) ────────────────────────────────
// Reliability Step 1: makes repeated PATCH .../finalize calls for the same
// assessment safe. See tests/finalizeAssessmentIdempotency.test.js.

const SCORE_EPSILON = 1e-6;

// Never Number(value) coerce — same rationale as motorBaselineService.js:
// missing/malformed data must never compare equal to a real number by accident.
function numbersApproximatelyEqual(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b; // both null/undefined → equal
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < SCORE_EPSILON;
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// motor_profile.shapeScores is { horizontal_line: 96.18..., ... } — floats,
// not rounded like the three family scores (confirmed against live data).
function shapeScoresEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => numbersApproximatelyEqual(a[k], b[k]));
}

// Compares the meaningful fields of a persisted motor_profile against an
// incoming one — never JSON.stringify (property order is not guaranteed) and
// never object-reference equality (a freshly re-sent clone must still match).
// Real persisted shape (see calculateMotorProfile() in
// frontend/src/utils/adaptiveSequencing.js, verified against live data):
// { straightScore, curvedScore, complexScore, primaryStrength, categoryOrder,
//   recommendedSequence, shapeScores }.
function motorProfilesEqual(existing, incoming) {
  if (existing === incoming) return true;
  if (existing == null || incoming == null) return false;
  if (typeof existing !== 'object' || typeof incoming !== 'object') return false;

  return (
    numbersApproximatelyEqual(existing.straightScore, incoming.straightScore) &&
    numbersApproximatelyEqual(existing.curvedScore, incoming.curvedScore) &&
    numbersApproximatelyEqual(existing.complexScore, incoming.complexScore) &&
    existing.primaryStrength === incoming.primaryStrength &&
    arraysEqual(existing.categoryOrder, incoming.categoryOrder) &&
    existing.recommendedSequence === incoming.recommendedSequence &&
    shapeScoresEqual(existing.shapeScores, incoming.shapeScores)
  );
}

/**
 * Determines whether this finalize call is a genuine first-time finalize, an
 * exact resend of an already-finalized assessment (safe to no-op the
 * mutation but still retry baseline creation), or a conflicting resend
 * (different values for an already-finalized assessment — must be rejected).
 */
function classifyFinalizeRequest(assessment, incomingMotorScore, incomingMotorProfile) {
  const previouslyFinalized = assessment.motor_score != null && assessment.motor_profile != null;
  if (!previouslyFinalized) return { previouslyFinalized: false, isResend: false };

  const isResend =
    numbersApproximatelyEqual(assessment.motor_score, incomingMotorScore) &&
    motorProfilesEqual(assessment.motor_profile, incomingMotorProfile);

  return { previouslyFinalized: true, isResend };
}

/**
 * PATCH /handwriting/assessment/:id/finalize
 *
 * Called after the client computes the motor profile.
 * Stores motor_score + motor_profile on the assessment record,
 * then runs the explainability engine and saves to ExplanationResult.
 *
 * Idempotent for repeated identical calls (Reliability Step 1): an exact
 * resend of the same assessmentId + motor_score + motor_profile never
 * duplicates ExplanationResult/RecommendationHistory, and still safely
 * retries baseline creation (already idempotent — see
 * motorBaselineService.js, unchanged). A resend with materially different
 * values for an already-finalized assessment is rejected with 409 rather
 * than silently overwriting the original finalization.
 */
async function finalizeAssessment(req, res) {
  const assessmentId = parseInt(req.params.id, 10);
  const { motor_score, motor_profile } = req.body;

  if (!assessmentId || motor_score == null || !motor_profile) {
    throw new ApiError(422, 'Assessment ID, motor_score, and motor_profile are required');
  }

  const assessment = await HandwritingAssessment.findByPk(assessmentId);
  if (!assessment) throw new ApiError(404, 'Assessment not found');

  const { previouslyFinalized, isResend } = classifyFinalizeRequest(assessment, motor_score, motor_profile);

  // Conflict: this assessment was already finalized with DIFFERENT values.
  // Reject before any mutation — protects the immutable meaning of the
  // finalized initial assessment. No assessment.update, no explainability
  // write, no baseline call.
  if (previouslyFinalized && !isResend) {
    throw new ApiError(409, 'Assessment has already been finalized with different values');
  }

  // First-time only — on a resend the persisted values already match
  // exactly (that's what isResend means), so re-writing them is a pointless
  // no-op write; skipping it keeps this endpoint's DB footprint minimal on
  // retry rather than merely harmless.
  if (!isResend) {
    await assessment.update({ motor_score, motor_profile });
  }

  // Map stored shapes (shape_id) → format expected by explainabilityService (shapeId)
  const shapesForAnalysis = (assessment.shapes ?? []).map(s => ({
    shapeId:  s.shape_id,
    features: s.features,
  }));

  // ExplanationResult.assessment_id is the idempotency anchor for
  // explainability — checked BEFORE creating, regardless of whether this is
  // a resend or a genuine first-time finalize. This also protects against a
  // row that already exists because POST /handwriting/explain was called
  // separately for the same assessment_id (a real, intentional code path —
  // see explainAssessment — not just a finalize retry). Earliest row wins on
  // ties; historical duplicates (confirmed present on live data — assessment
  // 113 and 202 each already have 2 rows) are logged, never merged/deleted
  // here — that is a separate data-quality task.
  const existingExplanations = await ExplanationResult.findAll({
    where: { assessment_id: assessment.id },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    limit: 2, // only need to know "one" vs "more than one" for the warning
  });

  let result;
  if (existingExplanations.length > 0) {
    const existing = existingExplanations[0];
    result = { difficulty: existing.difficulty_label, difficultyKey: existing.difficulty_type };
    if (existingExplanations.length > 1) {
      logger.warn('Multiple ExplanationResult rows found for assessment — reusing earliest, not merging/deleting', {
        assessmentId: assessment.id, status: 'duplicate_explanation_detected',
      });
    }
  } else {
    result = analyzeMotorDifficulty(shapesForAnalysis, {}, motor_score);
    try {
      await ExplanationResult.create({
        assessment_id:         assessmentId,
        student_id:            assessment.student_id,
        difficulty_type:       result.difficultyKey,
        difficulty_label:      result.difficulty,
        confidence_score:      result.confidence ?? null,
        motor_score,
        feature_contributions: result.featureContributions,
        explanation_lines:     result.explanation,
        recommendations:       result.recommendations,
      });

      // RecommendationHistory has no assessment_id column (see Reliability
      // Step 1 audit), so — unlike ExplanationResult — it cannot be checked
      // for an existing row tied to this specific assessment. The only safe
      // anchor against duplicating it on a resend is "was this assessment
      // ever finalized before at all" (previouslyFinalized). This covers the
      // rare case where a resend's ExplanationResult happens to be missing
      // (findAll above returned none, so we're in this branch even though
      // isResend may be true): we still create the missing ExplanationResult
      // row (safe — assessment_id proves no duplicate), but deliberately do
      // NOT create RecommendationHistory, since we cannot prove one wasn't
      // already recorded on the original attempt. Conservative by design.
      if (!previouslyFinalized && result.difficultyKey && result.difficultyKey !== 'NONE') {
        await RecommendationHistory.create({
          student_id:       assessment.student_id,
          difficulty_type:  result.difficultyKey,
          difficulty_label: result.difficulty,
          recommendations:  result.recommendations,
        });
      }
    } catch (dbErr) {
      console.error('ExplanationResult save error (non-fatal):', dbErr.message);
    }
  }

  // Feature 1: Individual Motor-Family Baseline. Reads the assessment row we
  // just persisted above (never the request body) so the baseline always
  // reflects the same values now stored on HandwritingAssessment — see
  // src/services/motorBaselineService.js for eligibility/validation rules.
  // Always called, resend or not — this is exactly the "assessment update
  // succeeded, baseline creation failed, response lost" recovery path:
  // createInitialMotorBaseline() is itself already idempotent (unchanged
  // this step), so a resend safely retries it (save_failed → created) or
  // no-ops (created → already_exists).
  // Non-fatal by design: a baseline failure must never roll back the
  // finalize above, change this endpoint's success status, or block the
  // explainability result already computed. The service itself already
  // catches expected DB failures and returns { status: 'save_failed', ... };
  // this try/catch is defense-in-depth against the service throwing
  // unexpectedly rather than resolving.
  let baselineResult = {
    status:   'save_failed',
    baseline: null,
    reason:   'unexpected_service_error',
  };
  try {
    baselineResult = await createInitialMotorBaseline({
      studentId:    assessment.student_id,
      assessmentId: assessment.id,
    });
  } catch (error) {
    logger.error('Motor baseline service threw unexpectedly during finalize', {
      studentId:    assessment.student_id,
      assessmentId: assessment.id,
      status:       'save_failed',
      errorMessage: error.message,
    });
  }

  res.json({
    id:           assessmentId,
    is_initial:   assessment.is_initial,
    motor_score,
    difficulty:   result.difficulty,
    difficultyKey: result.difficultyKey,
    message:      'Assessment finalized',
    baselineStatus: baselineResult.status,
    baselineId:     baselineResult.baseline?.id ?? null,
    baselineReason: baselineResult.reason ?? null,
    finalizeStatus: isResend ? 'already_finalized' : 'finalized',
  });
}

/**
 * GET /handwriting/initial-report/:studentId
 *
 * Returns the stored initial assessment + explanation for a student,
 * used by TeacherReportScreen to show permanent motor analysis data.
 */
async function getInitialReport(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  // Best real score ever achieved per letter, from actual practice attempts —
  // excludes research/protocol rows. Independent of whether a shape
  // assessment exists, since letter practice happens separately. `letter`
  // already encodes case (e.g. 'l' vs 'L'), same as case_type, so lowercase
  // and uppercase mastery are never merged together.
  const letterMasteryRows = await LetterAttempt.findAll({
    where: { student_id: studentId, collection_mode: false },
    attributes: ['letter', 'case_type', [fn('MAX', col('best_score')), 'best_score']],
    group: ['letter', 'case_type'],
    raw: true,
  });
  const letterMastery = letterMasteryRows.map(r => ({
    letter:     r.letter,
    case_type:  r.case_type,
    best_score: r.best_score != null ? Math.round(r.best_score) : null,
  }));

  // `is_initial` is unreliable on existing rows (historically never set true
  // for any student — see schema drift audit), so use the earliest non-research
  // assessment for this student as "the initial assessment" instead.
  const assessment = await HandwritingAssessment.findOne({
    where: { student_id: studentId, collection_mode: false },
    order: [['created_at', 'ASC']],
  });

  if (!assessment) {
    return res.json({ hasData: false, letterMastery });
  }

  const explanation = await ExplanationResult.findOne({
    where: { assessment_id: assessment.id },
    order: [['created_at', 'DESC']],
  });

  res.json({
    hasData: true,
    assessment: {
      id:            assessment.id,
      motor_score:   assessment.motor_score,
      motor_profile: assessment.motor_profile,
      shapes:        assessment.shapes,
      created_at:    assessment.created_at,
      is_initial:    assessment.is_initial,
    },
    explanation: explanation ? {
      difficulty:           explanation.difficulty_label,
      difficultyKey:        explanation.difficulty_type,
      confidence:           explanation.confidence_score,
      featureContributions: explanation.feature_contributions,
      explanation:          explanation.explanation_lines,
      recommendations:      explanation.recommendations,
    } : null,
    letterMastery,
  });
}

/**
 * GET /handwriting/letter-progress-report/:studentId
 *
 * Per-letter (grouped by case_type) attempt history summary for the teacher
 * report: attempt/session counts, first vs latest score, average, best,
 * and improvement delta. Read-only — excludes research/protocol rows.
 */
async function getLetterProgressReport(req, res) {
  const studentId = parseInt(req.params.studentId, 10);
  if (!studentId) throw new ApiError(422, 'Invalid student ID');

  const attempts = await LetterAttempt.findAll({
    where: { student_id: studentId, collection_mode: false },
    attributes: ['letter', 'case_type', 'session_key', 'best_score', 'created_at'],
    order: [['created_at', 'ASC']],
    raw: true,
  });

  const byLetter = {};
  for (const a of attempts) {
    const key = `${a.letter}|${a.case_type}`;
    (byLetter[key] ??= []).push(a);
  }

  const letters = Object.values(byLetter).map(rows => {
    const first   = rows[0];
    const latest  = rows[rows.length - 1];
    const scores  = rows.map(r => r.best_score).filter(s => s != null);
    const sessions = new Set(rows.map(r => r.session_key)).size;
    const avgScore = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
    const bestScore = scores.length ? Math.max(...scores) : null;

    return {
      letter:       first.letter,
      case_type:    first.case_type,
      attempts:     rows.length,
      sessions,
      first_score:  first.best_score,
      first_at:     first.created_at,
      latest_score: latest.best_score,
      latest_at:    latest.created_at,
      avg_score:    avgScore,
      best_score:   bestScore,
      delta:        (first.best_score != null && latest.best_score != null)
                      ? latest.best_score - first.best_score
                      : null,
    };
  }).sort((a, b) => a.letter.localeCompare(b.letter) || a.case_type.localeCompare(b.case_type));

  // Roll per-letter first/latest scores up into motor-primitive groups
  // (deterministic mapping — see config/letterMotorPrimitives.js, no ML).
  const byPrimitive = {};
  for (const l of letters) {
    const group = LETTER_TO_PRIMITIVE[l.letter];
    if (!group) continue; // every taught letter is mapped; defensive only
    (byPrimitive[group] ??= []).push(l);
  }

  const motorPatterns = Object.keys(PRIMITIVE_LABELS).map(group => {
    const label = PRIMITIVE_LABELS[group];
    const rows  = byPrimitive[group] ?? [];
    const firstScores  = rows.map(r => r.first_score).filter(s => s != null);
    const latestScores = rows.map(r => r.latest_score).filter(s => s != null);

    if (firstScores.length === 0 || latestScores.length === 0) {
      return { group, label, hasData: false, initial: null, current: null, delta: null, message: null };
    }

    const initial = Math.round(firstScores.reduce((s, v) => s + v, 0) / firstScores.length);
    const current  = Math.round(latestScores.reduce((s, v) => s + v, 0) / latestScores.length);
    const delta    = current - initial;
    const trend    = delta > 0 ? 'improving' : delta < 0 ? 'needs attention' : 'steady';

    return {
      group, label, hasData: true, initial, current, delta,
      message: `${label}: started ${initial}%, now ${current}% — ${trend}`,
    };
  });

  res.json({ letters, motorPatterns });
}

/**
 * Maps a StudentMotorBaseline Sequelize row to the public API shape —
 * camelCase, only the fields intended as part of the contract (never the
 * raw Sequelize instance / dataValues). See Feature 1 Step 4.
 */
function serializeMotorBaseline(baseline) {
  return {
    id:                 baseline.id,
    studentId:          baseline.student_id,
    sourceAssessmentId: baseline.source_assessment_id,

    scores: {
      straight: baseline.straight_score,
      curved:   baseline.curved_score,
      complex:  baseline.complex_score,
      overall:  baseline.overall_motor_score,
    },

    baselineVersion: baseline.baseline_version,
    taxonomyVersion: baseline.taxonomy_version,
    sourceType:      baseline.source_type,
    isBackfilled:    baseline.is_backfilled,
    backfilledAt:    baseline.backfilled_at,
    createdAt:       baseline.created_at,
  };
}

/**
 * GET /handwriting/motor-baseline/:studentId
 *
 * Read-only retrieval of the student's immutable Individual Motor-Family
 * Baseline (Feature 1). StudentMotorBaseline is the authoritative store —
 * this endpoint never re-derives values from HandwritingAssessment, never
 * creates or backfills a missing baseline. Creation happens only inside
 * finalizeAssessment() (via createInitialMotorBaseline) or the future
 * controlled backfill utility — not here.
 */
async function getMotorBaseline(req, res) {
  // Strict parse — parseInt('10abc') would incorrectly accept 10; Number(...)
  // followed by Number.isInteger correctly rejects any trailing garbage.
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  // Ownership check — reuses the same existing convention as
  // GET /teacher/students/:id (teacherService.getOwnStudentById), so a
  // teacher can only ever retrieve a baseline for a student assigned to
  // them. Throws ApiError(404) on no-match, same as that route.
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const serviceResult = await getStudentMotorBaseline({ studentId });

  if (serviceResult.status === 'found') {
    return res.json({ status: 'found', baseline: serializeMotorBaseline(serviceResult.baseline) });
  }

  if (serviceResult.status === 'baseline_not_found') {
    return res.status(404).json({ status: 'baseline_not_found', baseline: null });
  }

  // invalid_input is unreachable here (studentId already strictly validated
  // above) but handled defensively rather than assumed unreachable.
  if (serviceResult.status === 'invalid_input') {
    throw new ApiError(422, 'Invalid student ID');
  }

  // read_failed — unexpected DB error, already logged inside the service
  // without exposing SQL/host/stack details. Let the project's normal
  // server-error handler format the response.
  throw new ApiError(500, 'Failed to retrieve motor baseline');
}

/**
 * Maps a Step 5 family decision to the support level a session should START
 * with (Feature 3 Step 6 spec §22). Deliberately a small, explicit lookup —
 * NOT a second copy of Step 5's decision logic. Only these four decisions
 * ever produce a real starting support; every other decision (insufficient_
 * data, insufficient_target, not reached at all) maps to `undefined` here,
 * which the caller below turns into `recommendedSupport: null` — the
 * frontend's signal to fall back to its own legacy default sequence.
 *
 * support_review → 'high': the maximum available software support is what
 * was actually being shown when the evidence was gathered (see Step 5's own
 * rationale for why support_review always carries recommendedSupport:
 * 'high') — Step 6 reuses that same value as the session's starting support,
 * WITHOUT adding any teacher warning or dashboard behavior yet (spec §10).
 * `requiresReview` is still exposed additively on the response for future use.
 */
const SUPPORT_DECISION_TO_STARTING_SUPPORT = {
  recommend_high:   'high',
  recommend_medium: 'medium',
  recommend_low:    'low',
  support_review:   'high',
};

/**
 * GET /handwriting/support-recommendation/:studentId/:letter/:caseType
 *
 * Feature 3 Step 6 — READ-ONLY. Resolves the single baseline family for
 * (letter, caseType) and returns ONLY the minimal recommendation metadata a
 * session needs to choose its starting support level — never raw attempt
 * history, trajectories, or the full evidence arrays Step 4/5 compute
 * internally (spec §6). Performs no writes: evaluateSupportRecommendations()
 * (Step 5) is itself fully read-only, and this handler adds none of its own.
 *
 * Ambiguous/unmapped letters (getBaselineFamily returns null) resolve to
 * decision: 'not_applicable' WITHOUT ever calling evaluateSupportRecommendations
 * — there is no family to evaluate, so nothing is guessed (spec §7).
 *
 * A genuine internal failure (evaluateSupportRecommendations() status !==
 * 'evaluated', i.e. read_failed) is a real 500 — same convention
 * getMotorBaseline already uses for its own read_failed case just above.
 * This is intentional, not a gap in "never break the child's session": the
 * FRONTEND is the layer responsible for treating any failure mode (network
 * error, 404, 500) identically as "fall back to the legacy sequence" (Step 6
 * spec §20/§21) — the backend does not need to disguise its own failure as
 * a fake 200.
 */
async function getSupportRecommendation(req, res) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  const { letter, caseType } = req.params;
  if (typeof letter !== 'string' || letter.length !== 1) {
    throw new ApiError(422, 'Invalid letter');
  }
  if (!['lowercase', 'uppercase'].includes(caseType)) {
    throw new ApiError(422, 'case_type must be lowercase or uppercase');
  }

  // Ownership check — identical convention to getMotorBaseline above: a
  // teacher can only ever request a recommendation for a student assigned
  // to them. Throws ApiError(404) on no-match.
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const family = getBaselineFamily(letter, caseType);
  if (!family) {
    return res.json({
      status: 'resolved',
      studentId, letter, caseType,
      family: null,
      recommendedSupport: null,
      decision: 'not_applicable',
      reason: 'ambiguous_or_unmapped_letter',
      requiresReview: false,
      evidenceBasis: null,
    });
  }

  const evalResult = await evaluateSupportRecommendations({ studentId });
  if (evalResult.status !== 'evaluated') {
    logger.error('Support recommendation evaluation failed', { studentId, letter, caseType, family, status: evalResult.status });
    throw new ApiError(500, 'Failed to evaluate support recommendation');
  }

  const familyResult = evalResult.families[family];
  const recommendedSupport = SUPPORT_DECISION_TO_STARTING_SUPPORT[familyResult.decision] ?? null;

  res.json({
    status: 'resolved',
    studentId, letter, caseType, family,
    recommendedSupport,
    decision: familyResult.decision,
    reason: familyResult.reason,
    requiresReview: familyResult.requiresReview,
    evidenceBasis: familyResult.evidenceBasis,
  });
}

/**
 * GET /handwriting/pre-writing-recommendation/:studentId/:letter/:caseType
 *
 * Feature 4 Step 5 — READ-ONLY. Thin controller wrapper around
 * evaluatePreWritingRecommendation() (Feature 4 Step 4) — no recommendation
 * logic is duplicated here. Same ownership/validation convention as
 * getSupportRecommendation just above.
 *
 * Response is deliberately minimal child-facing metadata only — no raw
 * scores, no trajectory data, no full attempt history (Step 5 spec §6). The
 * service's own output shape already IS this minimal shape (studentId/
 * letter/caseType/family/primitiveGroup/recommended/activityId/reason/
 * signals) — this handler passes it through with no extra fields, exactly
 * as evaluatePreWritingRecommendation() computed it.
 *
 * Performs no writes: evaluatePreWritingRecommendation() is itself fully
 * read-only (Step 4), and this handler adds none of its own — no guard
 * marking, no recommendation persistence, no ShapeFeature/LetterAttempt/
 * ThresholdHistory write (Step 5 spec §28). Only the existing
 * POST /pre-writing-activity endpoint records an actual completed warm-up.
 */
async function getPreWritingRecommendation(req, res) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  const { letter, caseType } = req.params;
  if (typeof letter !== 'string' || letter.length !== 1) {
    throw new ApiError(422, 'Invalid letter');
  }
  if (!['lowercase', 'uppercase'].includes(caseType)) {
    throw new ApiError(422, 'case_type must be lowercase or uppercase');
  }

  // Ownership check — identical convention to getSupportRecommendation/
  // getMotorBaseline above: a teacher can only ever request a recommendation
  // for a student assigned to them. Throws ApiError(404) on no-match.
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const result = await evaluatePreWritingRecommendation({ studentId, letter, caseType });

  if (result.status === 'invalid_input') {
    // Unreachable in practice (studentId/letter/caseType already validated
    // above with identical rules) but handled defensively, never assumed
    // unreachable.
    throw new ApiError(422, 'Invalid recommendation request');
  }

  if (result.status === 'read_failed') {
    logger.error('Pre-writing recommendation evaluation failed', { studentId, letter, caseType, status: result.status });
    throw new ApiError(500, 'Failed to evaluate pre-writing recommendation');
  }

  res.json({
    status: result.status,
    studentId: result.studentId,
    letter: result.letter,
    caseType: result.caseType,
    family: result.family,
    primitiveGroup: result.primitiveGroup,
    recommended: result.recommended,
    activityId: result.activityId,
    reason: result.reason,
    signals: result.signals,
  });
}

/**
 * GET /handwriting/repetition-recommendation/:studentId/:letter/:caseType?adaptiveRepetitionsUsed=N
 *
 * Feature 5 Step 3 — READ-ONLY. Thin controller wrapper around
 * evaluateRepetitionRecommendation() (Feature 5 Step 2) — no recommendation
 * logic is duplicated here. Same ownership/validation convention as
 * getSupportRecommendation/getPreWritingRecommendation above.
 *
 * `adaptiveRepetitionsUsed` is an optional query parameter (defaults to 0,
 * matching the service's own default) — the CALLER (frontend, via
 * utils/repetitionSessionGuard.js) supplies how many automatic spaced
 * repetitions this letter has already received THIS interaction; this
 * endpoint never tracks or reconstructs that count itself (Step 2 spec
 * §16/§17 — the same interactionId-is-frontend-only split Feature 4 already
 * established).
 *
 * Performs no writes: evaluateRepetitionRecommendation() is itself fully
 * read-only, and this handler adds none of its own — no sequence
 * reinsertion, no guard marking, no recommendation persistence.
 */
async function getRepetitionRecommendation(req, res) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  const { letter, caseType } = req.params;
  if (typeof letter !== 'string' || letter.length !== 1) {
    throw new ApiError(422, 'Invalid letter');
  }
  if (!['lowercase', 'uppercase'].includes(caseType)) {
    throw new ApiError(422, 'case_type must be lowercase or uppercase');
  }

  let adaptiveRepetitionsUsed = 0;
  if (req.query.adaptiveRepetitionsUsed !== undefined) {
    const raw = req.query.adaptiveRepetitionsUsed;
    const parsed = Number(raw);
    // raw === '' is checked explicitly: Number('') is 0, not NaN, which
    // would otherwise silently treat "?adaptiveRepetitionsUsed=" (present
    // but empty) as a valid 0 rather than a malformed value.
    if (raw === '' || !Number.isInteger(parsed) || parsed < 0) {
      throw new ApiError(422, 'adaptiveRepetitionsUsed must be a non-negative integer');
    }
    adaptiveRepetitionsUsed = parsed;
  }

  // Ownership check — identical convention to getSupportRecommendation/
  // getPreWritingRecommendation/getMotorBaseline above. Throws
  // ApiError(404) on no-match.
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const result = await evaluateRepetitionRecommendation({ studentId, letter, caseType, adaptiveRepetitionsUsed });

  if (result.status === 'invalid_input') {
    // Unreachable in practice (all inputs already validated above with
    // identical rules) but handled defensively, never assumed unreachable.
    throw new ApiError(422, 'Invalid recommendation request');
  }

  if (result.status === 'read_failed') {
    logger.error('Repetition recommendation evaluation failed', { studentId, letter, caseType, adaptiveRepetitionsUsed, status: result.status });
    throw new ApiError(500, 'Failed to evaluate repetition recommendation');
  }

  res.json({
    status: result.status,
    studentId: result.studentId,
    letter: result.letter,
    caseType: result.caseType,
    family: result.family,
    shouldRepeat: result.shouldRepeat,
    reason: result.reason,
    signals: result.signals,
    policy: result.policy,
    history: result.history,
  });
}

/**
 * GET /handwriting/demo-speed-recommendation/:studentId/:letter/:caseType
 *
 * Feature 6 Step 3 — READ-ONLY. Thin controller wrapper around
 * evaluateDemoSpeedRecommendation() — no recommendation logic is duplicated
 * here. Same ownership/validation convention as getSupportRecommendation/
 * getPreWritingRecommendation/getRepetitionRecommendation above.
 *
 * The response is deliberately categorical only (`standard`/`slow`) — no
 * pixel/timing values, no raw attempts, no raw timing metrics. The
 * frontend (Step 4, not yet built) owns converting a level into an actual
 * px/ms value.
 *
 * Performs no writes: evaluateDemoSpeedRecommendation() is itself fully
 * read-only, and this handler adds none of its own.
 */
async function getDemoSpeedRecommendation(req, res) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  const { letter, caseType } = req.params;
  if (typeof letter !== 'string' || letter.length !== 1) {
    throw new ApiError(422, 'Invalid letter');
  }
  if (!['lowercase', 'uppercase'].includes(caseType)) {
    throw new ApiError(422, 'case_type must be lowercase or uppercase');
  }

  // Ownership check — identical convention to every other recommendation
  // endpoint above. Throws ApiError(404) on no-match.
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const result = await evaluateDemoSpeedRecommendation({ studentId, letter, caseType });

  if (result.status === 'invalid_input') {
    // Unreachable in practice (studentId/letter/caseType already validated
    // above with identical rules) but handled defensively, never assumed
    // unreachable.
    throw new ApiError(422, 'Invalid recommendation request');
  }

  if (result.status === 'read_failed') {
    logger.error('Demo speed recommendation evaluation failed', { studentId, letter, caseType, status: result.status });
    throw new ApiError(500, 'Failed to evaluate demo speed recommendation');
  }

  res.json({
    status: result.status,
    studentId: result.studentId,
    letter: result.letter,
    caseType: result.caseType,
    family: result.family,
    recommendedSpeedLevel: result.recommendedSpeedLevel,
    reason: result.reason,
    signals: result.signals,
  });
}

/**
 * GET /handwriting/persistent-difficulty/:studentId
 *
 * Feature 7 Step 3 — READ-ONLY. Thin controller wrapper around
 * evaluatePersistentDifficulty() — no evidence-reconstruction or decision
 * logic is duplicated here. Student-wide (not narrowed to one letter/case,
 * unlike the recommendation endpoints above) — persistent difficulty is
 * inherently a rollup across all six (caseType, family) streams at once.
 *
 * The response is deliberately categorical/summary only — no raw
 * LetterAttempt rows, no strokes, no normalized-feature JSON, no session
 * keys, no database IDs (Step 3 spec §29). evaluatePersistentDifficulty()
 * is itself fully read-only; this handler adds no writes of its own.
 */
async function getPersistentDifficulty(req, res) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  // Ownership check — identical convention to every other recommendation
  // endpoint above. Throws ApiError(404) on no-match, BEFORE the
  // (potentially larger, student-wide) evaluation ever runs.
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const result = await evaluatePersistentDifficulty({ studentId });

  if (result.status === 'invalid_input') {
    // Unreachable in practice (studentId already validated above with an
    // identical rule) but handled defensively, never assumed unreachable.
    throw new ApiError(422, 'Invalid persistent-difficulty evaluation request');
  }

  if (result.status === 'read_failed') {
    logger.error('Persistent-difficulty evaluation failed', { studentId, status: result.status });
    throw new ApiError(500, 'Failed to evaluate persistent difficulty');
  }

  res.json({
    status: result.status,
    studentId: result.studentId,
    evaluatedAt: result.evaluatedAt,
    streams: result.streams,
    summary: result.summary,
  });
}

module.exports = {
  submitAssessment, submitPreWritingActivity, getProgress, recordLetterCompletion,
  explainAssessment, getLatestExplanation, finalizeAssessment, getInitialReport,
  getLetterProgressReport, getMotorBaseline, getSupportRecommendation,
  getPreWritingRecommendation, getRepetitionRecommendation, getDemoSpeedRecommendation,
  getPersistentDifficulty,
};

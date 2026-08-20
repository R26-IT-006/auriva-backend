'use strict';

// Proposal FR-19, Phase 7C — periodic progress report (READ ONLY). Builds
// one structured report object for an explicit [start_date, end_date]
// window (see utils/reportDateRange.js for the exact UTC/inclusive
// semantics), using bounded aggregate queries — never one query per
// letter/milestone/day (spec §12).
//
// ── READ-ONLY GUARANTEE (spec §4) ────────────────────────────────────────
// This module never calls .create()/.update()/.destroy()/.upsert() on any
// model, never calls letterMotorMasteryService (Feature 11B's own
// mutation path — evidence freeze/milestone persistence happens ONLY
// inside recordLetterCompletion's own success path, never here), never
// calls dynamicThresholdService's write paths, never calls the ML service
// (motorClusterService/mlServiceClient are NOT imported here — Feature
// 11A's report section reads the already-persisted StudentMotorBaseline
// only, it never re-runs a cluster prediction), and never touches
// liveSessionService/collectionController. Every read below is a plain
// Sequelize findAll/findOne against an existing table, or a call into an
// existing READ-ONLY evaluation service (evaluatePersistentDifficulty,
// evaluateWorksheetRecommendations — both already documented elsewhere in
// this codebase as computed-on-demand from existing tables, no
// persistence of their own).
//
// ── TEMPORAL SEMANTICS (spec §7/§8/§9) ───────────────────────────────────
// Every section below is explicitly one of:
//   "during period"   — a real event-timestamp filter (BETWEEN startAt/endAt)
//   "cumulative as of end date" — filtered to <= endAt, never "current/latest"
//   "current status"  — genuinely un-datable (no event history exists for
//                        it), clearly labeled as such, never presented as a
//                        period event.
// See each section's own comment for which of the three applies and why.

const { Op } = require('sequelize');
const {
  Student, Teacher, LetterProgress, LetterAttempt, LetterMotorStateHistory,
  WordWritingAttempt, TeacherRecommendationValidation, StudentMotorBaseline,
} = require('../models');
const { evaluatePersistentDifficulty } = require('./persistentDifficultyService');
const { evaluateWorksheetRecommendations } = require('./worksheetRecommendationService');

// Mirrors the frontend's existing word-unlock gate constants
// (auriva-frontend/src/utils/wordUnlockGate.js) — NOT a new rule, purely
// descriptive labeling for the report's "current progression stage" line.
// Do not treat this as a second, independently-editable copy of the real
// gate: the real gate lives and is enforced entirely on the frontend; this
// constant only feeds a human-readable sentence, never a decision.
const LOWERCASE_MASTERY_TARGET = 26;
const UPPERCASE_MASTERY_TARGET = 26;

function mean(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((s, v) => s + v, 0) / usable.length;
}

function median(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 === 0 ? (usable[mid - 1] + usable[mid]) / 2 : usable[mid];
}

function round(value, decimals = 1) {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ── B. Handwriting learning progress ────────────────────────────────────
// LetterProgress.completed_at is a genuine mastery EVENT timestamp (set
// once, at the moment a letter is mastered — see the model's own comment).
// "During period" and "cumulative as of end date" are therefore both real,
// non-fabricated reconstructions from the SAME single query — never two
// separate table scans.
async function buildLearningProgressSection({ studentId, startAt, endAt }) {
  const rows = await LetterProgress.findAll({
    where: { student_id: studentId, completed_at: { [Op.lte]: endAt } },
    attributes: ['letter', 'case_type', 'completed_at'],
    raw: true,
  });

  const duringPeriod = rows.filter((r) => new Date(r.completed_at).getTime() >= startAt.getTime());
  const countBy = (list, caseType) => list.filter((r) => r.case_type === caseType).length;

  const cumulativeLowercase = countBy(rows, 'lowercase');
  const cumulativeUppercase = countBy(rows, 'uppercase');

  let stage;
  if (cumulativeLowercase < LOWERCASE_MASTERY_TARGET) stage = 'Lowercase Letters';
  else if (cumulativeUppercase < UPPERCASE_MASTERY_TARGET) stage = 'Uppercase Letters';
  else stage = 'Word Writing';

  return {
    lowercase_mastered_during_period: countBy(duringPeriod, 'lowercase'),
    uppercase_mastered_during_period: countBy(duringPeriod, 'uppercase'),
    cumulative_lowercase_mastered_by_end_date: cumulativeLowercase,
    cumulative_uppercase_mastered_by_end_date: cumulativeUppercase,
    current_progression_stage: stage,
  };
}

// ── C. Motor-performance summary — attempts DURING period only ─────────
// One bounded findAll (date-filtered at the DB level), aggregated in JS —
// never a per-letter query. source_type: null / collection_mode: false
// mirrors getLetterProgressReport's own established exclusion rule
// (reassessment + research rows never count toward normal-progression
// reporting).
async function buildMotorPerformanceSection({ studentId, startAt, endAt }) {
  const rows = await LetterAttempt.findAll({
    where: {
      student_id: studentId, collection_mode: false, source_type: null,
      created_at: { [Op.between]: [startAt, endAt] },
    },
    attributes: ['motor_score', 'normalized_features'],
    raw: true,
  });

  const motorScores  = rows.map((r) => r.motor_score);
  const smoothness   = rows.map((r) => r.normalized_features?.smoothness_score);
  const dtwDistance  = rows.map((r) => r.normalized_features?.dtw_distance);
  const speedCv      = rows.map((r) => r.normalized_features?.speed_cv);
  const durationMs   = rows.map((r) => r.normalized_features?.duration_ms);

  return {
    attempts_in_period: rows.length,
    mean_motor_score:   round(mean(motorScores)),
    median_motor_score: round(median(motorScores)),
    mean_smoothness_score: round(mean(smoothness)),
    mean_trajectory_dtw_distance: round(mean(dtwDistance), 3),
    mean_speed_cv:       round(mean(speedCv), 3),
    mean_duration_ms:    mean(durationMs) != null ? Math.round(mean(durationMs)) : null,
  };
}

// ── D. Motor difficulty / adaptive-support summary ──────────────────────
// persistent difficulty + worksheet recommendations are CURRENT STATUS
// (no event-history table exists for either — spec §8 classification B:
// "only current state exists" — clearly labeled, never presented as
// something that "happened during" the period). Teacher validations ARE
// genuine period-filtered event history (created_at is a real event
// timestamp on an append-only table).
async function buildSupportSection({ studentId, startAt, endAt }) {
  const [persistentDifficulty, worksheetRecommendations, validations] = await Promise.all([
    evaluatePersistentDifficulty({ studentId }),
    evaluateWorksheetRecommendations({ studentId }),
    TeacherRecommendationValidation.findAll({
      where: { student_id: studentId, created_at: { [Op.between]: [startAt, endAt] } },
      attributes: ['case_type', 'family', 'recommendation_title', 'validation', 'teacher_note', 'created_at'],
      order: [['created_at', 'ASC']],
      raw: true,
    }),
  ]);

  return {
    persistent_difficulty_current_status: persistentDifficulty.status === 'evaluated'
      ? persistentDifficulty.summary
      : null,
    worksheet_recommendations_current: worksheetRecommendations.status === 'evaluated'
      ? worksheetRecommendations.recommendations.map((r) => ({
          case_type: r.caseType, family: r.family, title: r.title, rationale: r.rationale,
        }))
      : [],
    teacher_validations_during_period: validations.map((v) => ({
      case_type: v.case_type, family: v.family, title: v.recommendation_title,
      decision: v.validation, note: v.teacher_note, at: v.created_at,
    })),
  };
}

// ── E. Feature 11A — Initial Shape Motor Profile (BASELINE CONTEXT ONLY) ─
// Deliberately reads the persisted, immutable StudentMotorBaseline row —
// never re-runs a cluster prediction (no ML service call from this
// module). Explicitly flagged as baseline context that may predate the
// selected period (spec §6E) — never presented as computed "during" it.
async function buildInitialMotorProfileSection({ studentId }) {
  const { getStudentMotorBaseline } = require('./motorBaselineService');
  const result = await getStudentMotorBaseline({ studentId });
  if (result.status !== 'found') {
    return { available: false, note: 'No initial motor baseline is recorded for this student.' };
  }
  const b = result.baseline;
  return {
    available: true,
    is_baseline_context_predating_period: true, // always true — this section is never period-scoped
    recorded_at: b.created_at,
    scores: {
      straight: b.straight_score, curved: b.curved_score, complex: b.complex_score, overall: b.overall_motor_score,
    },
  };
}

// ── F. Feature 11B — Letter Motor Development ────────────────────────────
// LetterMotorStateHistory is an append-only, immutable table with a real
// observed_at event timestamp (spec §9) — exactly the case the spec
// describes as reconstructible. Two reads, both bounded (never one query
// per milestone): milestones whose observed_at falls IN the period, and
// the single latest milestone whose observed_at is <= endAt (never the
// unconditional latest-overall row, which could be AFTER the report's own
// end date). Language is neutral per spec §10 — state_code/display_name
// are reported as-is, never described as "improved"/"declined".
async function buildLetterMotorDevelopmentSection({ studentId, startAt, endAt }) {
  const [duringPeriod, asOfEndRow] = await Promise.all([
    LetterMotorStateHistory.findAll({
      where: { student_id: studentId, observed_at: { [Op.between]: [startAt, endAt] } },
      attributes: ['milestone', 'state_code', 'display_name', 'coverage_n', 'observed_at'],
      order: [['observed_at', 'ASC']],
      raw: true,
    }),
    LetterMotorStateHistory.findOne({
      where: { student_id: studentId, observed_at: { [Op.lte]: endAt } },
      attributes: ['milestone', 'state_code', 'display_name', 'coverage_n', 'observed_at'],
      order: [['observed_at', 'DESC']],
      raw: true,
    }),
  ]);

  return {
    milestones_during_period: duringPeriod.map((m) => ({
      milestone: m.milestone, state_code: m.state_code, display_name: m.display_name,
      coverage: m.coverage_n, observed_at: m.observed_at,
    })),
    state_as_of_end_date: asOfEndRow ? {
      milestone: asOfEndRow.milestone, state_code: asOfEndRow.state_code, display_name: asOfEndRow.display_name,
      coverage: asOfEndRow.coverage_n, observed_at: asOfEndRow.observed_at,
    } : null,
  };
}

// ── G. Word writing ───────────────────────────────────────────────────────
// WordWritingAttempt.created_at is a real event timestamp — attempts and
// distinct-words-attempted are genuine "during period" figures. Per-attempt
// size/spacing advisory (child_feedback) is NOT persisted anywhere in this
// schema (only returned transiently in the POST response — see
// wordWritingService.js) — spec §6G's "if stored" qualifier is honored by
// simply omitting it, never fabricating a summary from data that does not
// exist (spec §8's "do not fabricate historical snapshots").
async function buildWordWritingSection({ studentId, startAt, endAt }) {
  const rows = await WordWritingAttempt.findAll({
    where: { student_id: studentId, collection_mode: false, created_at: { [Op.between]: [startAt, endAt] } },
    attributes: ['word', 'score', 'completion_passed', 'created_at'],
    raw: true,
  });

  const distinctWords = new Set(rows.map((r) => r.word));
  const masteredWords = new Set(rows.filter((r) => r.completion_passed).map((r) => r.word));
  const scores = rows.map((r) => r.score);

  return {
    words_attempted_during_period: distinctWords.size,
    attempts_during_period: rows.length,
    words_completed_during_period: masteredWords.size,
    mean_word_score: round(mean(scores)),
    size_spacing_feedback_note: 'Per-attempt size/spacing feedback is not persisted historically and is not included in this report.',
  };
}

// ── I. Short teacher-friendly summary (neutral language, spec §10) ──────
function buildSummaryText({ hasAnyActivity, learning, wordWriting, letterMotor }) {
  if (!hasAnyActivity) {
    return 'No handwriting activity was recorded during this period.';
  }
  const parts = [];
  const newLetters = learning.lowercase_mastered_during_period + learning.uppercase_mastered_during_period;
  if (newLetters > 0) {
    parts.push(`The student mastered ${newLetters} new letter${newLetters === 1 ? '' : 's'} during this period.`);
  }
  if (wordWriting.words_attempted_during_period > 0) {
    parts.push(`${wordWriting.words_attempted_during_period} word${wordWriting.words_attempted_during_period === 1 ? '' : 's'} were practiced.`);
  }
  if (letterMotor.state_as_of_end_date) {
    parts.push(`Letter Motor State as of the end of this period: ${letterMotor.state_as_of_end_date.display_name}.`);
  }
  if (parts.length === 0) {
    parts.push('Some handwriting activity was recorded, but no letters were newly mastered during this period.');
  }
  return parts.join(' ');
}

/**
 * @param {{studentId: number, teacherId: number, startAt: Date, endAt: Date, startDate: string, endDate: string}} params
 * @returns {Promise<Object>} the full structured periodic report.
 */
async function buildPeriodicReport({ studentId, teacherId, startAt, endAt, startDate, endDate }) {
  const [student, teacher, learning, motorPerformance, support, initialProfile, letterMotor, wordWriting] = await Promise.all([
    Student.findByPk(studentId, { attributes: ['sid', 'full_name', 'student_code'] }),
    Teacher.findByPk(teacherId, { attributes: ['full_name'] }),
    buildLearningProgressSection({ studentId, startAt, endAt }),
    buildMotorPerformanceSection({ studentId, startAt, endAt }),
    buildSupportSection({ studentId, startAt, endAt }),
    buildInitialMotorProfileSection({ studentId }),
    buildLetterMotorDevelopmentSection({ studentId, startAt, endAt }),
    buildWordWritingSection({ studentId, startAt, endAt }),
  ]);

  const hasAnyActivity = motorPerformance.attempts_in_period > 0
    || wordWriting.attempts_during_period > 0
    || learning.lowercase_mastered_during_period > 0
    || learning.uppercase_mastered_during_period > 0;

  return {
    metadata: {
      student_name: student?.full_name ?? null,
      student_code: student?.student_code ?? null,
      teacher_name: teacher?.full_name ?? null,
      period: { start_date: startDate, end_date: endDate },
      generated_at: new Date().toISOString(),
    },
    learning_progress: learning,
    motor_performance: motorPerformance,
    adaptive_support: support,
    initial_shape_motor_profile: initialProfile,
    letter_motor_development: letterMotor,
    word_writing: wordWriting,
    has_activity_in_period: hasAnyActivity,
    summary_text: buildSummaryText({ hasAnyActivity, learning, wordWriting, letterMotor }),
  };
}

module.exports = { buildPeriodicReport };

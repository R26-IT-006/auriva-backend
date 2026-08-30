'use strict';

/**
 * worksheetService.js
 *
 * Turns an APPROVED adaptive practice recommendation into a personalised
 * homework worksheet, then accepts the completed paper back for teacher review.
 *
 * ── Where this sits in the flow ────────────────────────────────────────────
 *   normal practice -> persistent-difficulty evaluation -> recommendation
 *   -> teacher reviews -> TEACHER APPROVES -> worksheet generated
 *   -> printed, done at home on paper -> photographed -> teacher reviews
 *
 * A worksheet is never produced because a child failed one attempt. It can only
 * be built from a stream Feature 7 already called PERSISTENT, which requires
 * two complete, 24-hour-separated evidence windows. None of those rules are
 * read or re-derived here — this module composes the existing evaluation, it
 * never re-implements it.
 *
 * ── Hard isolation ─────────────────────────────────────────────────────────
 * Nothing in this file writes LetterProgress, mastered_at, blocked_attempts,
 * a threshold, a Motor Score, an adaptive decision, a Letter Motor Pattern, or
 * word unlock. Assigning homework and reviewing a returned page are teacher
 * actions about paper practice, not progression events. See
 * tests/worksheetIsolation.test.js for the enumerated proof.
 *
 * ── No automatic scoring of returned work ──────────────────────────────────
 * A submitted photo is stored and shown to the teacher. It is NOT analysed,
 * scored, graded or compared to a template anywhere in this system.
 */

const { Op } = require('sequelize');
const { HandwritingWorksheet, HandwritingWorksheetSubmission } = require('../models');
const { evaluateWorksheetRecommendations } = require('./worksheetRecommendationService');
const { getWorksheetMotorPlan, isValidIntensity } = require('../config/worksheetMotorMap');
const { PERSISTENT_DIFFICULTY_STATUSES } = require('../config/persistentDifficultyPolicy');
const logger = require('../utils/logger');
const letterCycleService = require('./letterCycleService');

// A worksheet occupying a child's desk right now. Only one of these may exist
// per (student, letter, case) — enforced by a partial unique index too.
const LIVE_STATUSES = Object.freeze(['generated', 'assigned', 'submitted']);

// Which mechanism produced a candidate. Kept explicit so the teacher UI can
// present the exact-letter recommendation and the broader family-level one
// differently, and so neither is ever mistaken for the other.
const CANDIDATE_SOURCE = Object.freeze({
  // Emitted by every NEW exact-letter candidate. The cap became three cycles
  // when mastery moved to attempt-3-only (see config/masteryPolicy.js), so
  // the old name would have been actively wrong about what happened.
  THREE_CYCLE_FAILURE: 'three_cycle_failure',
  // DEPRECATED for writing, PERMANENT for reading. Worksheet rows created
  // before the three-cycle policy carry this exact string in the database and
  // in already-issued teacher recommendations. It is never emitted again, and
  // never removed — a rename without this alias would orphan those rows in
  // the teacher UI.
  TWO_CYCLE_FAILURE: 'two_cycle_failure',
  PERSISTENT_DIFFICULTY: 'persistent_difficulty',
});

// Every source string that means "this one letter needs home practice",
// historical included. Read paths must use this, never an === against a
// single value.
const EXACT_LETTER_CANDIDATE_SOURCES = Object.freeze([
  CANDIDATE_SOURCE.THREE_CYCLE_FAILURE,
  CANDIDATE_SOURCE.TWO_CYCLE_FAILURE,
]);

function isExactLetterCandidateSource(source) {
  return EXACT_LETTER_CANDIDATE_SOURCES.includes(source);
}

// Identifies the STRUCTURE of a stored plan, so a future reader knows which
// worksheet-generation shape produced a historical artefact. Deliberately a
// single string and nothing more — no migration machinery, no per-version
// renderers. Bump it only when the stored plan's own shape changes.
const WORKSHEET_PLAN_VERSION = 'worksheet-plan-v1';

/**
 * Freezes everything needed to re-render this exact worksheet later.
 *
 * Structured, not rendered HTML: the plan is small and readable, and freezing
 * markup would also freeze the layout, which we DO want to be able to improve.
 * Every value is copied from the plan the generator actually used — nothing is
 * recomputed here.
 */
function freezePlan({ plan, letter, caseType, family, intensity }) {
  return {
    worksheet_plan_version: WORKSHEET_PLAN_VERSION,
    target_letter: letter,
    case_type: caseType,
    motor_family: family ?? null,
    worksheet_intensity: intensity,
    // Prerequisite strokes, in the letter's own order.
    stroke_types: [...(plan.strokeTypes ?? [])],
    // Warm-up rows exactly as generated, including the family emphasis that
    // was in force at the time.
    warm_up: (plan.warmUp ?? []).map((w) => ({
      id: w.id, label: w.label, instruction: w.instruction,
      rows: w.rows, emphasised: w.emphasised,
    })),
    primary_shape: plan.primaryShape
      ? { id: plan.primaryShape.id, label: plan.primaryShape.label, instruction: plan.primaryShape.instruction }
      : null,
    shape_practice_sizes: [...(plan.shapePracticeSizes ?? [])],
    // Section settings the renderer reads. Frozen so a later layout change
    // cannot silently alter a historical sheet's content.
    trace: { rows: 2, per_row: 5, dotted: true, show_start: true },
    copy: { rows: 2, blanks_per_row: 4 },
    independent: { rows: intensity === 'extended' ? 3 : 2 },
  };
}

const WORKSHEET_STATUS = Object.freeze({
  GENERATED: 'generated', ASSIGNED: 'assigned', SUBMITTED: 'submitted',
  REVIEWED: 'reviewed', ARCHIVED: 'archived',
});

// Deliberately no 'failed'. A returned worksheet is practice evidence a teacher
// reads, not something a child passes.
const REVIEW_STATUS = Object.freeze({
  PENDING: 'pending_review', REVIEWED: 'reviewed', NEEDS_MORE_PRACTICE: 'needs_more_practice',
});
const VALID_REVIEW_STATUSES = Object.freeze(Object.values(REVIEW_STATUS));

function isPositiveInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Trimmed, length-capped teacher note, or null. Never stores whitespace. */
function normalizeNote(note, max = 2000) {
  if (typeof note !== 'string') return null;
  const t = note.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

/**
 * Suggests the letter(s) a worksheet should target for a persistent stream.
 *
 * DETERMINISTIC, from evidence the system already records — there is no new
 * ranking model here. `affectedLetters` comes straight from Feature 7's own
 * summarizeAffectedLetters(), which counts, for the exact 10 cycles in the two
 * evaluated windows, how many each letter failed. It is already ordered
 * failedCycles desc, then totalCycles desc, then alphabetically.
 *
 * A letter qualifies only if it actually failed at least once in those windows;
 * a letter present but never failed is not a difficulty and is never suggested.
 *
 * The FIRST entry is the suggestion. Every qualifying letter is returned so the
 * teacher can pick a different one — the teacher's choice always wins.
 */
function deriveTargetLetters(stream) {
  const affected = Array.isArray(stream?.affectedLetters) ? stream.affectedLetters : [];
  return affected
    .filter(e => e && typeof e.letter === 'string' && e.letter.length === 1)
    .filter(e => Number.isInteger(e.failedCycles) && e.failedCycles > 0)
    .map(e => ({
      letter: e.letter,
      failedCycles: e.failedCycles,
      totalCycles: e.totalCycles,
    }));
}

/**
 * Every persistent stream for a student, each with its deterministic target
 * suggestion and whether a live worksheet already exists for it.
 *
 * Read-only. Composes evaluateWorksheetRecommendations() exactly once.
 */
/**
 * The exact-letter home-practice candidates: letters that used ALL THREE of
 * a practice date's cycles and failed every one, and are still unmastered.
 *
 * "Failed" now means the CYCLE's attempt-3 comparison failed — a guided
 * attempt scoring well never counted and never counts. The three-cycle
 * requirement is not hardcoded here: it reads
 * MAX_CYCLES_PER_LETTER_PER_DATE via letterCycleService, so the cap and the
 * homework trigger can never drift apart.
 *
 * A SECOND, independent source alongside the persistent-difficulty
 * recommendation. The two answer different questions and are deliberately not
 * merged:
 *
 *   three_cycle_failure     "this letter needs help now"     one letter, one day
 *   persistent_difficulty   "this movement family is hard"   10 cycles, 2 windows
 *
 * The 10-cycle mechanism (evaluateWorksheetRecommendations, WINDOW_SIZE,
 * MIN_USABLE_CYCLES, the 24-hour separation) is untouched and still drives the
 * Adaptive Practice Recommendation.
 */
async function getTwoCycleCandidates({ studentId, liveKey }) {
  const result = await letterCycleService.getTwoCycleFailureLetters({ studentId });
  if (result.status !== 'ok') return [];

  return result.letters.map((entry) => ({
    source: CANDIDATE_SOURCE.THREE_CYCLE_FAILURE,
    // No fingerprint: this candidate is identified by the letter itself, not
    // by a longitudinal evidence window.
    recommendationFingerprint: null,
    caseType: entry.caseType,
    family: null,
    title: 'Additional Home Practice',
    // Teacher-facing, and deliberately says nothing about cycle counts,
    // thresholds or scores.
    rationale: 'More practice is recommended for this letter.',
    candidateLetters: [{ letter: entry.letter, failedCycles: entry.cycles, totalCycles: entry.cycles }],
    suggestedLetter: entry.letter,
    practiceDate: result.date,
    alreadyAssigned: liveKey.has(`${entry.letter}|${entry.caseType}`),
  }));
}

async function getWorksheetCandidates({ studentId }) {
  if (!isPositiveInteger(studentId)) return { status: 'invalid_input', candidates: [] };

  let evaluation;
  try {
    evaluation = await evaluateWorksheetRecommendations({ studentId });
  } catch (err) {
    logger.error('Worksheet candidate evaluation threw', { studentId, errorMessage: err.message });
    return { status: 'read_failed', candidates: [] };
  }
  if (evaluation.status !== 'evaluated') {
    return { status: evaluation.status, candidates: [] };
  }

  let live = [];
  try {
    live = await HandwritingWorksheet.findAll({
      where: { student_id: studentId, status: { [Op.in]: LIVE_STATUSES } },
      raw: true,
    });
  } catch (err) {
    logger.error('Live worksheet read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', candidates: [] };
  }
  const liveKey = new Set(live.map(w => `${w.target_letter}|${w.case_type}`));

  const persistent = (evaluation.recommendations ?? []).map((rec) => {
    const targets = deriveTargetLetters(rec);
    const suggested = targets[0] ?? null;
    return {
      source: CANDIDATE_SOURCE.PERSISTENT_DIFFICULTY,
      recommendationFingerprint: rec.recommendationFingerprint ?? null,
      caseType: rec.caseType,
      family: rec.family,
      title: rec.title,
      rationale: rec.rationale,
      // The teacher picks from these; the first is the system's suggestion.
      candidateLetters: targets,
      suggestedLetter: suggested ? suggested.letter : null,
      // Never generate a second worksheet for a letter already assigned.
      alreadyAssigned: suggested ? liveKey.has(`${suggested.letter}|${rec.caseType}`) : false,
    };
  });

  const twoCycle = await getTwoCycleCandidates({ studentId, liveKey });

  // Exact-letter candidates come first, and a letter covered by one is
  // dropped from the persistent-difficulty list so the teacher never sees two
  // home-practice cards for the same letter. The persistent recommendation
  // itself is unchanged - only its duplicate SUGGESTION is suppressed here.
  const twoCycleKey = new Set(twoCycle.map(c => `${c.suggestedLetter}|${c.caseType}`));
  const candidates = [
    ...twoCycle,
    ...persistent.filter(c => !twoCycleKey.has(`${c.suggestedLetter}|${c.caseType}`)),
  ];

  return { status: 'evaluated', candidates, liveWorksheets: live };
}

/** HW-YYYY-NNNN — printed on the sheet so a returned paper can be matched. */
async function nextWorksheetCode() {
  const year = new Date().getUTCFullYear();
  const prefix = `HW-${year}-`;
  const last = await HandwritingWorksheet.findOne({
    where: { worksheet_code: { [Op.like]: `${prefix}%` } },
    order: [['worksheet_code', 'DESC']],
    attributes: ['worksheet_code'],
    raw: true,
  });
  const n = last ? (parseInt(last.worksheet_code.slice(prefix.length), 10) || 0) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/**
 * Creates a worksheet for a TEACHER-APPROVED target.
 *
 * The teacher's `targetLetter` is authoritative — they may override the
 * system's suggestion entirely. What the system still enforces is that the
 * letter is one it can actually prepare motor work for (a mapped letter, in the
 * requested case), and that no live worksheet already exists for it.
 *
 * @returns statuses: created, already_assigned, unmapped_letter, invalid_input,
 *   save_failed
 */
async function generateWorksheet({
  studentId, targetLetter, caseType, family = null,
  intensity = 'standard', teacherNote = null, recommendationFingerprint = null,
  dueDate = null,
}) {
  if (!isPositiveInteger(studentId)) return { status: 'invalid_input', worksheet: null };

  const safeIntensity = isValidIntensity(intensity) ? intensity : 'standard';

  // The letter must be one this system can build preparation for. An unmapped
  // letter is reported for manual teacher configuration, never guessed at.
  const plan = getWorksheetMotorPlan({ letter: targetLetter, caseType, family, intensity: safeIntensity });
  if (plan.status === 'invalid_input') return { status: 'invalid_input', worksheet: null };
  if (plan.status === 'unmapped') return { status: 'unmapped_letter', worksheet: null, letter: targetLetter };

  try {
    // Duplicate control (application-level; the partial unique index is the
    // final authority on a concurrent double-tap).
    const existing = await HandwritingWorksheet.findOne({
      where: {
        student_id: studentId, target_letter: targetLetter, case_type: caseType,
        status: { [Op.in]: LIVE_STATUSES },
      },
    });
    if (existing) return { status: 'already_assigned', worksheet: existing, plan };

    const now = new Date();
    const worksheet = await HandwritingWorksheet.create({
      student_id: studentId,
      worksheet_code: await nextWorksheetCode(),
      recommendation_fingerprint: recommendationFingerprint,
      case_type: caseType,
      motor_family: family,
      target_letter: targetLetter,
      worksheet_intensity: safeIntensity,
      status: WORKSHEET_STATUS.GENERATED,
      teacher_note: normalizeNote(teacherNote),
      // Frozen at generation — a reprint reads THIS, never the live mapping.
      worksheet_plan: freezePlan({ plan, letter: targetLetter, caseType, family, intensity: safeIntensity }),
      generated_at: now,
      due_date: dueDate ? new Date(dueDate) : null,
    });

    logger.info('Homework worksheet generated', {
      studentId, worksheetCode: worksheet.worksheet_code,
      targetLetter, caseType, intensity: safeIntensity,
    });
    return { status: 'created', worksheet, plan };
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      const raced = await HandwritingWorksheet.findOne({
        where: {
          student_id: studentId, target_letter: targetLetter, case_type: caseType,
          status: { [Op.in]: LIVE_STATUSES },
        },
      }).catch(() => null);
      if (raced) return { status: 'already_assigned', worksheet: raced, plan };
    }
    logger.error('Worksheet generation failed', { studentId, errorMessage: err.message });
    return { status: 'save_failed', worksheet: null };
  }
}

/** Marks a generated worksheet as handed out. Never a progression event. */
async function assignWorksheet({ worksheetId, fileUrl = null }) {
  if (!isPositiveInteger(worksheetId)) return { status: 'invalid_input', worksheet: null };
  try {
    const worksheet = await HandwritingWorksheet.findByPk(worksheetId);
    if (!worksheet) return { status: 'not_found', worksheet: null };
    await worksheet.update({
      status: WORKSHEET_STATUS.ASSIGNED,
      assigned_at: worksheet.assigned_at ?? new Date(),
      worksheet_file_url: fileUrl ?? worksheet.worksheet_file_url,
      updated_at: new Date(),
    });
    return { status: 'assigned', worksheet };
  } catch (err) {
    logger.error('Worksheet assign failed', { worksheetId, errorMessage: err.message });
    return { status: 'save_failed', worksheet: null };
  }
}

/**
 * Records a returned worksheet (a photo or scan of the completed paper).
 *
 * The image is STORED and shown to the teacher. It is not analysed, scored or
 * graded — no automatic handwriting recognition exists here.
 *
 * A submission for a worksheet belonging to a different student is rejected,
 * so a returned page can never be filed against the wrong child.
 */
async function submitWorksheet({ worksheetId, studentId, fileReference, submissionType = 'photo' }) {
  if (!isPositiveInteger(worksheetId) || !isPositiveInteger(studentId) || !fileReference) {
    return { status: 'invalid_input', submission: null };
  }
  try {
    const worksheet = await HandwritingWorksheet.findByPk(worksheetId);
    if (!worksheet) return { status: 'not_found', submission: null };
    if (worksheet.student_id !== studentId) {
      logger.warn('Worksheet submission rejected — student mismatch', { worksheetId, studentId });
      return { status: 'student_mismatch', submission: null };
    }

    const now = new Date();
    const submission = await HandwritingWorksheetSubmission.create({
      worksheet_id: worksheetId,
      student_id: studentId,
      submitted_at: now,
      file_reference: fileReference,
      submission_type: submissionType === 'scan' ? 'scan' : 'photo',
      review_status: REVIEW_STATUS.PENDING,
    });
    // The worksheet moves to 'submitted'; it is NOT marked complete, and no
    // letter is marked mastered.
    await worksheet.update({
      status: WORKSHEET_STATUS.SUBMITTED, completed_at: now, updated_at: now,
    });

    logger.info('Homework worksheet submitted', {
      worksheetId, studentId, submissionType: submission.submission_type,
    });
    return { status: 'submitted', submission, worksheet };
  } catch (err) {
    logger.error('Worksheet submission failed', { worksheetId, errorMessage: err.message });
    return { status: 'save_failed', submission: null };
  }
}

/**
 * Records the TEACHER's own review of a returned worksheet.
 *
 * This is a note about paper practice. It does not mark the letter mastered,
 * change any score, threshold or adaptive decision, or unlock anything.
 */
async function reviewSubmission({ submissionId, reviewStatus, teacherComment = null }) {
  if (!isPositiveInteger(submissionId)) return { status: 'invalid_input', submission: null };
  if (!VALID_REVIEW_STATUSES.includes(reviewStatus) || reviewStatus === REVIEW_STATUS.PENDING) {
    return { status: 'invalid_input', submission: null };
  }
  try {
    const submission = await HandwritingWorksheetSubmission.findByPk(submissionId);
    if (!submission) return { status: 'not_found', submission: null };

    const now = new Date();
    await submission.update({
      review_status: reviewStatus,
      teacher_comment: normalizeNote(teacherComment),
      reviewed_at: now,
      updated_at: now,
    });

    // The worksheet leaves the live set once reviewed, so the next
    // recommendation for this letter can produce a fresh worksheet.
    const worksheet = await HandwritingWorksheet.findByPk(submission.worksheet_id);
    if (worksheet) {
      await worksheet.update({ status: WORKSHEET_STATUS.REVIEWED, updated_at: now });
    }
    return { status: 'reviewed', submission, worksheet };
  } catch (err) {
    logger.error('Worksheet review failed', { submissionId, errorMessage: err.message });
    return { status: 'save_failed', submission: null };
  }
}

/** Teacher-facing worksheet history, newest first, with submissions attached. */
async function getWorksheetHistory({ studentId }) {
  if (!isPositiveInteger(studentId)) return { status: 'invalid_input', worksheets: [] };
  try {
    const worksheets = await HandwritingWorksheet.findAll({
      where: { student_id: studentId },
      order: [['generated_at', 'DESC'], ['id', 'DESC']],
      raw: true,
    });
    if (worksheets.length === 0) return { status: 'found', worksheets: [], active: null };

    const submissions = await HandwritingWorksheetSubmission.findAll({
      where: { worksheet_id: { [Op.in]: worksheets.map(w => w.id) } },
      order: [['submitted_at', 'DESC'], ['id', 'DESC']],
      raw: true,
    });
    const byWorksheet = new Map();
    for (const s of submissions) {
      if (!byWorksheet.has(s.worksheet_id)) byWorksheet.set(s.worksheet_id, []);
      byWorksheet.get(s.worksheet_id).push(s);
    }

    const enriched = worksheets.map(w => ({ ...w, submissions: byWorksheet.get(w.id) ?? [] }));
    const active = enriched.find(w => LIVE_STATUSES.includes(w.status)) ?? null;
    return { status: 'found', worksheets: enriched, active };
  } catch (err) {
    logger.error('Worksheet history read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', worksheets: [] };
  }
}

module.exports = {
  EXACT_LETTER_CANDIDATE_SOURCES,
  isExactLetterCandidateSource,
  LIVE_STATUSES, WORKSHEET_STATUS, REVIEW_STATUS, VALID_REVIEW_STATUSES,
  CANDIDATE_SOURCE,
  WORKSHEET_PLAN_VERSION, freezePlan,
  deriveTargetLetters,
  getWorksheetCandidates,
  generateWorksheet,
  assignWorksheet,
  submitWorksheet,
  reviewSubmission,
  getWorksheetHistory,
};

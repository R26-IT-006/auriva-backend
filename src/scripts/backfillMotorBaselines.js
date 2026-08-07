'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * backfillMotorBaselines.js
 *
 * Feature 1: Individual Motor-Family Baseline — controlled historical
 * backfill for students who completed their initial six-shape assessment
 * before the baseline table existed.
 *
 * DRY RUN BY DEFAULT. Only `--apply` performs real writes.
 *
 *   node src/scripts/backfillMotorBaselines.js                  # dry run, all students
 *   node src/scripts/backfillMotorBaselines.js --student-id=10  # dry run, one student
 *   node src/scripts/backfillMotorBaselines.js --limit=5        # dry run, first 5 students
 *   node src/scripts/backfillMotorBaselines.js --apply --student-id=10   # real write, one student
 *   node src/scripts/backfillMotorBaselines.js --apply                  # real write, all students
 *
 * Never calls assessment.update(...) — read-only with respect to
 * HandwritingAssessment. Never touches LetterAttempt, LetterProgress,
 * ShapeFeature, StudentMotorFeature, ExplanationResult,
 * RecommendationHistory, CollectionSession, TeacherValidation, or
 * students.personal_thresholds. The only write this script can ever make is
 * a StudentMotorBaseline row, and only via the exact same
 * createInitialMotorBaseline() used by finalizeAssessment() — creation
 * logic is never duplicated here.
 *
 * Students are processed sequentially (not Promise.all) — one problematic
 * student must never abort or roll back another student's successful
 * baseline, and sequential logs stay easy to audit.
 */

const fs   = require('fs');
const path = require('path');

const { Student, HandwritingAssessment, StudentMotorBaseline } = require('../models');
const { createInitialMotorBaseline, validateMotorProfileForBaseline } = require('../services/motorBaselineService');
const logger = require('../utils/logger');

const BASELINE_VERSION    = 'baseline-v1';
const TAXONOMY_VERSION    = 'assessment-motor-v1';
const SOURCE_TYPE_INITIAL = 'initial_assessment';

// Internal-only marker — never appears in a printed or reported result.
// evaluateCandidate() returns this to tell processStudent() "nothing to
// skip, proceed to WOULD_CREATE (dry run) or the real service call (apply)".
const CANDIDATE_ELIGIBLE = '_CANDIDATE_ELIGIBLE';

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { apply: false, studentId: null, limit: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      flags.apply = true;
    } else if (arg.startsWith('--student-id=')) {
      const raw = arg.slice('--student-id='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --student-id value: "${raw}" (must be a positive integer)`);
      }
      flags.studentId = n;
    } else if (arg.startsWith('--limit=')) {
      const raw = arg.slice('--limit='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --limit value: "${raw}" (must be a positive integer)`);
      }
      flags.limit = n;
    }
    // Unknown flags are ignored rather than rejected — keeps the CLI simple,
    // per the "do not create a complex CLI framework" instruction.
  }
  return flags;
}

// ─── Status classification ──────────────────────────────────────────────────

// invalid_motor_profile reasons from validateMotorProfileForBaseline() map
// to one of two backfill-report statuses. "invalid_overall_motor_score" is a
// single reason code covering both "missing" and "out-of-range" overall
// score (see motorBaselineService.js) — classified as SKIPPED_INVALID_SCORE
// here since a present-but-malformed value is the more actionable/reportable
// case; in practice motor_score and motor_profile are always set together by
// finalizeAssessment (verified against live data in Step 2), so a genuinely
// missing overall score almost always coincides with motor_profile_missing,
// which is already classified as SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT above.
function classifyValidationReason(reason) {
  if (reason === 'motor_profile_missing') return 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT';
  if (typeof reason === 'string' && reason.startsWith('missing_')) return 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT';
  if (typeof reason === 'string' && reason.endsWith('_out_of_range')) return 'SKIPPED_INVALID_SCORE';
  if (reason === 'invalid_overall_motor_score') return 'SKIPPED_INVALID_SCORE';
  return 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT'; // safe default, should be unreachable
}

// ─── Per-student read-only evaluation ───────────────────────────────────────

/**
 * Read-only: determines what backfill status a student resolves to, without
 * ever writing. Used directly for dry-run reporting, and as the first half
 * of apply-mode processing (to find the candidate assessment id and to
 * short-circuit the cases where there is nothing to write, without invoking
 * the mutating service unnecessarily).
 */
async function evaluateCandidate(studentId) {
  // Student-level guard first — mirrors createInitialMotorBaseline's own
  // ordering and its exact rationale (protects against historical
  // is_initial inconsistencies producing two "initial" baselines).
  const existingForStudent = await StudentMotorBaseline.findOne({
    where: { student_id: studentId, source_type: SOURCE_TYPE_INITIAL },
  });
  if (existingForStudent) {
    return {
      studentId, assessmentId: null,
      status: 'SKIPPED_BASELINE_ALREADY_EXISTS', reason: null,
      baselineId: existingForStudent.id,
    };
  }

  // Earliest non-collection assessment — same convention as
  // createInitialMotorBaseline / getInitialReport. Does NOT trust
  // is_initial. id is a deterministic tiebreaker for equal created_at.
  const earliestAssessment = await HandwritingAssessment.findOne({
    where: { student_id: studentId, collection_mode: false },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });
  if (!earliestAssessment) {
    return { studentId, assessmentId: null, status: 'SKIPPED_NO_ASSESSMENT', reason: null };
  }

  const existingBySource = await StudentMotorBaseline.findOne({
    where: { source_assessment_id: earliestAssessment.id },
  });
  if (existingBySource) {
    return {
      studentId, assessmentId: earliestAssessment.id, assessmentCreatedAt: earliestAssessment.created_at,
      status: 'SKIPPED_SOURCE_ALREADY_BACKFILLED', reason: null,
      baselineId: existingBySource.id,
    };
  }

  // Same shared validator the production service uses — the earliest
  // non-collection assessment is the ONLY candidate considered; an
  // incomplete earliest assessment is reported and skipped, never silently
  // replaced by a later reassessment.
  const validation = validateMotorProfileForBaseline(earliestAssessment.motor_profile, earliestAssessment.motor_score);
  if (!validation.valid) {
    return {
      studentId, assessmentId: earliestAssessment.id, assessmentCreatedAt: earliestAssessment.created_at,
      status: classifyValidationReason(validation.reason), reason: validation.reason,
    };
  }

  return {
    studentId, assessmentId: earliestAssessment.id, assessmentCreatedAt: earliestAssessment.created_at,
    status: CANDIDATE_ELIGIBLE,
    scores: {
      straight: validation.scores.straightScore,
      curved:   validation.scores.curvedScore,
      complex:  validation.scores.complexScore,
      overall:  validation.scores.overallMotorScore,
    },
  };
}

// Maps createInitialMotorBaseline's own result (the single source of truth
// for what actually happened) onto the backfill report vocabulary. Nothing
// from the service is ever silently swallowed — unrecognized/unexpected
// service statuses fall through to FAILED rather than being hidden.
function mapServiceResultToReport(evalResult, serviceResult) {
  const base = {
    studentId:           evalResult.studentId,
    assessmentId:         evalResult.assessmentId,
    assessmentCreatedAt: evalResult.assessmentCreatedAt,
  };
  switch (serviceResult.status) {
    case 'created':
      return { ...base, status: 'CREATED', baselineId: serviceResult.baseline?.id ?? null, scores: evalResult.scores };
    case 'already_exists':
      return { ...base, status: 'SKIPPED_SOURCE_ALREADY_BACKFILLED', baselineId: serviceResult.baseline?.id ?? null };
    case 'student_baseline_already_exists':
      return { ...base, status: 'SKIPPED_BASELINE_ALREADY_EXISTS', baselineId: serviceResult.baseline?.id ?? null };
    case 'invalid_motor_profile':
      return { ...base, status: classifyValidationReason(serviceResult.reason), reason: serviceResult.reason };
    // Defensive-only — evaluateCandidate() already selects the same earliest
    // non-collection assessment the service itself would pick, so these two
    // should never actually occur. Surfaced faithfully rather than hidden,
    // per the "do not hide unexpected service results" instruction. Two
    // extra statuses beyond the requested vocabulary, documented here.
    case 'not_initial_assessment':
      return { ...base, status: 'SKIPPED_NOT_INITIAL_ASSESSMENT', reason: 'not_initial_assessment' };
    case 'collection_assessment_not_eligible':
      return { ...base, status: 'SKIPPED_COLLECTION_ASSESSMENT', reason: 'collection_assessment_not_eligible' };
    case 'source_assessment_not_found':
    case 'student_mismatch':
    case 'invalid_input':
    case 'save_failed':
    default:
      return { ...base, status: 'FAILED', reason: serviceResult.status };
  }
}

/**
 * Processes one student: dry-run reports WOULD_CREATE/SKIPPED_*, apply mode
 * calls the real production service for the actual write. Never throws —
 * always returns a structured result, so one student's failure can never
 * abort the loop.
 */
async function processStudent(studentId, { apply }) {
  let evalResult;
  try {
    evalResult = await evaluateCandidate(studentId);
  } catch (err) {
    logger.error('Motor baseline backfill: evaluation failed', { studentId, status: 'FAILED', errorMessage: err.message });
    return { studentId, assessmentId: null, status: 'FAILED', reason: 'evaluation_failed' };
  }

  if (evalResult.status !== CANDIDATE_ELIGIBLE) {
    return evalResult;
  }

  if (!apply) {
    const { status, ...rest } = evalResult; // eslint-disable-line no-unused-vars
    return { ...rest, status: 'WOULD_CREATE' };
  }

  try {
    const serviceResult = await createInitialMotorBaseline({
      studentId,
      assessmentId:  evalResult.assessmentId,
      isBackfilled:  true,
    });
    return mapServiceResultToReport(evalResult, serviceResult);
  } catch (err) {
    // createInitialMotorBaseline has its own outer try/catch and should
    // never throw — this is defense-in-depth only.
    logger.error('Motor baseline backfill: unexpected service failure', { studentId, assessmentId: evalResult.assessmentId, status: 'FAILED', errorMessage: err.message });
    return { studentId, assessmentId: evalResult.assessmentId, assessmentCreatedAt: evalResult.assessmentCreatedAt, status: 'FAILED', reason: 'unexpected_error' };
  }
}

// ─── Summary / reporting ─────────────────────────────────────────────────────

function buildSummary(results) {
  const counts = {
    studentsScanned:              results.length,
    wouldCreate:                  0,
    created:                      0,
    alreadyHadBaseline:           0,
    noAssessment:                 0,
    incompleteInitialAssessment:  0,
    invalidScore:                 0,
    otherSkipped:                 0,
    failed:                       0,
  };
  for (const r of results) {
    switch (r.status) {
      case 'WOULD_CREATE':                        counts.wouldCreate++; break;
      case 'CREATED':                             counts.created++; break;
      case 'SKIPPED_BASELINE_ALREADY_EXISTS':
      case 'SKIPPED_SOURCE_ALREADY_BACKFILLED':   counts.alreadyHadBaseline++; break;
      case 'SKIPPED_NO_ASSESSMENT':                counts.noAssessment++; break;
      case 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT':counts.incompleteInitialAssessment++; break;
      case 'SKIPPED_INVALID_SCORE':                counts.invalidScore++; break;
      case 'FAILED':                               counts.failed++; break;
      default:                                     counts.otherSkipped++; break;
    }
  }
  return counts;
}

function printSummary(counts, applyMode) {
  console.log('\nMotor Baseline Backfill Summary\n');
  console.log(`Mode: ${applyMode ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`Students scanned: ${counts.studentsScanned}`);
  if (applyMode) {
    console.log(`Created: ${counts.created}`);
    console.log(`Already existed: ${counts.alreadyHadBaseline}`);
    const skipped = counts.noAssessment + counts.incompleteInitialAssessment + counts.invalidScore + counts.otherSkipped;
    console.log(`Skipped: ${skipped}`);
    console.log(`Failed: ${counts.failed}`);
  } else {
    console.log(`Would create: ${counts.wouldCreate}`);
    console.log(`Already had baseline: ${counts.alreadyHadBaseline}`);
    console.log(`No assessment: ${counts.noAssessment}`);
    console.log(`Incomplete initial assessment: ${counts.incompleteInitialAssessment}`);
    console.log(`Invalid score: ${counts.invalidScore}`);
    if (counts.otherSkipped > 0) console.log(`Other skipped: ${counts.otherSkipped}`);
    console.log(`Failed: ${counts.failed}`);
  }
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Written under logs/ — already gitignored by .gitignore, no repo config
// change needed. Contains IDs/scores/timestamps/statuses only — see the
// `results` shape produced above: no student/teacher names, no raw
// trajectories, no full motor_profile JSON, no auth data.
function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `motor-baseline-backfill-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function runBackfill(flags) {
  const startedAt = new Date();

  console.log(`MODE: ${flags.apply ? 'APPLY' : 'DRY RUN'}`);
  if (flags.apply) {
    console.log('Eligible baselines WILL be created.');
    console.log('Existing assessments will not be modified.');
  } else {
    console.log('No database writes will be performed.');
  }

  const where = flags.studentId != null ? { sid: flags.studentId } : undefined;
  let students;
  try {
    // Only sid is selected — full_name/other PII columns are never read by
    // this script, so they can never end up in a log line or report file.
    students = await Student.findAll({ attributes: ['sid'], where, order: [['sid', 'ASC']] });
  } catch (err) {
    // Unable to enumerate students — a major, script-level failure.
    logger.error('Motor baseline backfill: failed to enumerate students', { errorMessage: err.message });
    throw err;
  }
  if (flags.limit != null) students = students.slice(0, flags.limit);

  const results = [];
  for (const student of students) {
    const r = await processStudent(student.sid, { apply: flags.apply });
    results.push(r);
    console.log(`student ${r.studentId} -> ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
  }

  const finishedAt = new Date();
  const summary = buildSummary(results);
  printSummary(summary, flags.apply);

  const report = {
    mode:            flags.apply ? 'apply' : 'dry-run',
    startedAt:       startedAt.toISOString(),
    finishedAt:      finishedAt.toISOString(),
    baselineVersion: BASELINE_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    summary,
    results,
  };

  try {
    const reportPath = writeReport(report, startedAt);
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    // Non-fatal: the backfill work itself already completed/succeeded or
    // failed independently of whether the report file could be written.
    console.error(`\nWARNING: failed to write report file: ${err.message}`);
    logger.error('Motor baseline backfill: report write failed', { errorMessage: err.message });
  }

  return report;
}

module.exports = {
  parseArgs,
  evaluateCandidate,
  processStudent,
  buildSummary,
  classifyValidationReason,
  runBackfill,
};

if (require.main === module) {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  runBackfill(flags)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Motor baseline backfill failed:', err.message);
      process.exit(1);
    });
}

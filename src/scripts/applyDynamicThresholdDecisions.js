'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * applyDynamicThresholdDecisions.js
 *
 * Feature 2 Step 6B — controlled automatic threshold persistence. DRY RUN
 * BY DEFAULT — mirrors the exact safe pattern from
 * initializeFamilyThresholds.js. Only `--apply` performs real writes, and
 * only ever inserts 'automatic' student_threshold_history rows for a
 * family whose CURRENT decision is 'raise', is not teacher-protected, is
 * not stale, and is not already persisted under identical evidence.
 *
 *   node src/scripts/applyDynamicThresholdDecisions.js                  # dry run, all students with a baseline
 *   node src/scripts/applyDynamicThresholdDecisions.js --student-id=13  # dry run, one student
 *   node src/scripts/applyDynamicThresholdDecisions.js --window-size=5 --increase-step=5
 *   node src/scripts/applyDynamicThresholdDecisions.js --apply --student-id=13   # real write, one student
 *   node src/scripts/applyDynamicThresholdDecisions.js --apply                  # real write, ALL students — do not
 *                                                                                # run unscoped without explicit review
 *
 * Dry-run mode calls ONLY classifyAutomaticThresholdPersistence() (read-only
 * — see dynamicThresholdService.js) — never persistAutomaticThresholdDecisions().
 * This is a structural guarantee, not just a flag check: the writing
 * function is never even referenced in the dry-run code path.
 *
 * This script never touches students.personal_thresholds, never modifies
 * StudentMotorBaseline or LetterAttempt, and does not activate anything in
 * the live progression gate — it only ever writes to
 * student_threshold_history, and only in --apply mode, and only for
 * families that classify as would_create.
 *
 * These are pilot rule-based adaptive-progression events, not clinical
 * decisions — the 5-attempt window, 4-of-5 rule, and +5 step are pilot
 * engineering defaults requiring later teacher/pilot validation.
 */

const fs   = require('fs');
const path = require('path');

const { StudentMotorBaseline } = require('../models');
const {
  classifyAutomaticThresholdPersistence, persistAutomaticThresholdDecisions,
  RECENT_FAMILY_WINDOW_SIZE, THRESHOLD_INCREASE_STEP,
} = require('../services/dynamicThresholdService');

const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { apply: false, studentId: null, windowSize: RECENT_FAMILY_WINDOW_SIZE, increaseStep: THRESHOLD_INCREASE_STEP };
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
    } else if (arg.startsWith('--window-size=')) {
      const raw = arg.slice('--window-size='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --window-size value: "${raw}" (must be a positive integer)`);
      }
      flags.windowSize = n;
    } else if (arg.startsWith('--increase-step=')) {
      const raw = arg.slice('--increase-step='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid --increase-step value: "${raw}" (must be a finite number >= 0)`);
      }
      flags.increaseStep = n;
    }
  }
  return flags;
}

// ─── Student enumeration (same convention as the earlier Feature 2 scripts) ─

async function findStudentIdsWithBaselines(studentId) {
  const where = { source_type: 'initial_assessment' };
  if (studentId != null) where.student_id = studentId;
  const rows = await StudentMotorBaseline.findAll({ where, attributes: ['student_id'] });
  return [...new Set(rows.map(r => r.student_id))].sort((a, b) => a - b);
}

// ─── Per-student processing ─────────────────────────────────────────────────

// action/status vocabulary → one shared display label, so dry-run and apply
// output read consistently even though they come from two different
// functions (classifyAutomaticThresholdPersistence vs persistAutomaticThresholdDecisions).
function displayLabel(actionOrStatus) {
  switch (actionOrStatus) {
    case 'would_create':              return 'WOULD_CREATE';
    case 'created':                   return 'CREATED';
    case 'already_persisted':         return 'ALREADY_PERSISTED';
    case 'stale_decision':            return 'STALE_DECISION';
    case 'skipped_teacher_protected': return 'SKIPPED_TEACHER_PROTECTED';
    case 'skipped_requires_review':   return 'SKIPPED_REQUIRES_REVIEW';
    case 'skipped_hold':              return 'SKIPPED_HOLD';
    case 'skipped_support_review':    return 'SKIPPED_SUPPORT_REVIEW';
    case 'skipped_insufficient_data': return 'SKIPPED_INSUFFICIENT_DATA';
    case 'skipped_no_target':         return 'SKIPPED_NO_TARGET';
    case 'read_failed':               return 'READ_FAILED';
    case 'save_failed':               return 'FAILED';
    default:                          return actionOrStatus.toUpperCase();
  }
}

async function processStudentDryRun(studentId, windowSize, increaseStep) {
  const classification = await classifyAutomaticThresholdPersistence({ studentId, windowSize, increaseStep });
  return { studentId, classification, mode: 'dry-run' };
}

async function processStudentApply(studentId, windowSize, increaseStep) {
  const result = await persistAutomaticThresholdDecisions({ studentId, windowSize, increaseStep });
  return { studentId, result, mode: 'apply' };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printDryRunStudent({ studentId, classification }) {
  console.log(`\nStudent ${studentId}`);
  if (classification.status !== 'classified') {
    console.log(`  status: ${classification.status}`);
    return;
  }
  for (const family of FAMILIES) {
    const c = classification.families[family];
    console.log(`\n  ${family.toUpperCase()}`);
    console.log(`    action: ${displayLabel(c.action)}${c.reason ? ` (${c.reason})` : ''}`);
    if (c.action === 'would_create') {
      console.log(`    ${c.row.old_threshold} -> ${c.row.new_threshold}`);
    }
  }
}

function printApplyStudent({ studentId, result }) {
  console.log(`\nStudent ${studentId}`);
  if (result.status === 'invalid_input' || result.status === 'invalid_window_size'
      || result.status === 'invalid_increase_step' || result.status === 'read_failed') {
    console.log(`  status: ${result.status}`);
    return;
  }
  for (const family of FAMILIES) {
    const c = result.families[family];
    const suffix = c.newThreshold != null ? ` (${c.oldThreshold ?? '?'} -> ${c.newThreshold})` : c.reason ? ` (${c.reason})` : '';
    console.log(`  ${family.padEnd(8)} -> ${displayLabel(c.status)}${suffix}`);
  }
}

function buildSummary(records, applyMode) {
  const counts = {
    studentsScanned: records.length, created: 0, alreadyPersisted: 0, staleDecision: 0,
    skippedTeacherProtected: 0, skippedRequiresReview: 0, skippedHold: 0, skippedSupportReview: 0,
    skippedInsufficientData: 0, skippedNoTarget: 0, failed: 0,
  };
  for (const rec of records) {
    const perFamily = applyMode
      ? (rec.result.families ? Object.values(rec.result.families) : [])
      : (rec.classification.families ? Object.values(rec.classification.families) : []);
    for (const c of perFamily) {
      const key = applyMode ? c.status : c.action;
      switch (key) {
        case 'created':                   counts.created++; break;
        case 'would_create':              break; // dry-run only — not counted as a real outcome
        case 'already_persisted':         counts.alreadyPersisted++; break;
        case 'stale_decision':            counts.staleDecision++; break;
        case 'skipped_teacher_protected': counts.skippedTeacherProtected++; break;
        case 'skipped_requires_review':   counts.skippedRequiresReview++; break;
        case 'skipped_hold':              counts.skippedHold++; break;
        case 'skipped_support_review':    counts.skippedSupportReview++; break;
        case 'skipped_insufficient_data': counts.skippedInsufficientData++; break;
        case 'skipped_no_target':         counts.skippedNoTarget++; break;
        case 'save_failed':
        case 'read_failed':               counts.failed++; break;
        default: break;
      }
    }
  }
  return counts;
}

function printSummary(counts, applyMode) {
  console.log('\nAutomatic Threshold Decision Summary\n');
  console.log(`Mode: ${applyMode ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`Students scanned: ${counts.studentsScanned}`);
  console.log(`Created: ${counts.created}`);
  console.log(`Already persisted: ${counts.alreadyPersisted}`);
  console.log(`Stale decision: ${counts.staleDecision}`);
  console.log(`Skipped (teacher protected): ${counts.skippedTeacherProtected}`);
  console.log(`Skipped (requires review): ${counts.skippedRequiresReview}`);
  console.log(`Skipped (hold): ${counts.skippedHold}`);
  console.log(`Skipped (support review): ${counts.skippedSupportReview}`);
  console.log(`Skipped (insufficient data): ${counts.skippedInsufficientData}`);
  console.log(`Skipped (no target): ${counts.skippedNoTarget}`);
  console.log(`Failed: ${counts.failed}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `apply-dynamic-threshold-decisions-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log(`MODE: ${flags.apply ? 'APPLY' : 'DRY RUN'}`);
  if (flags.apply) {
    console.log('Eligible automatic raise decisions WILL be written to student_threshold_history.');
    console.log('students.personal_thresholds will NOT be modified. The live progression gate is unaffected.');
  } else {
    console.log('No database writes will be performed.');
  }
  console.log(`Window size: ${flags.windowSize}  Increase step: +${flags.increaseStep}  (pilot defaults, not clinically validated)`);

  const studentIds = await findStudentIdsWithBaselines(flags.studentId);
  if (studentIds.length === 0) {
    console.log(flags.studentId != null
      ? `\nStudent ${flags.studentId} has no baseline — nothing to evaluate.`
      : '\nNo students currently have a baseline — nothing to evaluate.');
  }

  const records = [];
  for (const studentId of studentIds) {
    if (flags.apply) {
      const rec = await processStudentApply(studentId, flags.windowSize, flags.increaseStep);
      records.push(rec);
      printApplyStudent(rec);
    } else {
      const rec = await processStudentDryRun(studentId, flags.windowSize, flags.increaseStep);
      records.push(rec);
      printDryRunStudent(rec);
    }
  }

  const summary = buildSummary(records, flags.apply);
  printSummary(summary, flags.apply);

  const report = {
    mode: flags.apply ? 'apply' : 'dry-run',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    windowSize: flags.windowSize,
    increaseStep: flags.increaseStep,
    summary,
    students: records.map(r => flags.apply
      ? { studentId: r.studentId, result: r.result }
      : { studentId: r.studentId, classification: r.classification }),
  };

  try {
    const reportPath = writeReport(report, startedAt);
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    console.error(`\nWARNING: failed to write report file: ${err.message}`);
  }

  return report;
}

module.exports = { parseArgs, findStudentIdsWithBaselines, run };

if (require.main === module) {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  run(flags)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Apply dynamic threshold decisions failed:', err.message);
      process.exit(1);
    });
}

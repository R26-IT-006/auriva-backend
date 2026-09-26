'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * initializeFamilyThresholds.js
 *
 * Feature 2 Step 3 — controlled persistence of initial family threshold
 * history events. DRY RUN BY DEFAULT — mirrors the exact safe pattern from
 * backfillMotorBaselines.js. Only `--apply` performs real writes.
 *
 *   node src/scripts/initializeFamilyThresholds.js                  # dry run, all students with a baseline
 *   node src/scripts/initializeFamilyThresholds.js --student-id=13  # dry run, one student
 *   node src/scripts/initializeFamilyThresholds.js --margin=3       # dry run, override the pilot margin
 *   node src/scripts/initializeFamilyThresholds.js --apply --student-id=13   # real write, one student
 *   node src/scripts/initializeFamilyThresholds.js --apply                  # real write, ALL students — do not
 *                                                                            # run unscoped without explicit review
 *
 * Dry-run mode calls ONLY classifyFamilyInitialization() (read-only — see
 * dynamicThresholdService.js) — never createInitialFamilyThresholds(). This
 * is a structural guarantee, not just a flag check: the writing function is
 * never even referenced in the dry-run code path.
 *
 * This script never touches students.personal_thresholds, never modifies
 * StudentMotorBaseline, and does not activate anything in the live
 * progression gate — it only ever writes to student_threshold_history, and
 * only in --apply mode.
 */

const fs   = require('fs');
const path = require('path');

const { StudentMotorBaseline } = require('../models');
const {
  classifyFamilyInitialization, createInitialFamilyThresholds, INITIAL_THRESHOLD_MARGIN,
} = require('../services/dynamicThresholdService');

const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { apply: false, studentId: null, margin: INITIAL_THRESHOLD_MARGIN };
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
    } else if (arg.startsWith('--margin=')) {
      const raw = arg.slice('--margin='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid --margin value: "${raw}" (must be a finite number >= 0)`);
      }
      flags.margin = n;
    }
  }
  return flags;
}

// ─── Student enumeration (same convention as dryRunInitialFamilyThresholds.js) ─

async function findStudentIdsWithBaselines(studentId) {
  const where = { source_type: 'initial_assessment' };
  if (studentId != null) where.student_id = studentId;
  const rows = await StudentMotorBaseline.findAll({ where, attributes: ['student_id'] });
  return [...new Set(rows.map(r => r.student_id))].sort((a, b) => a - b);
}

// ─── Per-student processing ─────────────────────────────────────────────────

// action/status vocabulary → one shared display label, so dry-run and apply
// output read consistently even though they come from two different
// functions (classifyFamilyInitialization vs createInitialFamilyThresholds).
function displayLabel(actionOrStatus) {
  switch (actionOrStatus) {
    case 'would_create':            return 'WOULD_CREATE';
    case 'created':                 return 'CREATED';
    case 'already_initialized':     return 'ALREADY_INITIALIZED';
    case 'skipped_requires_review': return 'SKIPPED_REQUIRES_REVIEW';
    case 'skipped_invalid_baseline':return 'SKIPPED_INVALID_BASELINE';
    case 'save_failed':             return 'FAILED';
    default:                        return actionOrStatus.toUpperCase();
  }
}

async function processStudentDryRun(studentId, margin) {
  const { derivation, classification } = await classifyFamilyInitialization({ studentId, margin });
  return { studentId, derivation, classification, mode: 'dry-run' };
}

async function processStudentApply(studentId, margin) {
  const result = await createInitialFamilyThresholds({ studentId, margin });
  return { studentId, result, mode: 'apply' };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printDryRunStudent({ studentId, derivation, classification }) {
  console.log(`\nStudent ${studentId}`);
  if (derivation.status !== 'derived') {
    console.log(`  status: ${derivation.status}`);
    return;
  }
  for (const family of FAMILIES) {
    const c = classification[family];
    console.log(`\n  ${family}`);
    if (c.action === 'would_create') {
      console.log(`    baseline: ${c.baselineScore}`);
      console.log(`    target:   ${c.rawTarget}  (pilot derived target, not clinically validated)`);
      console.log(`    action:   ${displayLabel(c.action)}`);
    } else if (c.action === 'already_initialized') {
      console.log(`    action:   ${displayLabel(c.action)} (existing target: ${c.newThreshold})`);
    } else {
      console.log(`    action:   ${displayLabel(c.action)} (${c.reason})`);
    }
  }
}

function printApplyStudent({ studentId, result }) {
  console.log(`\nStudent ${studentId}`);
  if (result.status === 'baseline_not_found' || result.status === 'invalid_input'
      || result.status === 'invalid_margin' || result.status === 'read_failed') {
    console.log(`  status: ${result.status}`);
    return;
  }
  for (const family of FAMILIES) {
    const c = result.created[family];
    const suffix = c.newThreshold != null ? ` (${c.newThreshold})` : c.reason ? ` (${c.reason})` : '';
    console.log(`  ${family.padEnd(8)} -> ${displayLabel(c.status)}${suffix}`);
  }
}

function buildSummary(records, applyMode) {
  const counts = { studentsScanned: records.length, created: 0, alreadyInitialized: 0, skippedReview: 0, skippedInvalid: 0, failed: 0 };
  for (const rec of records) {
    const perFamily = applyMode
      ? (rec.result.created ? Object.values(rec.result.created) : [])
      : (rec.classification ? Object.values(rec.classification) : []);
    for (const c of perFamily) {
      const key = applyMode ? c.status : c.action;
      switch (key) {
        case 'created':                  counts.created++; break;
        case 'would_create':             break; // dry-run only — not counted as a real outcome
        case 'already_initialized':      counts.alreadyInitialized++; break;
        case 'skipped_requires_review':  counts.skippedReview++; break;
        case 'skipped_invalid_baseline': counts.skippedInvalid++; break;
        case 'save_failed':              counts.failed++; break;
        default: break;
      }
    }
  }
  return counts;
}

function printSummary(counts, applyMode) {
  console.log('\nInitial Family Threshold Summary\n');
  console.log(`Mode: ${applyMode ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`Students scanned: ${counts.studentsScanned}`);
  console.log(`Created: ${counts.created}`);
  console.log(`Already initialized: ${counts.alreadyInitialized}`);
  console.log(`Skipped (requires review): ${counts.skippedReview}`);
  console.log(`Skipped (invalid baseline): ${counts.skippedInvalid}`);
  console.log(`Failed: ${counts.failed}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `initialize-family-thresholds-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log(`MODE: ${flags.apply ? 'APPLY' : 'DRY RUN'}`);
  if (flags.apply) {
    console.log('Eligible initial family thresholds WILL be written to student_threshold_history.');
    console.log('students.personal_thresholds will NOT be modified. The live progression gate is unaffected.');
  } else {
    console.log('No database writes will be performed.');
  }
  console.log(`Margin: +${flags.margin} — pilot engineering default, NOT clinically validated.`);

  const studentIds = await findStudentIdsWithBaselines(flags.studentId);
  if (studentIds.length === 0) {
    console.log(flags.studentId != null
      ? `\nStudent ${flags.studentId} has no baseline — nothing to initialize.`
      : '\nNo students currently have a baseline — nothing to initialize.');
  }

  const records = [];
  for (const studentId of studentIds) {
    if (flags.apply) {
      const rec = await processStudentApply(studentId, flags.margin);
      records.push(rec);
      printApplyStudent(rec);
    } else {
      const rec = await processStudentDryRun(studentId, flags.margin);
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
    margin: flags.margin,
    summary,
    students: records.map(r => flags.apply
      ? { studentId: r.studentId, result: r.result }
      : { studentId: r.studentId, derivation: r.derivation, classification: r.classification }),
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
      console.error('Initialize family thresholds failed:', err.message);
      process.exit(1);
    });
}

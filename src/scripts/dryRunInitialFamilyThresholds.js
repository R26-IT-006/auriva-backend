'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunInitialFamilyThresholds.js
 *
 * Feature 2 Step 2 — READ-ONLY / CALCULATION-ONLY dry run.
 *
 * Reports what an initial per-family progression target (straight/curved/
 * complex) *would* be for each student with an immutable Feature 1
 * baseline, using dynamicThresholdService.deriveInitialFamilyThresholds().
 *
 * This script has NO write mode. There is no --apply flag — using one is a
 * usage error, not silently ignored. It never inserts into
 * student_threshold_history, never touches students.personal_thresholds,
 * never modifies StudentMotorBaseline. Every DB interaction here is a
 * SELECT.
 *
 *   node src/scripts/dryRunInitialFamilyThresholds.js                  # all students with a baseline
 *   node src/scripts/dryRunInitialFamilyThresholds.js --student-id=13  # one student
 *   node src/scripts/dryRunInitialFamilyThresholds.js --margin=3       # override the pilot margin
 */

const fs   = require('fs');
const path = require('path');

const { Student, StudentMotorBaseline } = require('../models');
const { deriveInitialFamilyThresholds, INITIAL_THRESHOLD_MARGIN } = require('../services/dynamicThresholdService');

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, margin: INITIAL_THRESHOLD_MARGIN };
  for (const arg of argv) {
    if (arg === '--apply') {
      // No write mode exists in this step — reject rather than silently
      // ignore, so nobody mistakes a no-op for a real apply run.
      throw new Error('--apply is not supported: this script is read-only/calculation-only (Feature 2 Step 2).');
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

// ─── Student enumeration ───────────────────────────────────────────────────

/**
 * "All students who have baselines" — queried directly from
 * StudentMotorBaseline rather than iterating every student and discarding
 * the ones without one. Only ever selects student_id — no name/PII column
 * is ever read by this script.
 */
async function findStudentIdsWithBaselines(studentId) {
  const where = { source_type: 'initial_assessment' };
  if (studentId != null) where.student_id = studentId;

  const rows = await StudentMotorBaseline.findAll({ where, attributes: ['student_id'] });
  return [...new Set(rows.map(r => r.student_id))].sort((a, b) => a - b);
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printFamilyLine(family, result) {
  if (result.status === 'ready') {
    console.log(`    ${family.padEnd(8)} -> ${result.rawTarget}  (pilot derived target, ready)`);
  } else if (result.status === 'requires_review') {
    console.log(`    ${family.padEnd(8)} -> ${result.rawTarget}  REQUIRES REVIEW (${result.reason})`);
  } else {
    console.log(`    ${family.padEnd(8)} -> n/a  SAFE FAILURE (${result.reason})`);
  }
}

function printStudentResult(result) {
  console.log(`\nStudent ${result.studentId}`);
  if (result.status !== 'derived') {
    console.log(`  status: ${result.status}`);
    return;
  }
  console.log(`  Baseline: straight=${result.thresholds.straight.baselineScore} ` +
    `curved=${result.thresholds.curved.baselineScore} complex=${result.thresholds.complex.baselineScore}`);
  console.log(`  Margin: +${result.margin} (pilot engineering default, not clinically validated)`);
  console.log('  Derived:');
  printFamilyLine('straight', result.thresholds.straight);
  printFamilyLine('curved',   result.thresholds.curved);
  printFamilyLine('complex',  result.thresholds.complex);
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const filePath = path.join(dir, `dry-run-initial-family-thresholds-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function runDryRun(flags) {
  const startedAt = new Date();

  console.log('MODE: DRY RUN (calculation only)');
  console.log('No database writes will be performed. No --apply mode exists in this step.');
  console.log(`Margin: +${flags.margin} — pilot engineering default, NOT clinically validated.`);

  const studentIds = await findStudentIdsWithBaselines(flags.studentId);

  if (studentIds.length === 0) {
    console.log(flags.studentId != null
      ? `\nStudent ${flags.studentId} has no baseline — nothing to derive.`
      : '\nNo students currently have a baseline — nothing to derive.');
  }

  const results = [];
  for (const studentId of studentIds) {
    const result = await deriveInitialFamilyThresholds({ studentId, margin: flags.margin });
    results.push(result);
    printStudentResult(result);
  }

  const finishedAt = new Date();
  const report = {
    mode: 'dry-run',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    margin: flags.margin,
    mappingVersion: results[0]?.mappingVersion ?? null,
    students: results,
  };

  try {
    const reportPath = writeReport(report, startedAt);
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    console.error(`\nWARNING: failed to write report file: ${err.message}`);
  }

  return report;
}

module.exports = { parseArgs, findStudentIdsWithBaselines, runDryRun };

if (require.main === module) {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  runDryRun(flags)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Dry run failed:', err.message);
      process.exit(1);
    });
}

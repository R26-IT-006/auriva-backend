'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunDynamicThresholdDecision.js
 *
 * Feature 2 Step 5 — READ-ONLY dynamic threshold DECISION SIMULATION. There
 * is no --apply mode: evaluateDynamicThresholds() never writes anything (no
 * 'automatic' ThresholdHistory row, no personal_thresholds change, no
 * activation of the live progression gate) — passing --apply is a hard
 * error, not a silently-ignored flag, matching dryRunRecentFamilyPerformance.js.
 *
 *   node src/scripts/dryRunDynamicThresholdDecision.js --student-id=13
 *   node src/scripts/dryRunDynamicThresholdDecision.js --student-id=13 --window-size=5 --increase-step=5
 *   node src/scripts/dryRunDynamicThresholdDecision.js                # all students with a baseline
 *
 * These are pilot rule-based adaptive-progression RECOMMENDATIONS, not
 * clinical decisions — the 5-attempt window, the 4-of-5 raise rule, and the
 * +5 increment are pilot engineering defaults requiring later teacher/pilot
 * validation (see dynamicThresholdService.js module header).
 */

const fs   = require('fs');
const path = require('path');

const { StudentMotorBaseline } = require('../models');
const {
  evaluateDynamicThresholds, RECENT_FAMILY_WINDOW_SIZE, THRESHOLD_INCREASE_STEP,
} = require('../services/dynamicThresholdService');

const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, windowSize: RECENT_FAMILY_WINDOW_SIZE, increaseStep: THRESHOLD_INCREASE_STEP };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only decision simulation, it never persists anything (Feature 2 Step 5).');
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

// ─── Reporting ──────────────────────────────────────────────────────────────

function displayDecision(decision) {
  return decision.toUpperCase();
}

function printStudentResult(studentId, result) {
  console.log(`\nStudent ${studentId}`);
  if (result.status !== 'evaluated') {
    console.log(`  status: ${result.status}`);
    return;
  }
  for (const family of FAMILIES) {
    const f = result.families[family];
    console.log(`\n  ${family.toUpperCase()}`);
    console.log(`    target: ${f.currentThreshold ?? 'n/a'}`);
    console.log(`    ${f.window.count}/${result.windowSize} observations${f.scores.length ? ' — scores ' + f.scores.join(',') : ''}`);
    console.log(`    decision: ${displayDecision(f.decision)}  (${f.reason})`);
    if (f.decision === 'raise' || f.decision === 'raise_requires_review') {
      console.log(`    rawRecommendedThreshold: ${f.rawRecommendedThreshold}  recommendedThreshold: ${f.recommendedThreshold ?? 'REQUIRES REVIEW'}`);
    }
  }
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `dynamic-threshold-decision-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY DECISION SIMULATION (no write mode exists for this script)');
  console.log(`Window size: ${flags.windowSize}  Increase step: +${flags.increaseStep}  (pilot defaults, not clinically validated)`);
  console.log('No ThresholdHistory row will be written. students.personal_thresholds is not read or modified. The live progression gate is unaffected.');

  const studentIds = await findStudentIdsWithBaselines(flags.studentId);
  if (studentIds.length === 0) {
    console.log(flags.studentId != null
      ? `\nStudent ${flags.studentId} has no baseline — nothing to evaluate.`
      : '\nNo students currently have a baseline — nothing to evaluate.');
  }

  const records = [];
  for (const studentId of studentIds) {
    const result = await evaluateDynamicThresholds({ studentId, windowSize: flags.windowSize, increaseStep: flags.increaseStep });
    records.push({ studentId, result });
    printStudentResult(studentId, result);
  }

  const report = {
    mode: 'read-only-decision-simulation',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    windowSize: flags.windowSize,
    increaseStep: flags.increaseStep,
    students: records,
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
      console.error('Dynamic threshold decision simulation failed:', err.message);
      process.exit(1);
    });
}

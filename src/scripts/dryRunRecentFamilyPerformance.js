'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunRecentFamilyPerformance.js
 *
 * Feature 2 Step 4 — READ-ONLY recent independent performance window
 * report. There is no --apply mode for this script: nothing in the
 * underlying service (getRecentFamilyPerformance) ever writes to the
 * database, so a write mode does not exist to opt into. Passing --apply is
 * a hard error, not a silently-ignored flag.
 *
 *   node src/scripts/dryRunRecentFamilyPerformance.js --student-id=13
 *   node src/scripts/dryRunRecentFamilyPerformance.js --student-id=13 --window-size=8
 *   node src/scripts/dryRunRecentFamilyPerformance.js                # all students with a baseline
 *
 * This script never touches student_threshold_history,
 * students.personal_thresholds, or StudentMotorBaseline, and makes no
 * automatic threshold decision — it only reports what recent independent
 * attempt data exists per family, per Feature 2 Step 4's explicit scope.
 */

const fs   = require('fs');
const path = require('path');

const { StudentMotorBaseline } = require('../models');
const { getRecentFamilyPerformance, RECENT_FAMILY_WINDOW_SIZE } = require('../services/dynamicThresholdService');

const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, windowSize: RECENT_FAMILY_WINDOW_SIZE };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only and has no write mode (Feature 2 Step 4).');
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
    }
  }
  return flags;
}

// ─── Student enumeration (same convention as the Step 2/3 scripts) ─────────

async function findStudentIdsWithBaselines(studentId) {
  const where = { source_type: 'initial_assessment' };
  if (studentId != null) where.student_id = studentId;
  const rows = await StudentMotorBaseline.findAll({ where, attributes: ['student_id'] });
  return [...new Set(rows.map(r => r.student_id))].sort((a, b) => a - b);
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printStudentResult(studentId, result) {
  console.log(`\nStudent ${studentId}`);
  if (result.status !== 'found') {
    console.log(`  status: ${result.status}`);
    return;
  }
  for (const family of FAMILIES) {
    const f = result.families[family];
    console.log(`\n  ${family} — ${f.count}/${result.windowSize} (window complete: ${f.windowComplete ? 'yes' : 'no'})`);
    for (const a of f.attempts) {
      console.log(`    ${a.letter} (${a.caseType}) — score ${a.performanceScore} — ${new Date(a.createdAt).toISOString()}`);
    }
  }
  console.log('\n  exclusions:', result.exclusions);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `recent-family-performance-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log(`Window size: ${flags.windowSize} (pilot default, not clinically validated)`);

  const studentIds = await findStudentIdsWithBaselines(flags.studentId);
  if (studentIds.length === 0) {
    console.log(flags.studentId != null
      ? `\nStudent ${flags.studentId} has no baseline — nothing to report.`
      : '\nNo students currently have a baseline — nothing to report.');
  }

  const records = [];
  for (const studentId of studentIds) {
    const result = await getRecentFamilyPerformance({ studentId, windowSize: flags.windowSize });
    records.push({ studentId, result });
    printStudentResult(studentId, result);
  }

  const report = {
    mode: 'read-only',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    windowSize: flags.windowSize,
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
      console.error('Recent family performance report failed:', err.message);
      process.exit(1);
    });
}

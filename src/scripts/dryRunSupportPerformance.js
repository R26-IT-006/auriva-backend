'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunSupportPerformance.js
 *
 * Feature 3 Step 4 — READ-ONLY support-performance reconstruction report.
 *
 *   node src/scripts/dryRunSupportPerformance.js --student-id=13
 *   node src/scripts/dryRunSupportPerformance.js --student-id=13 --window-size=8
 *
 * --student-id is REQUIRED. Unlike dryRunRecentFamilyPerformance.js's
 * optional "all students with a baseline" mode, this script has no
 * student-enumeration source of its own — Feature 3 Step 4 deliberately
 * does not depend on StudentMotorBaseline (a Feature 1 concept unrelated to
 * support-level evidence), and the Step 4 spec's own CLI usage only
 * describes a single-student invocation.
 *
 * There is no --apply mode: nothing in getSupportPerformanceByFamily() ever
 * writes to the database, so passing --apply is a hard error, not a
 * silently-ignored flag — same convention as dryRunRecentFamilyPerformance.js.
 *
 * Output framing (Step 4 spec §40): this reports OBSERVED HANDWRITING
 * PERFORMANCE UNDER DIFFERENT SOFTWARE SUPPORT PRESENTATIONS. It does not
 * claim, and must never be read as claiming, that any support level
 * "improves motor ability" — that is not a conclusion observational
 * evidence like this can support, especially not from a handful of
 * sessions. No recommendation is computed or printed anywhere in this file.
 */

const fs = require('fs');
const path = require('path');

const { getSupportPerformanceByFamily, SUPPORT_PERFORMANCE_WINDOW_SIZE } = require('../services/adaptiveSupportService');
const { LETTER_SUPPORT_LEVELS } = require('../config/letterSupportLevels');

const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, windowSize: SUPPORT_PERFORMANCE_WINDOW_SIZE };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only and has no write mode (Feature 3 Step 4).');
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
  if (flags.studentId == null) {
    throw new Error('--student-id is required, e.g. --student-id=13');
  }
  return flags;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printResult(studentId, result) {
  console.log(`\nStudent ${studentId}`);
  console.log(`Window size: ${result.windowSize ?? '(n/a)'}`);

  if (result.status !== 'found') {
    console.log(`  status: ${result.status}`);
    return;
  }

  for (const family of FAMILIES) {
    console.log(`\n${family.toUpperCase()}`);
    for (const level of LETTER_SUPPORT_LEVELS) {
      const w = result.families[family][level];
      const avg = w.averageScore == null ? '' : ` avg=${Math.round(w.averageScore)}`;
      console.log(`  ${level.toUpperCase().padEnd(6)}  ${w.count}/${result.windowSize}${avg}`);
    }
  }

  console.log('\nSupport source:');
  console.log(`  explicit          = ${result.supportSourceCounts.explicit}`);
  console.log(`  historical proxy  = ${result.supportSourceCounts.historicalProxy}`);

  console.log('\nExclusions:', result.exclusions);
  console.log('Diagnostics (informational only, never excludes anything):', result.diagnostics);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `support-performance-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('Reports OBSERVED performance under different support presentations — not a recommendation, not a motor-ability claim.');
  console.log(`Window size: ${flags.windowSize} (pilot default, not clinically validated)`);

  const result = await getSupportPerformanceByFamily({ studentId: flags.studentId, windowSize: flags.windowSize });
  printResult(flags.studentId, result);

  const report = {
    mode: 'read-only',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    studentId: flags.studentId,
    windowSize: flags.windowSize,
    result,
  };

  try {
    const reportPath = writeReport(report, startedAt);
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    console.error(`\nWARNING: failed to write report file: ${err.message}`);
  }

  return report;
}

module.exports = { parseArgs, printResult, run };

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
      console.error('Support performance report failed:', err.message);
      process.exit(1);
    });
}

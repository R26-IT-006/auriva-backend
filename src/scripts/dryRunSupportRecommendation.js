'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunSupportRecommendation.js
 *
 * Feature 3 Step 5 — READ-ONLY adaptive support RECOMMENDATION report.
 *
 *   node src/scripts/dryRunSupportRecommendation.js --student-id=13
 *   node src/scripts/dryRunSupportRecommendation.js --student-id=13 --window-size=8
 *
 * --student-id is required — same convention as dryRunSupportPerformance.js
 * (Step 4): this script has no student-enumeration source of its own.
 *
 * There is no --apply mode: nothing in evaluateSupportRecommendations() ever
 * writes to the database — no support_level change, no ThresholdHistory
 * row, no new "support history" table (none exists yet). Passing --apply is
 * a hard error, not a silently-ignored flag.
 *
 * Output framing (Step 5 spec §45): this is a SOFTWARE SUPPORT
 * RECOMMENDATION based on OBSERVED HANDWRITING PERFORMANCE under different
 * support presentations. It is NOT a clinical diagnosis, NOT a therapy
 * prescription, and NOT a validated ASD-treatment rule. The 5-attempt
 * window, the 4-of-5 success rule, and the lowest-successful-support
 * principle are pilot engineering defaults requiring teacher/pilot
 * validation — never described here as anything stronger.
 */

const fs = require('fs');
const path = require('path');

const { evaluateSupportRecommendations, SUPPORT_PERFORMANCE_WINDOW_SIZE } = require('../services/adaptiveSupportService');

const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, windowSize: SUPPORT_PERFORMANCE_WINDOW_SIZE };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only and has no write mode (Feature 3 Step 5). No support decision is ever persisted by this codebase yet.');
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
  console.log(`\nSTUDENT ${studentId}`);

  if (result.status !== 'evaluated') {
    console.log(`  status: ${result.status}`);
    return;
  }

  for (const family of FAMILIES) {
    const f = result.families[family];
    console.log(`\n${family.toUpperCase()}`);
    console.log(`target: ${f.currentTarget ?? '(none)'}`);

    if (f.decision !== 'insufficient_data' && f.decision !== 'insufficient_target') {
      for (const level of ['low', 'medium', 'high']) {
        const r = f.supportResults[level];
        const met = r.metTargetCount == null ? '' : ` (${r.metTargetCount} met target)`;
        console.log(`  ${level.toUpperCase().padEnd(6)}   ${r.count}/${result.windowSize}${met}`);
      }
    }

    console.log(`decision: ${f.decision.toUpperCase()}`);
    if (f.recommendedSupport) console.log(`recommended support: ${f.recommendedSupport.toUpperCase()}`);
    if (f.requiresReview) console.log('*** REQUIRES TEACHER/SYSTEM REVIEW ***');
    console.log(`evidence basis: ${f.evidenceBasis ?? '(no evidence)'}`);
  }
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `support-recommendation-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This is a SOFTWARE SUPPORT RECOMMENDATION based on observed performance —');
  console.log('not a clinical diagnosis, not a therapy prescription, not a validated ASD-treatment rule.');
  console.log(`Window size: ${flags.windowSize} (pilot default, not clinically validated)`);

  const result = await evaluateSupportRecommendations({ studentId: flags.studentId, windowSize: flags.windowSize });
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
      console.error('Support recommendation report failed:', err.message);
      process.exit(1);
    });
}

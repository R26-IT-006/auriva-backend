'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunPreWritingRecommendation.js
 *
 * Feature 4 Step 4 — READ-ONLY adaptive pre-writing recommendation report.
 *
 *   node src/scripts/dryRunPreWritingRecommendation.js --student-id=13 --letter=c --case-type=lowercase
 *
 * All three flags are required — this script has no student/letter
 * enumeration source of its own (same convention as
 * dryRunSupportRecommendation.js).
 *
 * There is no --apply mode: evaluatePreWritingRecommendation() never writes
 * to the database — no ShapeFeature row, no recommendation-history table
 * (none exists), no warm-up guard state (that is frontend-only, Feature 4
 * Step 3). Passing --apply is a hard error, not a silently-ignored flag.
 *
 * Output framing (Step 4 spec §48): this is a SOFTWARE recommendation for a
 * short pre-writing motor-preparation activity, based on persistent,
 * family-level handwriting difficulty. It is NOT a clinical diagnosis, NOT
 * a therapy prescription, and NOT a validated autism-treatment rule. The
 * Feature 2/3 `support_review` trigger is a pilot engineering rule
 * requiring teacher/pilot validation, never described here as anything
 * stronger.
 */

const fs = require('fs');
const path = require('path');

const { evaluatePreWritingRecommendation } = require('../services/adaptivePreWritingService');

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, letter: null, caseType: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only and has no write mode (Feature 4 Step 4). No pre-writing recommendation is ever persisted by this codebase.');
    } else if (arg.startsWith('--student-id=')) {
      const raw = arg.slice('--student-id='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --student-id value: "${raw}" (must be a positive integer)`);
      }
      flags.studentId = n;
    } else if (arg.startsWith('--letter=')) {
      flags.letter = arg.slice('--letter='.length);
    } else if (arg.startsWith('--case-type=')) {
      flags.caseType = arg.slice('--case-type='.length);
    }
  }
  if (flags.studentId == null) {
    throw new Error('--student-id is required, e.g. --student-id=13');
  }
  if (!flags.letter) {
    throw new Error('--letter is required, e.g. --letter=c');
  }
  if (!flags.caseType) {
    throw new Error('--case-type is required, e.g. --case-type=lowercase');
  }
  return flags;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function printResult(flags, result) {
  console.log(`\nStudent: ${flags.studentId}`);
  console.log(`Letter: ${flags.letter}`);
  console.log(`Case: ${flags.caseType}`);

  if (result.status !== 'evaluated') {
    console.log(`\nstatus: ${result.status}`);
    return;
  }

  console.log(`\nFamily: ${result.family ?? '—'}`);
  console.log(`Primitive group: ${result.primitiveGroup ?? '—'}`);

  if (result.signals) {
    console.log(`\nFeature 2: ${result.signals.feature2Decision}`);
    console.log(`Feature 3: ${result.signals.feature3Decision}`);
  }

  console.log(`\nRecommended: ${result.recommended ? 'YES' : 'NO'}`);
  console.log(`Reason: ${result.reason ?? '—'}`);
  console.log(`Activity: ${result.activityId ?? '—'}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `pre-writing-recommendation-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This is a SOFTWARE recommendation for a pre-writing motor-preparation activity —');
  console.log('not a clinical diagnosis, not a therapy prescription, not a validated autism-treatment rule.');

  const result = await evaluatePreWritingRecommendation({
    studentId: flags.studentId, letter: flags.letter, caseType: flags.caseType,
  });
  printResult(flags, result);

  const report = {
    mode: 'read-only',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    studentId: flags.studentId,
    letter: flags.letter,
    caseType: flags.caseType,
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
      console.error('Pre-writing recommendation report failed:', err.message);
      process.exit(1);
    });
}

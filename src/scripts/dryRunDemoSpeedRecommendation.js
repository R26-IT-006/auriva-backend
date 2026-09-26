'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunDemoSpeedRecommendation.js
 *
 * Feature 6 Step 3 — READ-ONLY demo-speed recommendation report.
 *
 *   node src/scripts/dryRunDemoSpeedRecommendation.js --student-id=13 --letter=c --case-type=lowercase
 *
 * All three flags are required — this script has no student/letter
 * enumeration source of its own (same convention as
 * dryRunPreWritingRecommendation.js / dryRunRepetitionRecommendation.js).
 *
 * There is no --apply mode: evaluateDemoSpeedRecommendation() never writes
 * to the database — no LetterAttempt row, no recommendation-history table
 * (none exists), no tracer-timing change (that is a future activation
 * step). Passing --apply is a hard error.
 *
 * Output framing (Step 3 spec §56): this is a SOFTWARE recommendation for a
 * reduced demonstration speed, based on persistent, family-level
 * handwriting difficulty. It is NOT a clinical treatment, NOT a motor
 * diagnosis, NOT an ASD-severity classification. The slow multiplier
 * (Feature 6 Step 2) is a pilot engineering default requiring teacher/pilot
 * validation, never described here as anything stronger.
 */

const fs = require('fs');
const path = require('path');

const { evaluateDemoSpeedRecommendation } = require('../services/demoSpeedRecommendationService');

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, letter: null, caseType: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only and has no write mode (Feature 6 Step 3). No demo-speed recommendation is ever persisted by this codebase yet.');
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

  if (result.status !== 'evaluated') {
    console.log(`\nstatus: ${result.status}`);
    return;
  }

  console.log(`Family: ${result.family ?? '—'}`);

  if (result.signals) {
    console.log(`\nFeature 2: ${result.signals.feature2Decision}`);
    console.log(`Feature 3: ${result.signals.feature3Decision}`);
  }

  console.log(`\nRecommended speed: ${result.recommendedSpeedLevel.toUpperCase()}`);
  console.log(`Reason: ${result.reason ?? '—'}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `demo-speed-recommendation-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This is a SOFTWARE recommendation for a reduced demonstration speed —');
  console.log('not a clinical treatment, not a motor diagnosis, not an ASD-severity classification.');

  const result = await evaluateDemoSpeedRecommendation({
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
      console.error('Demo speed recommendation report failed:', err.message);
      process.exit(1);
    });
}

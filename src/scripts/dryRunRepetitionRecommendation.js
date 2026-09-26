'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunRepetitionRecommendation.js
 *
 * Feature 5 Step 2 — READ-ONLY repetition recommendation report.
 *
 *   node src/scripts/dryRunRepetitionRecommendation.js \
 *     --student-id=13 --letter=c --case-type=lowercase [--adaptive-repetitions-used=0]
 *
 * --adaptive-repetitions-used defaults to 0 (matches the service's own
 * default, used for read-only exploration — a real caller in a future step
 * would supply the actual current-interaction count).
 *
 * There is no --apply mode: evaluateRepetitionRecommendation() never writes
 * to the database — no LetterAttempt/LetterProgress/ThresholdHistory row,
 * no recommendation-history table (none exists), no sequence reinsertion
 * (that is a future step). Passing --apply is a hard error.
 *
 * Output framing (Step 2 spec §51): this is a SOFTWARE recommendation that
 * a handwriting target may benefit from ONE additional spaced revisit
 * because persistent family-level difficulty is observed. It is NOT a
 * clinical prescription. The cap (1 automatic spaced repetition per letter
 * per interaction) is a conservative pilot engineering safety rule
 * requiring teacher/pilot validation, never described here as anything
 * stronger.
 */

const fs = require('fs');
const path = require('path');

const { evaluateRepetitionRecommendation } = require('../services/repetitionRecommendationService');

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, letter: null, caseType: null, adaptiveRepetitionsUsed: 0 };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only and has no write mode (Feature 5 Step 2). No repetition recommendation is ever persisted by this codebase.');
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
    } else if (arg.startsWith('--adaptive-repetitions-used=')) {
      const raw = arg.slice('--adaptive-repetitions-used='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid --adaptive-repetitions-used value: "${raw}" (must be a non-negative integer)`);
      }
      flags.adaptiveRepetitionsUsed = n;
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

  if (result.history) {
    console.log(`\nHistorical cycles: ${result.history.totalCycles}`);
    console.log(`Clean cycles: ${result.history.cleanCycles}`);
    console.log(`Malformed cycles: ${result.history.malformedCycles}`);
  }

  if (result.policy) {
    console.log(`\nAdaptive repetitions used: ${result.policy.adaptiveRepetitionsUsed} / ${result.policy.maxAdaptiveRepetitionsPerInteraction}`);
  }

  console.log(`\nRepeat later: ${result.shouldRepeat ? 'YES' : 'NO'}`);
  console.log(`Reason: ${result.reason ?? '—'}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `repetition-recommendation-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This is a SOFTWARE recommendation that a target may benefit from one additional spaced revisit —');
  console.log('not a clinical prescription. The repetition cap is a pilot engineering safety rule.');

  const result = await evaluateRepetitionRecommendation({
    studentId: flags.studentId, letter: flags.letter, caseType: flags.caseType,
    adaptiveRepetitionsUsed: flags.adaptiveRepetitionsUsed,
  });
  printResult(flags, result);

  const report = {
    mode: 'read-only',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    studentId: flags.studentId,
    letter: flags.letter,
    caseType: flags.caseType,
    adaptiveRepetitionsUsed: flags.adaptiveRepetitionsUsed,
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
      console.error('Repetition recommendation report failed:', err.message);
      process.exit(1);
    });
}

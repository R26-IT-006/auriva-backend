'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunPersistentDifficulty.js
 *
 * Feature 7 Step 3 — READ-ONLY, student-wide persistent-difficulty report.
 *
 *   node src/scripts/dryRunPersistentDifficulty.js --student-id=13
 *
 * Only one flag — this script has no letter/caseType enumeration source of
 * its own; persistent-difficulty evaluation is inherently student-wide
 * across all six (caseType, family) streams at once (same convention as
 * dryRunDemoSpeedRecommendation.js / dryRunRepetitionRecommendation.js for
 * the flag-parsing shape, but narrower here since only studentId applies).
 *
 * There is no --apply mode: evaluatePersistentDifficulty() never writes to
 * the database — no persistent-difficulty history table exists yet (that
 * remains a future Step 4 decision). Passing --apply is a hard error.
 *
 * Output framing (Step 3 spec §58): this describes PERSISTENT EDUCATIONAL
 * HANDWRITING DIFFICULTY observed across separate software practice
 * periods — NOT a clinical diagnosis, NOT a motor-impairment
 * classification, NOT an ASD-severity judgment.
 */

const fs = require('fs');
const path = require('path');

const { evaluatePersistentDifficulty } = require('../services/persistentDifficultyService');

const CASE_TYPES = ['lowercase', 'uppercase'];
const FAMILIES = ['straight', 'curved', 'complex'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only (Feature 7 Step 3). No persistent-difficulty status is ever persisted by this codebase yet.');
    } else if (arg.startsWith('--student-id=')) {
      const raw = arg.slice('--student-id='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --student-id value: "${raw}" (must be a positive integer)`);
      }
      flags.studentId = n;
    }
  }
  if (flags.studentId == null) {
    throw new Error('--student-id is required, e.g. --student-id=13');
  }
  return flags;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function formatHours(separationMs) {
  if (separationMs == null) return '—';
  return `${(separationMs / (60 * 60 * 1000)).toFixed(1)}h`;
}

function printStream(family, stream) {
  console.log(`  ${family}:`);
  console.log(`    status: ${stream.status}`);
  console.log(`    reason: ${stream.reason}`);

  if (stream.status === 'persistent') {
    console.log('    PERSISTENT');
    console.log(`    Earlier window: ${stream.earlierWindow.successfulCycles}/${stream.windowSize} successful`);
    console.log(`    Recent window: ${stream.recentWindow.successfulCycles}/${stream.windowSize} successful`);
    console.log(`    Separation: ${formatHours(stream.separationMs)}`);
    console.log(`    Affected letters: ${stream.affectedLetters.map((l) => l.letter).join(', ') || '—'}`);
    return;
  }

  if (stream.reason === 'insufficient_cycles') {
    console.log(`    usable cycles: ${stream.usableCycleCount}`);
    return;
  }

  if (stream.reason === 'insufficient_temporal_dispersion') {
    console.log(`    separation: ${formatHours(stream.separationMs)} (required: ${formatHours(stream.requiredSeparationMs)})`);
    return;
  }

  // not_persistent (recent_improvement / recent_difficulty_not_yet_persistent / no_persistent_difficulty)
  console.log(`    Earlier window: ${stream.earlierWindow.successfulCycles}/${stream.windowSize} successful`);
  console.log(`    Recent window: ${stream.recentWindow.successfulCycles}/${stream.windowSize} successful`);
}

function printResult(flags, result) {
  console.log(`\nStudent: ${flags.studentId}`);

  if (result.status !== 'evaluated') {
    console.log(`\nstatus: ${result.status}`);
    return;
  }

  for (const caseType of CASE_TYPES) {
    console.log(`\n${caseType}:`);
    for (const family of FAMILIES) {
      printStream(family, result.streams[caseType][family]);
    }
  }

  const { persistentCount, notPersistentCount, insufficientDataCount, evaluatedStreamCount } = result.summary;
  console.log(`\nSummary: ${persistentCount} persistent, ${notPersistentCount} not persistent, ${insufficientDataCount} insufficient data (of ${evaluatedStreamCount} streams)`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `persistent-difficulty-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This describes PERSISTENT EDUCATIONAL HANDWRITING DIFFICULTY observed');
  console.log('across separate software practice periods — not a clinical diagnosis,');
  console.log('not a motor-impairment or ASD-severity classification.');

  const result = await evaluatePersistentDifficulty({ studentId: flags.studentId });
  printResult(flags, result);

  const report = {
    mode: 'read-only',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    studentId: flags.studentId,
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
      console.error('Persistent-difficulty report failed:', err.message);
      process.exit(1);
    });
}

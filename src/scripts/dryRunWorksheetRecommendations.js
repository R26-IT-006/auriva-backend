'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunWorksheetRecommendations.js
 *
 * Feature 8 Step 3 — READ-ONLY, student-wide worksheet-recommendation
 * report.
 *
 *   node src/scripts/dryRunWorksheetRecommendations.js --student-id=13
 *
 * Only one flag — worksheet recommendation is inherently student-wide
 * across all six (caseType, family) streams at once, same convention as
 * dryRunPersistentDifficulty.js.
 *
 * There is no --apply mode: evaluateWorksheetRecommendations() never
 * writes to the database — no worksheet-recommendation table exists yet
 * (Feature 8 remains computed on demand). Passing --apply is a hard error.
 *
 * Output framing (Step 3 spec §68): this describes a TEACHER-FACING
 * EDUCATIONAL HANDWRITING PRACTICE RECOMMENDATION, based on an
 * already-established Feature 7 persistent stream — NOT therapy, NOT
 * treatment, NOT a diagnosis, NOT a clinical intervention.
 */

const fs = require('fs');
const path = require('path');

const { evaluateWorksheetRecommendations } = require('../services/worksheetRecommendationService');

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      throw new Error('--apply is not supported: this script is read-only (Feature 8 Step 3). No worksheet recommendation is ever persisted by this codebase yet.');
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

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function printRecommendation(rec) {
  console.log(`\n${capitalize(rec.caseType)} — ${rec.title}`);
  console.log(`Focus letters: ${rec.focusLetters.join(', ') || '—'}`);
  console.log('\nWhy:');
  console.log(rec.rationale);
  console.log('\nSuggested activities:');
  for (const activity of rec.suggestedActivities) {
    console.log(`- ${activity}`);
  }
}

function printResult(flags, result) {
  console.log(`\nStudent: ${flags.studentId}`);

  if (result.status === 'read_failed') {
    console.log('\nUnable to evaluate worksheet recommendations.');
    return;
  }
  if (result.status !== 'evaluated') {
    console.log(`\nstatus: ${result.status}`);
    return;
  }

  console.log(`\nWorksheet recommendations: ${result.summary.recommendationCount}`);
  console.log(`\nPersistent streams: ${result.summary.persistentStreamCount}`);
  console.log(`Insufficient-data streams: ${result.summary.insufficientDataCount}`);
  console.log(`Not-persistent streams: ${result.summary.notPersistentCount}`);

  if (result.recommendations.length === 0) {
    console.log('\nNo persistent handwriting difficulty currently meets');
    console.log('the worksheet-recommendation criteria.');
    return;
  }

  for (const rec of result.recommendations) {
    printRecommendation(rec);
  }
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `worksheet-recommendations-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This is a TEACHER-FACING EDUCATIONAL HANDWRITING PRACTICE');
  console.log('RECOMMENDATION, based on an already-established Feature 7');
  console.log('persistent stream — not therapy, not treatment, not a diagnosis.');

  const result = await evaluateWorksheetRecommendations({ studentId: flags.studentId });
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
    .then((report) => {
      // A read failure is distinct from "zero recommendations" (Step 3
      // spec §48) — surfaced at the process-exit level too, not just in
      // the printed text, so calling scripts/CI can tell the difference.
      process.exit(report.result.status === 'read_failed' ? 1 : 0);
    })
    .catch((err) => {
      console.error('Worksheet recommendation report failed:', err.message);
      process.exit(1);
    });
}

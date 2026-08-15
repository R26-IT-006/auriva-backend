'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

/**
 * dryRunTeacherRecommendationValidationHistory.js
 *
 * Feature 9 Step 4 — READ-ONLY teacher-validation-history report.
 *
 *   node src/scripts/dryRunTeacherRecommendationValidationHistory.js --student-id=13
 *   node src/scripts/dryRunTeacherRecommendationValidationHistory.js --student-id=13 --case-type=lowercase --family=curved
 *
 * There is NO write mode. This script only ever calls
 * getTeacherValidationHistory() — Feature 9's write path
 * (validateWorksheetRecommendation) requires an authenticated teacher
 * identity (req.user.id) that no CLI context can legitimately provide
 * (Step 4 spec §40). --apply/--confirm/--dismiss/--write are all hard
 * errors, matching every prior feature's own read-only-CLI discipline
 * (dryRunPersistentDifficulty.js, dryRunWorksheetRecommendations.js) —
 * this script is simply not capable of writing at all, by construction.
 *
 * Output framing: this describes TEACHER JUDGEMENT about an educational
 * handwriting practice recommendation — never clinical validation,
 * diagnosis confirmation, or treatment approval.
 */

const fs = require('fs');
const path = require('path');

const { getTeacherValidationHistory } = require('../services/teacherRecommendationValidationService');

const CASE_TYPES = ['lowercase', 'uppercase'];
const FAMILIES = ['straight', 'curved', 'complex'];
const VALIDATION_LABELS = { confirmed: 'Confirmed', dismissed: 'Not suitable' };
const REJECTED_FLAGS = ['--apply', '--confirm', '--dismiss', '--write'];

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { studentId: null, caseType: undefined, family: undefined };

  for (const arg of argv) {
    if (REJECTED_FLAGS.includes(arg)) {
      throw new Error(`${arg} is not supported: this script is read-only (Feature 9 Step 4). There is no write CLI for teacher validation — it requires an authenticated teacher identity no script can legitimately provide.`);
    } else if (arg.startsWith('--student-id=')) {
      const raw = arg.slice('--student-id='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --student-id value: "${raw}" (must be a positive integer)`);
      }
      flags.studentId = n;
    } else if (arg.startsWith('--case-type=')) {
      const value = arg.slice('--case-type='.length);
      if (!CASE_TYPES.includes(value)) {
        throw new Error(`Invalid --case-type value: "${value}" (must be one of: ${CASE_TYPES.join(', ')})`);
      }
      flags.caseType = value;
    } else if (arg.startsWith('--family=')) {
      const value = arg.slice('--family='.length);
      if (!FAMILIES.includes(value)) {
        throw new Error(`Invalid --family value: "${value}" (must be one of: ${FAMILIES.join(', ')})`);
      }
      flags.family = value;
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

function formatDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown date';
  const day = date.getUTCDate();
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const year = date.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function printEvent(event, index) {
  console.log(`\n${index + 1}. ${capitalize(event.caseType)} — ${event.recommendation.title}`);
  console.log(`   Validation: ${VALIDATION_LABELS[event.validation] || event.validation}`);
  console.log(`   Validated: ${formatDate(event.validatedAt)}`);
  if (event.teacherNote) {
    console.log(`   Note: ${event.teacherNote}`);
  }
}

function printResult(flags, result) {
  console.log(`\nStudent: ${flags.studentId}`);

  if (result.status === 'read_failed') {
    console.log('\nUnable to read teacher validation history.');
    return;
  }
  if (result.status !== 'evaluated') {
    console.log(`\nstatus: ${result.status}`);
    return;
  }

  console.log(`Teacher validation history: ${result.events.length}`);

  if (result.events.length === 0) {
    console.log('\nNo teacher recommendation validations recorded.');
    return;
  }

  result.events.forEach((event, index) => printEvent(event, index));
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `teacher-recommendation-validation-history-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function run(flags) {
  const startedAt = new Date();

  console.log('MODE: READ-ONLY (no write mode exists for this script)');
  console.log('This describes TEACHER JUDGEMENT about an educational');
  console.log('handwriting practice recommendation — not clinical validation,');
  console.log('diagnosis confirmation, or treatment approval.');

  const result = await getTeacherValidationHistory({
    studentId: flags.studentId, caseType: flags.caseType, family: flags.family,
  });
  printResult(flags, result);

  const report = {
    mode: 'read-only',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    studentId: flags.studentId,
    caseType: flags.caseType ?? null,
    family: flags.family ?? null,
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
      process.exit(report.result.status === 'read_failed' ? 1 : 0);
    })
    .catch((err) => {
      console.error('Teacher validation history report failed:', err.message);
      process.exit(1);
    });
}

'use strict';

// backfillLetterTrajectoryFeatures.js
//
// ML readiness pass (Part 10): backfills total_distance/avg_speed/
// speed_mean/speed_std/speed_cv/pause-extras for ALREADY-COLLECTED
// letter_attempts rows, by re-running the exact same production
// normalizeLetterFeatures() (src/utils/featureNormalization.js) against
// each row's own stored `features` + `stroke_points`, and merging in ONLY
// the fields that are currently null — see
// scripts/lib/normalizedFeaturesBackfill.js for the full rationale
// (it also fixes a small number of legacy rows whose normalized_features
// was stored entirely null, not just missing total_distance/avg_speed).
//
// DRY RUN BY DEFAULT — matches this repo's existing backfill convention
// (see src/scripts/backfillMotorBaselines.js). Only --apply performs real
// writes. --dry-run is also accepted explicitly (a no-op synonym for the
// default) so it can always be passed without checking which mode is
// currently the default.
//
//   node scripts/backfillLetterTrajectoryFeatures.js                 # dry run, all letter_attempts
//   node scripts/backfillLetterTrajectoryFeatures.js --dry-run        # same, explicit
//   node scripts/backfillLetterTrajectoryFeatures.js --limit=50       # dry run, first 50 rows
//   node scripts/backfillLetterTrajectoryFeatures.js --student-id=10  # dry run, one student
//   node scripts/backfillLetterTrajectoryFeatures.js --apply                  # real write, all rows
//   node scripts/backfillLetterTrajectoryFeatures.js --apply --student-id=10  # real write, one student
//
// Never touches: raw `features`, raw `stroke_points`, `passed`,
// `best_score`, `threshold`, `threshold_passed`, `support_level`,
// `stroke_order_matches_template`, or any other column — only
// `normalized_features`, `feature_validity`, and (only when currently
// null) `motor_score`/`quality_score`/`score_version` can ever be written
// by this script. Never touches HandwritingAssessment, StudentMotorBaseline,
// StudentMotorFeature, LetterProgress, or any threshold table.
//
// Rows are processed sequentially (not Promise.all) — one row's failure
// must never abort another row's successful update, and sequential logs
// stay easy to audit (same rationale as backfillMotorBaselines.js).

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const { LetterAttempt } = require('../src/models');
const { normalizeLetterFeatures } = require('../src/utils/featureNormalization');
const { planRowUpdate } = require('./lib/normalizedFeaturesBackfill');
const logger = require('../src/utils/logger');

// ─── CLI argument parsing ───────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { apply: false, studentId: null, limit: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      flags.apply = true;
    } else if (arg === '--dry-run') {
      // Explicit no-op — dry run is already the default; accepted so the
      // documented example command above always works verbatim.
    } else if (arg.startsWith('--student-id=')) {
      const raw = arg.slice('--student-id='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --student-id value: "${raw}" (must be a positive integer)`);
      }
      flags.studentId = n;
    } else if (arg.startsWith('--limit=')) {
      const raw = arg.slice('--limit='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --limit value: "${raw}" (must be a positive integer)`);
      }
      flags.limit = n;
    }
    // Unknown flags are ignored rather than rejected — keeps the CLI simple.
  }
  return flags;
}

// ─── Per-row processing ──────────────────────────────────────────────────────

/**
 * Read-only: computes what would happen for one row. Used directly for
 * dry-run reporting, and as the first half of apply-mode processing.
 */
function evaluateRow(row) {
  const plan = planRowUpdate({
    rawFeatures:              row.features,
    strokePoints:             row.stroke_points,
    storedNormalizedFeatures: row.normalized_features,
    storedMotorScore:         row.motor_score,
    normalizeFn:              normalizeLetterFeatures,
  });

  let status;
  if (plan.changedFields.length > 0) {
    status = 'WOULD_UPDATE';
  } else if (plan.isMalformedTrajectory) {
    status = 'SKIPPED_MALFORMED_TRAJECTORY';
  } else {
    status = 'SKIPPED_ALREADY_COMPLETE';
  }

  return {
    id: row.id,
    studentId: row.student_id,
    letter: row.letter,
    caseType: row.case_type,
    status,
    changedFields: plan.changedFields,
    motorScoreWouldChange: plan.motorScoreChanged,
    plan,
  };
}

async function processRow(row, { apply }) {
  const evalResult = evaluateRow(row);
  if (evalResult.status !== 'WOULD_UPDATE') {
    const { plan, ...rest } = evalResult; // eslint-disable-line no-unused-vars
    return rest;
  }

  const { plan, ...rest } = evalResult; // eslint-disable-line no-unused-vars
  if (!apply) return rest;

  try {
    const updates = { normalized_features: plan.mergedNormalizedFeatures };
    if (plan.mergedFeatureValidity) updates.feature_validity = plan.mergedFeatureValidity;
    if (plan.motorScoreChanged) {
      updates.motor_score   = plan.newMotorScore;
      updates.quality_score = plan.newQualityScore;
      updates.score_version = plan.newScoreVersion;
    }
    await row.update(updates);
    return { ...rest, status: 'UPDATED' };
  } catch (err) {
    logger.error('Letter trajectory backfill: row update failed', { id: row.id, errorMessage: err.message });
    return { ...rest, status: 'FAILED', reason: err.message };
  }
}

// ─── Summary / reporting ─────────────────────────────────────────────────────

function buildSummary(results) {
  const counts = {
    recordsScanned:            results.length,
    recordsEligible:           0, // not malformed — a real update attempt was possible
    recordsSkippedComplete:    0,
    recordsMalformed:          0,
    recordsWouldUpdate:        0, // dry run
    recordsUpdated:            0, // apply
    recordsFailed:             0,
  };
  for (const r of results) {
    switch (r.status) {
      case 'WOULD_UPDATE':                  counts.recordsEligible++; counts.recordsWouldUpdate++; break;
      case 'UPDATED':                       counts.recordsEligible++; counts.recordsUpdated++; break;
      case 'SKIPPED_ALREADY_COMPLETE':      counts.recordsEligible++; counts.recordsSkippedComplete++; break;
      case 'SKIPPED_MALFORMED_TRAJECTORY':  counts.recordsMalformed++; break;
      case 'FAILED':                        counts.recordsEligible++; counts.recordsFailed++; break;
      default: break;
    }
  }
  return counts;
}

function printSummary(counts, applyMode) {
  console.log('\nLetter Trajectory Feature Backfill Summary\n');
  console.log(`Mode: ${applyMode ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`records scanned:                  ${counts.recordsScanned}`);
  console.log(`records eligible:                 ${counts.recordsEligible}`);
  console.log(`records skipped (already complete): ${counts.recordsSkippedComplete}`);
  console.log(`records with malformed trajectories: ${counts.recordsMalformed}`);
  if (applyMode) {
    console.log(`records updated:                  ${counts.recordsUpdated}`);
  } else {
    console.log(`records that would be updated:    ${counts.recordsWouldUpdate}`);
  }
  console.log(`records failed:                   ${counts.recordsFailed}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// Written under logs/ — already gitignored (see backfillMotorBaselines.js's
// matching comment). Contains only IDs/letters/case types/statuses/changed
// field NAMES (never values) — no raw trajectories, no student names.
function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `letter-feature-backfill-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function runBackfill(flags) {
  const startedAt = new Date();

  console.log(`MODE: ${flags.apply ? 'APPLY' : 'DRY RUN'}`);
  if (flags.apply) {
    console.log('Eligible letter_attempts rows WILL have normalized_features/feature_validity');
    console.log('(and motor_score/quality_score/score_version, only if currently null) updated.');
    console.log('Raw features/stroke_points and every other column are never modified.');
  } else {
    console.log('No database writes will be performed.');
  }

  const where = flags.studentId != null ? { student_id: flags.studentId } : undefined;
  let rows;
  try {
    rows = await LetterAttempt.findAll({ where, order: [['id', 'ASC']] });
  } catch (err) {
    logger.error('Letter trajectory backfill: failed to enumerate letter_attempts', { errorMessage: err.message });
    throw err;
  }
  if (flags.limit != null) rows = rows.slice(0, flags.limit);

  const results = [];
  for (const row of rows) {
    const r = await processRow(row, { apply: flags.apply });
    results.push(r);
    console.log(`letter_attempts#${r.id} (student ${r.studentId}, ${r.letter}/${r.caseType}) -> ${r.status}` +
      (r.changedFields.length ? ` [${r.changedFields.join(', ')}]` : ''));
  }

  const finishedAt = new Date();
  const summary = buildSummary(results);
  printSummary(summary, flags.apply);

  const report = {
    mode:       flags.apply ? 'apply' : 'dry-run',
    startedAt:  startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    summary,
    results,
  };

  try {
    const reportPath = writeReport(report, startedAt);
    console.log(`\nReport written to: ${reportPath}`);
  } catch (err) {
    console.error(`\nWARNING: failed to write report file: ${err.message}`);
    logger.error('Letter trajectory backfill: report write failed', { errorMessage: err.message });
  }

  return report;
}

module.exports = { parseArgs, evaluateRow, processRow, buildSummary, runBackfill };

if (require.main === module) {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  runBackfill(flags)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Letter trajectory feature backfill failed:', err.message);
      process.exit(1);
    });
}

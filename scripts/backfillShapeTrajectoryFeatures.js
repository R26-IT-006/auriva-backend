'use strict';

// backfillShapeTrajectoryFeatures.js
//
// ML readiness pass (Part 11 — "for consistency, ensure shapes can expose
// speed_std/speed_cv/pause_frequency/pause_duration_ratio... if existing
// shape records can be safely backfilled from stroke_points, include them
// in a separate ... backfill process"). This is that separate process —
// same shared core as scripts/backfillLetterTrajectoryFeatures.js
// (scripts/lib/normalizedFeaturesBackfill.js), applied to shape_features
// instead of letter_attempts.
//
// Shapes already send total_distance/avg_speed from the frontend for
// 'initial_assessment' rows, so this backfill's most common effect there is
// filling the brand-new speed_std/speed_cv/pause-extras fields only.
// However, inspecting the live dataset before writing this script found
// two things this script also legitimately fixes, using the SAME
// "never overwrite an existing value" merge rule:
//   - 'pre_writing_warmup' rows never send total_distance/avg_speed at all
//     (see submitPreWritingActivity() in handwritingController.js) — those
//     ARE genuinely missing and get derived from stroke_points here.
//   - a small number of early rows have normalized_features stored
//     entirely NULL despite complete raw features/stroke_points — a
//     pipeline gap from before ML normalization existed, not an
//     "N/A" case (see Part 15). These get fully recomputed via the same
//     production normalizeShapeFeatures(), same as the letter script.
//
// Does NOT touch, and cannot touch: accuracy (geometric, shape-specific —
// not derivable from stroke_points by this pipeline), dtw_distance
// (zigzag/curve_wave — also not recomputed here, only passed through),
// smoothness, motor profile, baseline, or any threshold. Only
// normalized_features/feature_validity/(motor_score/quality_score/
// score_version, only if currently null) can ever be written.
//
// DRY RUN BY DEFAULT — see backfillLetterTrajectoryFeatures.js's matching
// header comment; the CLI surface is identical, table name aside.
//
//   node scripts/backfillShapeTrajectoryFeatures.js
//   node scripts/backfillShapeTrajectoryFeatures.js --dry-run
//   node scripts/backfillShapeTrajectoryFeatures.js --limit=50
//   node scripts/backfillShapeTrajectoryFeatures.js --student-id=10
//   node scripts/backfillShapeTrajectoryFeatures.js --apply
//   node scripts/backfillShapeTrajectoryFeatures.js --apply --student-id=10

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const { ShapeFeature } = require('../src/models');
const { normalizeShapeFeatures } = require('../src/utils/featureNormalization');
const { planRowUpdate } = require('./lib/normalizedFeaturesBackfill');
const logger = require('../src/utils/logger');

// ─── CLI argument parsing (identical contract to the letter script) ───────

function parseArgs(argv) {
  const flags = { apply: false, studentId: null, limit: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      flags.apply = true;
    } else if (arg === '--dry-run') {
      // Explicit no-op — dry run is already the default.
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
  }
  return flags;
}

// ─── Per-row processing ──────────────────────────────────────────────────────

function evaluateRow(row) {
  const plan = planRowUpdate({
    rawFeatures:              row.features,
    strokePoints:             row.stroke_points,
    storedNormalizedFeatures: row.normalized_features,
    storedMotorScore:         row.motor_score,
    normalizeFn:              normalizeShapeFeatures,
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
    source: row.source,
    shapeType: row.shape_type,
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
    logger.error('Shape trajectory backfill: row update failed', { id: row.id, errorMessage: err.message });
    return { ...rest, status: 'FAILED', reason: err.message };
  }
}

// ─── Summary / reporting ─────────────────────────────────────────────────────

function buildSummary(results) {
  const counts = {
    recordsScanned:         results.length,
    recordsEligible:        0,
    recordsSkippedComplete: 0,
    recordsMalformed:       0,
    recordsWouldUpdate:     0,
    recordsUpdated:         0,
    recordsFailed:          0,
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
  console.log('\nShape Trajectory Feature Backfill Summary\n');
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

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `shape-feature-backfill-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function runBackfill(flags) {
  const startedAt = new Date();

  console.log(`MODE: ${flags.apply ? 'APPLY' : 'DRY RUN'}`);
  if (flags.apply) {
    console.log('Eligible shape_features rows WILL have normalized_features/feature_validity');
    console.log('(and motor_score/quality_score/score_version, only if currently null) updated.');
    console.log('Raw features/stroke_points and every other column are never modified.');
  } else {
    console.log('No database writes will be performed.');
  }

  const where = flags.studentId != null ? { student_id: flags.studentId } : undefined;
  let rows;
  try {
    rows = await ShapeFeature.findAll({ where, order: [['id', 'ASC']] });
  } catch (err) {
    logger.error('Shape trajectory backfill: failed to enumerate shape_features', { errorMessage: err.message });
    throw err;
  }
  if (flags.limit != null) rows = rows.slice(0, flags.limit);

  const results = [];
  for (const row of rows) {
    const r = await processRow(row, { apply: flags.apply });
    results.push(r);
    console.log(`shape_features#${r.id} (student ${r.studentId}, ${r.source}/${r.shapeType}) -> ${r.status}` +
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
    logger.error('Shape trajectory backfill: report write failed', { errorMessage: err.message });
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
      console.error('Shape trajectory feature backfill failed:', err.message);
      process.exit(1);
    });
}

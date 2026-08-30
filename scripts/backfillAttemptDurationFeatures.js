'use strict';

// backfillAttemptDurationFeatures.js
//
// Duration-correction pass (Part 10): backfills attempt_duration_ms/
// attempt_avg_speed/attempt_pause_frequency/attempt_pause_duration_ratio —
// the tAbs-derived, ML-safe counterparts to the legacy (stroke-local-`t`-
// based, multi-stroke-undercounting) duration_ms/avg_speed/pause_frequency/
// pause_duration_ratio — for ALREADY-COLLECTED rows in BOTH shape_features
// and letter_attempts.
//
// Reuses the exact same safe, tested merge core as
// scripts/backfillLetterTrajectoryFeatures.js / backfillShapeTrajectoryFeatures.js
// (scripts/lib/normalizedFeaturesBackfill.js -> planRowUpdate()), which
// already recomputes the FULL normalized_features object via the production
// normalizeShapeFeatures()/normalizeLetterFeatures() (now including the
// attempt_* derivation added in src/utils/featureNormalization.js) and
// merges in ONLY currently-null fields. This script adds one thing on top:
// a tAbs-specific DIAGNOSIS per row (Part 11), so the dry-run report can
// distinguish exactly why a row can't get a corrected duration —
// no trajectory at all, points present but no tAbs, only one valid
// timestamp, or a degenerate max<=min ordering — rather than lumping every
// non-update into one generic "malformed" bucket.
//
// DRY RUN BY DEFAULT — matches this repo's existing backfill convention.
// Only --apply performs real writes. --dry-run is also accepted explicitly.
//
//   node scripts/backfillAttemptDurationFeatures.js
//   node scripts/backfillAttemptDurationFeatures.js --dry-run
//   node scripts/backfillAttemptDurationFeatures.js --limit=50
//   node scripts/backfillAttemptDurationFeatures.js --student-id=10
//   node scripts/backfillAttemptDurationFeatures.js --apply
//   node scripts/backfillAttemptDurationFeatures.js --apply --student-id=10
//
// Never touches: raw `features`, raw `stroke_points`, DTW, smoothness,
// `passed`/`best_score`/`threshold`/`threshold_passed`, motor profile, or
// baseline — only `normalized_features`, `feature_validity`, and (only
// when currently null) `motor_score`/`quality_score`/`score_version` can
// ever be written, exactly like the other two backfill scripts.

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');

const { LetterAttempt, ShapeFeature } = require('../src/models');
const { normalizeShapeFeatures, normalizeLetterFeatures } = require('../src/utils/featureNormalization');
const { toStrokeArrays } = require('../src/utils/trajectoryFeatures');
const { planRowUpdate } = require('./lib/normalizedFeaturesBackfill');
const logger = require('../src/utils/logger');

// ─── CLI argument parsing (identical contract to the other two scripts) ───

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

// ─── tAbs diagnosis (Part 11) ───────────────────────────────────────────────

// Distinguishes exactly why a row can/can't get a tAbs-derived
// attempt_duration_ms — independent of, and in addition to, planRowUpdate's
// general "is this trajectory malformed at all" check.
//   NO_TRAJECTORY          — stroke_points null/empty/every stroke empty
//   MISSING_TABS            — points exist, but none carry a finite tAbs
//   INSUFFICIENT_TIMESTAMPS — fewer than 2 points have a valid tAbs
//   INVALID_ORDERING        — >= 2 valid tAbs, but max <= min (degenerate)
//   VALID                   — a real attempt_duration_ms can be derived
function classifyTabsStatus(strokePoints) {
  const strokes = toStrokeArrays(strokePoints);
  const totalPoints = strokes.reduce((n, s) => n + (Array.isArray(s) ? s.length : 0), 0);
  if (totalPoints === 0) return 'NO_TRAJECTORY';

  let validCount = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke) {
      const tAbs = point?.tAbs;
      if (!Number.isFinite(tAbs)) continue;
      validCount += 1;
      if (tAbs < min) min = tAbs;
      if (tAbs > max) max = tAbs;
    }
  }

  if (validCount === 0) return 'MISSING_TABS';
  if (validCount === 1) return 'INSUFFICIENT_TIMESTAMPS';
  if (max <= min) return 'INVALID_ORDERING';
  return 'VALID';
}

// ─── Per-row processing ──────────────────────────────────────────────────────

function evaluateRow(row, sampleType) {
  const normalizeFn = sampleType === 'shape' ? normalizeShapeFeatures : normalizeLetterFeatures;
  const tabsStatus = classifyTabsStatus(row.stroke_points);

  const plan = planRowUpdate({
    rawFeatures:              row.features,
    strokePoints:             row.stroke_points,
    storedNormalizedFeatures: row.normalized_features,
    storedMotorScore:         row.motor_score,
    normalizeFn,
  });

  let status;
  if (plan.changedFields.length > 0) {
    status = 'WOULD_UPDATE';
  } else if (tabsStatus !== 'VALID') {
    status = 'SKIPPED_TABS_' + tabsStatus; // e.g. SKIPPED_TABS_MISSING_TABS
  } else {
    status = 'SKIPPED_ALREADY_COMPLETE';
  }

  return {
    id: row.id,
    sampleType,
    studentId: row.student_id,
    label: sampleType === 'shape' ? `${row.source}/${row.shape_type}` : `${row.letter}/${row.case_type}`,
    tabsStatus,
    status,
    changedFields: plan.changedFields,
    attemptDurationWouldBeSet: plan.changedFields.includes('attempt_duration_ms'),
    motorScoreWouldChange: plan.motorScoreChanged,
    plan,
  };
}

async function processRow(row, sampleType, { apply }) {
  const evalResult = evaluateRow(row, sampleType);
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
    logger.error('Attempt duration backfill: row update failed', { id: row.id, sampleType, errorMessage: err.message });
    return { ...rest, status: 'FAILED', reason: err.message };
  }
}

// ─── Summary / reporting ─────────────────────────────────────────────────────

function buildSummary(results) {
  const counts = {
    recordsScanned:              results.length,
    recordsEligible:             0, // has a real trajectory to look at (not NO_TRAJECTORY)
    recordsWithValidTabs:        0,
    recordsMissingTabs:          0, // NO_TRAJECTORY + MISSING_TABS + INSUFFICIENT_TIMESTAMPS + INVALID_ORDERING
    recordsMalformed:            0, // NO_TRAJECTORY specifically — no trajectory captured at all
    recordsWouldUpdate:          0,
    recordsUpdated:              0,
    recordsSkippedAlreadyComplete: 0,
    recordsFailed:                0,
    byTabsReason: { NO_TRAJECTORY: 0, MISSING_TABS: 0, INSUFFICIENT_TIMESTAMPS: 0, INVALID_ORDERING: 0, VALID: 0 },
  };
  for (const r of results) {
    counts.byTabsReason[r.tabsStatus] = (counts.byTabsReason[r.tabsStatus] ?? 0) + 1;
    if (r.tabsStatus === 'VALID') counts.recordsWithValidTabs++;
    else counts.recordsMissingTabs++;
    if (r.tabsStatus === 'NO_TRAJECTORY') counts.recordsMalformed++;
    else counts.recordsEligible++;

    switch (r.status) {
      case 'WOULD_UPDATE':             counts.recordsWouldUpdate++; break;
      case 'UPDATED':                  counts.recordsUpdated++; break;
      case 'SKIPPED_ALREADY_COMPLETE': counts.recordsSkippedAlreadyComplete++; break;
      case 'FAILED':                   counts.recordsFailed++; break;
      default: break; // SKIPPED_TABS_* — already reflected in recordsMissingTabs above
    }
  }
  return counts;
}

function printSummary(counts, applyMode) {
  console.log('\nAttempt Duration Feature Backfill Summary\n');
  console.log(`Mode: ${applyMode ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`records scanned:            ${counts.recordsScanned}`);
  console.log(`records eligible:           ${counts.recordsEligible}`);
  console.log(`records with valid tAbs:    ${counts.recordsWithValidTabs}`);
  console.log(`records missing tAbs:       ${counts.recordsMissingTabs}`);
  console.log(`  - no trajectory at all:          ${counts.byTabsReason.NO_TRAJECTORY}`);
  console.log(`  - points present, no tAbs:       ${counts.byTabsReason.MISSING_TABS}`);
  console.log(`  - only one valid timestamp:      ${counts.byTabsReason.INSUFFICIENT_TIMESTAMPS}`);
  console.log(`  - invalid ordering (max<=min):   ${counts.byTabsReason.INVALID_ORDERING}`);
  console.log(`records malformed (no trajectory): ${counts.recordsMalformed}`);
  if (applyMode) {
    console.log(`records updated:            ${counts.recordsUpdated}`);
  } else {
    console.log(`records that would be updated: ${counts.recordsWouldUpdate}`);
  }
  console.log(`records already complete:   ${counts.recordsSkippedAlreadyComplete}`);
  console.log(`records failed:             ${counts.recordsFailed}`);
}

function timestampForFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(report, when) {
  const dir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `attempt-duration-backfill-${timestampForFilename(when)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function runBackfill(flags) {
  const startedAt = new Date();

  console.log(`MODE: ${flags.apply ? 'APPLY' : 'DRY RUN'}`);
  if (flags.apply) {
    console.log('Eligible shape_features/letter_attempts rows WILL have normalized_features/');
    console.log('feature_validity (and motor_score/quality_score/score_version, only if');
    console.log('currently null) updated. Raw features/stroke_points are never modified.');
  } else {
    console.log('No database writes will be performed.');
  }

  const where = flags.studentId != null ? { student_id: flags.studentId } : undefined;
  let shapeRows, letterRows;
  try {
    [shapeRows, letterRows] = await Promise.all([
      ShapeFeature.findAll({ where, order: [['id', 'ASC']] }),
      LetterAttempt.findAll({ where, order: [['id', 'ASC']] }),
    ]);
  } catch (err) {
    logger.error('Attempt duration backfill: failed to enumerate rows', { errorMessage: err.message });
    throw err;
  }

  let taggedRows = [
    ...shapeRows.map(row => ({ row, sampleType: 'shape' })),
    ...letterRows.map(row => ({ row, sampleType: 'letter' })),
  ];
  if (flags.limit != null) taggedRows = taggedRows.slice(0, flags.limit);

  const results = [];
  for (const { row, sampleType } of taggedRows) {
    const r = await processRow(row, sampleType, { apply: flags.apply });
    results.push(r);
    console.log(`${sampleType}#${r.id} (student ${r.studentId}, ${r.label}) tabs=${r.tabsStatus} -> ${r.status}` +
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
    logger.error('Attempt duration backfill: report write failed', { errorMessage: err.message });
  }

  return report;
}

module.exports = { parseArgs, classifyTabsStatus, evaluateRow, processRow, buildSummary, runBackfill };

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
      console.error('Attempt duration feature backfill failed:', err.message);
      process.exit(1);
    });
}

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize, PronunciationSessionResult, Student } = require('../src/models');
const {
  LAYER1_CONFIDENT_ACCEPT_SCORE,
} = require('../src/services/pronunciationAnalysisService');

// Step 1 of the Layer-1 improvement plan: measure before changing anything.
// Answers the three questions the rest of the plan branches on:
//   1. How often does the DTW gate actually fire (dtw_only_accept)?
//   2. What do segmental_accuracy and dtw_distance look like, overall and
//      per population (Student.disability)?
//   3. On teacher-reviewed rows, does Layer 1 agree with the teacher — and
//      what would a recalibrated gate threshold do to false accepts?
//
// Read-only. Pass --backfill to copy layer1_decision / dtw_distance from the
// recommendation_details JSONB into the new columns on historical rows.
// Pass --json to also print a machine-readable summary.

const WANT_BACKFILL = process.argv.includes('--backfill');
const WANT_JSON = process.argv.includes('--json');

// A teacher_reviewed_score at or above this counts the attempt as a
// genuinely-correct pronunciation for gate confusion analysis. Override with
// LAYER1_CORRECT_THRESHOLD.
const CORRECT_THRESHOLD = Number(process.env.LAYER1_CORRECT_THRESHOLD) || 70;

// The three columns are added to the table by sequelize.sync({ alter }) on
// normal server boot (index.js). When this report is run standalone before
// the server has booted with the new model, add them here so the script is
// self-sufficient. Idempotent — skips columns that already exist.
async function ensureLayer1Columns() {
  const qi = sequelize.getQueryInterface();
  const table = await qi.describeTable('pronunciation_session_results');
  const { DataTypes } = require('sequelize');
  const wanted = {
    segmental_accuracy: { type: DataTypes.INTEGER, allowNull: true },
    dtw_distance: { type: DataTypes.FLOAT, allowNull: true },
    layer1_decision: { type: DataTypes.STRING, allowNull: true },
  };
  for (const [name, spec] of Object.entries(wanted)) {
    if (!table[name]) {
      await qi.addColumn('pronunciation_session_results', name, spec);
      console.log(`  added missing column: ${name}`);
    }
  }
}

function normalizePopulation(value) {
  const tag = String(value || '').trim().toLowerCase();
  return tag || '(unspecified)';
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedValues[base + 1];
  if (next === undefined) return sortedValues[base];
  return sortedValues[base] + rest * (next - sortedValues[base]);
}

function describe(values) {
  const nums = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!nums.length) return null;
  const sum = nums.reduce((t, v) => t + v, 0);
  return {
    n: nums.length,
    min: nums[0],
    p10: quantile(nums, 0.1),
    p25: quantile(nums, 0.25),
    median: quantile(nums, 0.5),
    p75: quantile(nums, 0.75),
    p90: quantile(nums, 0.9),
    max: nums[nums.length - 1],
    mean: sum / nums.length,
  };
}

function pearson(pairs) {
  const clean = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const n = clean.length;
  if (n < 3) return null;
  const meanA = clean.reduce((t, [a]) => t + a, 0) / n;
  const meanB = clean.reduce((t, [, b]) => t + b, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  clean.forEach(([a, b]) => {
    const da = a - meanA;
    const db = b - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  });
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '  n/a';
  return value.toFixed(digits).padStart(6);
}

function pct(part, whole) {
  if (!whole) return '  n/a';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function histogram(values, bucketSize = 10, lo = 0, hi = 100) {
  const buckets = [];
  for (let start = lo; start < hi; start += bucketSize) {
    const end = start + bucketSize;
    const count = values.filter((v) => v >= start && (v < end || (end === hi && v === hi))).length;
    buckets.push({ range: `${start}-${end}`, count });
  }
  return buckets;
}

function printHistogram(title, buckets, total) {
  console.log(`  ${title}`);
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  buckets.forEach((b) => {
    const bar = '#'.repeat(Math.round((b.count / maxCount) * 40));
    console.log(`    ${b.range.padStart(7)} | ${String(b.count).padStart(5)} ${pct(b.count, total).padStart(7)} ${bar}`);
  });
}

async function backfillFromJsonb(rows) {
  let updated = 0;
  for (const row of rows) {
    const evidence = row.recommendation_details && row.recommendation_details.scoring_evidence;
    if (!evidence) continue;
    const patch = {};
    if (row.layer1_decision == null && evidence.layer1_decision != null) {
      patch.layer1_decision = evidence.layer1_decision;
    }
    if (row.dtw_distance == null && typeof evidence.dtw_distance === 'number') {
      patch.dtw_distance = evidence.dtw_distance;
    }
    // segmental_accuracy is only recoverable when Layer 1 was NOT escalated —
    // then the pre-blend DTW score equals the stored overall_score.
    if (
      row.segmental_accuracy == null &&
      (patch.layer1_decision === 'dtw_only_accept' || row.layer1_decision === 'dtw_only_accept')
    ) {
      patch.segmental_accuracy = row.overall_score;
    }
    if (Object.keys(patch).length) {
      await PronunciationSessionResult.update(patch, { where: { id: row.id } });
      Object.assign(row, patch);
      updated += 1;
    }
  }
  console.log(`Backfill: updated ${updated} historical row(s) from recommendation_details JSONB.\n`);
}

async function main() {
  await sequelize.authenticate();
  await ensureLayer1Columns();

  const rows = (await PronunciationSessionResult.findAll({
    attributes: { exclude: ['raw_audio_data'] },
    include: [{ model: Student, as: 'student', attributes: ['disability'] }],
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  })).map((r) => r.get({ plain: true }));

  console.log('='.repeat(72));
  console.log('LAYER 1 (MFCC-DTW) INSTRUMENTATION REPORT');
  console.log(`generated ${new Date().toISOString()}`);
  console.log(`total pronunciation_session_results rows: ${rows.length}`);
  console.log('='.repeat(72));

  if (WANT_BACKFILL) await backfillFromJsonb(rows);

  // A row "ran Layer 1" if it carries a gate decision.
  const layer1Rows = rows.filter((r) => r.layer1_decision === 'dtw_only_accept' || r.layer1_decision === 'escalated_to_gop');
  const noInstrumentation = rows.filter((r) => r.layer1_decision == null);

  console.log(`\nrows with a Layer-1 gate decision: ${layer1Rows.length}`);
  console.log(`rows without one (reference-free GOP, prototype fallback, or pre-instrumentation): ${noInstrumentation.length}`);
  if (WANT_BACKFILL === false && noInstrumentation.length) {
    console.log('  (re-run with --backfill to recover layer1_decision / dtw_distance from JSONB on older rows)');
  }

  if (!layer1Rows.length) {
    console.log('\nNo Layer-1 rows to analyze yet. Collect attempts, then re-run.');
    await sequelize.close();
    return;
  }

  // ---- 1. Gate hit rate ---------------------------------------------------
  const accepts = layer1Rows.filter((r) => r.layer1_decision === 'dtw_only_accept');
  const escalations = layer1Rows.filter((r) => r.layer1_decision === 'escalated_to_gop');
  console.log('\n' + '-'.repeat(72));
  console.log('1. GATE HIT RATE');
  console.log('-'.repeat(72));
  console.log(`  dtw_only_accept  : ${String(accepts.length).padStart(5)}  ${pct(accepts.length, layer1Rows.length)}`);
  console.log(`  escalated_to_gop : ${String(escalations.length).padStart(5)}  ${pct(escalations.length, layer1Rows.length)}`);
  console.log(`  gate threshold (LAYER1_CONFIDENT_ACCEPT_SCORE) = ${LAYER1_CONFIDENT_ACCEPT_SCORE}`);
  if (accepts.length / layer1Rows.length < 0.1) {
    console.log('  NOTE: gate fires <10% of the time — Layer 1 is mostly just the 0.3');
    console.log('        blend weight. Weigh demoting it vs investing in calibration.');
  }

  // ---- 2. Distributions -------------------------------------------------
  const segValues = layer1Rows.map((r) => r.segmental_accuracy).filter(Number.isFinite);
  const dtwValues = layer1Rows.map((r) => r.dtw_distance).filter(Number.isFinite);
  console.log('\n' + '-'.repeat(72));
  console.log('2. DISTRIBUTIONS');
  console.log('-'.repeat(72));
  const segStats = describe(segValues);
  const dtwStats = describe(dtwValues);
  console.log('  segmental_accuracy   n   min  p10  p25  med  p75  p90  max  mean');
  if (segStats) {
    console.log(`    ${String(segStats.n).padStart(19)} ${fmt(segStats.min, 0)} ${fmt(segStats.p10, 0)} ${fmt(segStats.p25, 0)} ${fmt(segStats.median, 0)} ${fmt(segStats.p75, 0)} ${fmt(segStats.p90, 0)} ${fmt(segStats.max, 0)} ${fmt(segStats.mean, 1)}`);
  } else {
    console.log('    (no segmental_accuracy values — run with --backfill or collect new attempts)');
  }
  console.log('  dtw_distance (normalized, lower = closer)');
  if (dtwStats) {
    console.log(`    ${String(dtwStats.n).padStart(19)} ${fmt(dtwStats.min, 3)} ${fmt(dtwStats.p10, 3)} ${fmt(dtwStats.p25, 3)} ${fmt(dtwStats.median, 3)} ${fmt(dtwStats.p75, 3)} ${fmt(dtwStats.p90, 3)} ${fmt(dtwStats.max, 3)} ${fmt(dtwStats.mean, 3)}`);
  }
  console.log();
  if (segValues.length) printHistogram('segmental_accuracy histogram', histogram(segValues, 10, 0, 100), segValues.length);

  // ---- 3. Per population ------------------------------------------------
  console.log('\n' + '-'.repeat(72));
  console.log('3. BY POPULATION (Student.disability, normalized)');
  console.log('-'.repeat(72));
  const byPop = new Map();
  layer1Rows.forEach((r) => {
    const key = normalizePopulation(r.student && r.student.disability);
    if (!byPop.has(key)) byPop.set(key, []);
    byPop.get(key).push(r);
  });
  console.log('  population                     n   accept%   mean seg   mean dtw');
  [...byPop.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([pop, popRows]) => {
      const acc = popRows.filter((r) => r.layer1_decision === 'dtw_only_accept').length;
      const seg = describe(popRows.map((r) => r.segmental_accuracy));
      const dtw = describe(popRows.map((r) => r.dtw_distance));
      console.log(
        `  ${pop.padEnd(26)} ${String(popRows.length).padStart(5)}   ${pct(acc, popRows.length).padStart(6)}   ${fmt(seg && seg.mean, 1)}     ${fmt(dtw && dtw.mean, 3)}`
      );
    });

  // ---- 4. Agreement with teacher -------------------------------------
  const reviewed = layer1Rows.filter((r) => Number.isFinite(r.teacher_reviewed_score));
  console.log('\n' + '-'.repeat(72));
  console.log('4. AGREEMENT WITH TEACHER-REVIEWED SCORE');
  console.log('-'.repeat(72));
  console.log(`  reviewed Layer-1 rows: ${reviewed.length} (of ${layer1Rows.length})`);
  if (reviewed.length < 10) {
    console.log('  Too few teacher-reviewed rows for a stable read. Drain the review');
    console.log('  queue, then re-run. Calibration (plan step 2) needs this signal.');
  } else {
    const segReviewed = reviewed.filter((r) => Number.isFinite(r.segmental_accuracy));
    const rSeg = pearson(segReviewed.map((r) => [r.segmental_accuracy, r.teacher_reviewed_score]));
    const rDtw = pearson(reviewed.map((r) => [r.dtw_distance, r.teacher_reviewed_score]));
    console.log(`  pearson r  segmental_accuracy vs teacher : ${fmt(rSeg, 3)}   (n=${segReviewed.length}, want strongly +)`);
    console.log(`  pearson r  dtw_distance       vs teacher : ${fmt(rDtw, 3)}   (n=${reviewed.length}, want strongly -)`);
    if (segReviewed.length) {
      const errs = segReviewed.map((r) => r.segmental_accuracy - r.teacher_reviewed_score);
      const mae = errs.reduce((t, e) => t + Math.abs(e), 0) / errs.length;
      const bias = errs.reduce((t, e) => t + e, 0) / errs.length;
      console.log(`  segmental_accuracy vs teacher : MAE ${fmt(mae, 1)}   bias ${fmt(bias, 1)} (negative = Layer 1 underscores)`);
    }

    // Gate threshold sweep on the reviewed subset: for each candidate cutoff,
    // what fraction of would-be accepts are actually wrong (false accept —
    // the dangerous case, GOP gets skipped), and what fraction of would-be
    // escalations were actually correct (needless GOP call / latency)?
    if (segReviewed.length >= 10) {
      console.log('\n  gate threshold sweep (reviewed rows only, "correct" = teacher >= ' + CORRECT_THRESHOLD + ')');
      console.log('    thr   accepts   false-accept%   escalations   needless-escalation%');
      for (let thr = 70; thr <= 95; thr += 5) {
        const wouldAccept = segReviewed.filter((r) => r.segmental_accuracy >= thr);
        const wouldEscalate = segReviewed.filter((r) => r.segmental_accuracy < thr);
        const falseAccept = wouldAccept.filter((r) => r.teacher_reviewed_score < CORRECT_THRESHOLD).length;
        const needlessEsc = wouldEscalate.filter((r) => r.teacher_reviewed_score >= CORRECT_THRESHOLD).length;
        const marker = thr === LAYER1_CONFIDENT_ACCEPT_SCORE ? '  <- current' : '';
        console.log(
          `    ${String(thr).padStart(3)}   ${String(wouldAccept.length).padStart(7)}   ${pct(falseAccept, wouldAccept.length).padStart(12)}   ${String(wouldEscalate.length).padStart(11)}   ${pct(needlessEsc, wouldEscalate.length).padStart(19)}${marker}`
        );
      }
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('READ:');
  console.log('  - gate hit rate low  + weak/again correlation -> demote Layer 1, cut blend weight, spend on GOP');
  console.log('  - gate hit rate real + decent correlation      -> proceed to step 2 (fit midpoint/slope/threshold per population)');
  console.log('  - big per-population accept% or mean-seg gap    -> confirms adult-reference bias; step 4 (multi-ref + VTLN) will pay off');
  console.log('='.repeat(72));

  if (WANT_JSON) {
    const summary = {
      generated_at: new Date().toISOString(),
      total_rows: rows.length,
      layer1_rows: layer1Rows.length,
      gate: {
        threshold: LAYER1_CONFIDENT_ACCEPT_SCORE,
        accept: accepts.length,
        escalate: escalations.length,
        accept_rate: accepts.length / layer1Rows.length,
      },
      segmental_accuracy: describe(segValues),
      dtw_distance: describe(dtwValues),
      reviewed_rows: reviewed.length,
    };
    console.log('\nJSON_SUMMARY ' + JSON.stringify(summary));
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error('layer1Report failed:', err);
  process.exit(1);
});

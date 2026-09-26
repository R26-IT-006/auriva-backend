'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize, PronunciationSessionResult, Student } = require('../src/models');
const {
  fitCalibrationFromPairs,
  getAdaptiveScore,
  getOverallScore,
  applyCalibration,
  MIN_SAMPLES_FOR_CALIBRATION,
  MIN_MAE_IMPROVEMENT,
} = require('../src/services/adaptiveCalibrationService');

// Companion to layer1Report.js, for layer 3 (per-population recalibration).
// Answers the questions that gate switching this layer from evidence-only to
// actually adjusting scores:
//
//   1. How big is the labeled corpus, overall and per population?
//   2. Would a calibration pass cross-validation — i.e. does applying it beat
//      leaving the score alone on held-out reviews?
//   3. Should it calibrate adaptive_score (what it fits today) or
//      overall_score (what the teacher is actually shown)?
//   4. How biased is the corpus? Reviews come from an uncertainty-sampling
//      queue, so a fit estimated only in the low-confidence band is not
//      evidence about the high-confidence band it would also be applied to.
//
// Read-only apart from --backfill, which copies adaptive_score /
// confidence_score out of recommendation_details JSONB into the new columns.

const WANT_BACKFILL = process.argv.includes('--backfill');
const WANT_JSON = process.argv.includes('--json');

function normalizePopulation(value) {
  const tag = String(value || '').trim().toLowerCase();
  return tag || '(unspecified)';
}

function fmt(value, digits = 2, width = 7) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'.padStart(width);
  return value.toFixed(digits).padStart(width);
}

function pct(part, whole) {
  if (!whole) return 'n/a';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

async function ensureLayer3Columns() {
  const qi = sequelize.getQueryInterface();
  const table = await qi.describeTable('pronunciation_session_results');
  const { DataTypes } = require('sequelize');
  const wanted = {
    adaptive_score: { type: DataTypes.INTEGER, allowNull: true },
    confidence_score: { type: DataTypes.INTEGER, allowNull: true },
  };
  for (const [name, spec] of Object.entries(wanted)) {
    if (!table[name]) {
      await qi.addColumn('pronunciation_session_results', name, spec);
      console.log(`  added missing column: ${name}`);
    }
  }
}

async function backfillFromJsonb(rows) {
  let updated = 0;
  for (const row of rows) {
    const model = row.recommendation_details && row.recommendation_details.adaptive_model;
    if (!model) continue;
    const patch = {};
    if (row.adaptive_score == null && Number.isFinite(model.adaptive_score)) {
      patch.adaptive_score = model.adaptive_score;
    }
    if (row.confidence_score == null && Number.isFinite(model.confidence_score)) {
      patch.confidence_score = model.confidence_score;
    }
    if (Object.keys(patch).length) {
      await PronunciationSessionResult.update(patch, { where: { id: row.id } });
      Object.assign(row, patch);
      updated += 1;
    }
  }
  console.log(`Backfill: updated ${updated} historical row(s) from recommendation_details JSONB.\n`);
}

function reportFit(label, fit) {
  console.log(`  ${label}`);
  console.log(`    labeled pairs   : ${fit.sample_size}`);
  console.log(`    fitted          : ${fit.fitted}${fit.fitted ? ` (${fit.model})` : ''}`);
  const validation = fit.validation || {};
  if (validation.mae_identity != null) {
    console.log(`    held-out MAE    : identity ${fmt(validation.mae_identity)}   calibrated ${fmt(validation.mae_calibrated)}   improvement ${fmt(validation.mae_improvement)}`);
    console.log(`    folds           : ${validation.folds}`);
  }
  if (validation.candidates) {
    const { linear, isotonic } = validation.candidates;
    const describeCandidate = (c) => (c.rejected
      ? `rejected (${c.reason})`
      : `improvement ${fmt(c.mae_improvement)}${c.slope != null ? `  slope ${fmt(c.slope, 3)}` : ''}${c.blocks != null ? `  blocks ${c.blocks}` : ''}`);
    console.log(`    linear          : ${describeCandidate(linear)}`);
    console.log(`    isotonic        : ${describeCandidate(isotonic)}`);
  }
  if (validation.rejected_reason) {
    console.log(`    not applied     : ${validation.rejected_reason}`);
  }
  if (fit.fitted && fit.model === 'linear') {
    console.log(`    curve           : y = ${fit.slope.toFixed(4)}x + ${fit.intercept.toFixed(4)}`);
    [40, 60, 80, 95].forEach((x) => {
      console.log(`      ${String(x).padStart(3)} -> ${applyCalibration(x, fit)}`);
    });
  }
  if (fit.fitted && fit.model === 'isotonic') {
    console.log(`    knots           : ${fit.knots.map(([x, y]) => `${x.toFixed(0)}->${y.toFixed(0)}`).join('  ')}`);
  }
}

async function main() {
  await sequelize.authenticate();
  await ensureLayer3Columns();

  const rows = (await PronunciationSessionResult.findAll({
    attributes: { exclude: ['raw_audio_data'] },
    include: [{ model: Student, as: 'student', attributes: ['disability'] }],
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  })).map((r) => r.get({ plain: true }));

  console.log('='.repeat(76));
  console.log('LAYER 3 (PER-POPULATION RECALIBRATION) REPORT');
  console.log(`generated ${new Date().toISOString()}`);
  console.log(`total pronunciation_session_results rows: ${rows.length}`);
  console.log(`status: EVIDENCE ONLY — this layer does not adjust any score yet`);
  console.log('='.repeat(76));

  if (WANT_BACKFILL) await backfillFromJsonb(rows);

  const reviewed = rows.filter((r) => Number.isFinite(r.teacher_reviewed_score));

  // ---- 1. Corpus size -----------------------------------------------------
  console.log('\n' + '-'.repeat(76));
  console.log('1. LABELED CORPUS');
  console.log('-'.repeat(76));
  console.log(`  teacher-reviewed rows      : ${reviewed.length} of ${rows.length} (${pct(reviewed.length, rows.length)})`);
  console.log(`  with an adaptive_score     : ${reviewed.filter((r) => getAdaptiveScore(r) != null).length}`);
  console.log(`  minimum to fit a curve     : ${MIN_SAMPLES_FOR_CALIBRATION}`);
  const missingAdaptive = rows.filter((r) => getAdaptiveScore(r) == null).length;
  if (missingAdaptive && !WANT_BACKFILL) {
    console.log(`  NOTE: ${missingAdaptive} row(s) carry no adaptive_score — re-run with --backfill`);
  }

  if (!reviewed.length) {
    console.log('\nNo teacher-reviewed rows yet. Drain the review queue, then re-run.');
    await sequelize.close();
    return;
  }

  // ---- 2. Per-population coverage ----------------------------------------
  console.log('\n' + '-'.repeat(76));
  console.log('2. COVERAGE BY POPULATION (Student.disability, normalized)');
  console.log('-'.repeat(76));
  const byPop = new Map();
  rows.forEach((r) => {
    const key = normalizePopulation(r.student && r.student.disability);
    if (!byPop.has(key)) byPop.set(key, { all: [], reviewed: [] });
    byPop.get(key).all.push(r);
    if (Number.isFinite(r.teacher_reviewed_score)) byPop.get(key).reviewed.push(r);
  });
  console.log('  population                   attempts   reviewed   enough to fit?');
  [...byPop.entries()]
    .sort((a, b) => b[1].reviewed.length - a[1].reviewed.length)
    .forEach(([pop, group]) => {
      const usable = group.reviewed.filter((r) => getAdaptiveScore(r) != null).length;
      const enough = usable >= MIN_SAMPLES_FOR_CALIBRATION ? 'yes' : `no (${MIN_SAMPLES_FOR_CALIBRATION - usable} more)`;
      console.log(`  ${pop.padEnd(26)} ${String(group.all.length).padStart(8)} ${String(usable).padStart(10)}   ${enough}`);
    });

  // ---- 3. Fits ------------------------------------------------------------
  console.log('\n' + '-'.repeat(76));
  console.log('3. CANDIDATE FITS (would this calibration beat doing nothing?)');
  console.log('-'.repeat(76));
  console.log(`  gate: held-out MAE must improve by >= ${MIN_MAE_IMPROVEMENT} point(s)\n`);

  const toPairs = (source, read) => source
    .map((r) => {
      const score = read(r);
      return score == null ? null : [score, r.teacher_reviewed_score];
    })
    .filter(Boolean);

  const globalAdaptive = fitCalibrationFromPairs(toPairs(reviewed, getAdaptiveScore));
  const globalOverall = fitCalibrationFromPairs(toPairs(reviewed, getOverallScore));
  console.log('  GLOBAL (all populations pooled)');
  reportFit('target: adaptive_score  [what layer 3 fits today]', globalAdaptive);
  console.log();
  reportFit('target: overall_score   [what the teacher is shown]', globalOverall);

  const fitsByPop = {};
  [...byPop.entries()].forEach(([pop, group]) => {
    const pairs = toPairs(group.reviewed, getAdaptiveScore);
    if (pairs.length < MIN_SAMPLES_FOR_CALIBRATION) return;
    console.log(`\n  POPULATION: ${pop}`);
    const fit = fitCalibrationFromPairs(pairs);
    fitsByPop[pop] = fit;
    reportFit('target: adaptive_score', fit);
  });
  if (!Object.keys(fitsByPop).length) {
    console.log('\n  No population has enough labeled examples for its own fit yet.');
  }

  // ---- 4. Selection bias --------------------------------------------------
  console.log('\n' + '-'.repeat(76));
  console.log('4. CORPUS BIAS (the review queue is uncertainty-sampled)');
  console.log('-'.repeat(76));
  const confidenceOf = (r) => {
    const column = r.confidence_score;
    if (Number.isFinite(column)) return column;
    const nested = r.recommendation_details
      && r.recommendation_details.adaptive_model
      && r.recommendation_details.adaptive_model.confidence_score;
    return Number.isFinite(nested) ? nested : null;
  };
  const reviewedConf = reviewed.map(confidenceOf).filter(Number.isFinite);
  const unreviewedConf = rows
    .filter((r) => !Number.isFinite(r.teacher_reviewed_score))
    .map(confidenceOf)
    .filter(Number.isFinite);
  console.log(`  mean confidence_score, reviewed   : ${fmt(mean(reviewedConf), 1)}  (n=${reviewedConf.length})`);
  console.log(`  mean confidence_score, unreviewed : ${fmt(mean(unreviewedConf), 1)}  (n=${unreviewedConf.length})`);
  const gap = (mean(reviewedConf) ?? 0) - (mean(unreviewedConf) ?? 0);
  if (reviewedConf.length && unreviewedConf.length) {
    console.log(`  gap                               : ${fmt(gap, 1)}`);
    if (Math.abs(gap) > 8) {
      console.log('  WARNING: reviewed and unreviewed attempts differ markedly in model');
      console.log('           confidence. Any fit here is estimated on one slice and would');
      console.log('           be applied to another. Add a random-audit review stream');
      console.log('           before activating this layer.');
    }
  }
  const reviewedByBand = { low: 0, medium: 0, high: 0, unknown: 0 };
  reviewed.forEach((r) => {
    const c = confidenceOf(r);
    if (c == null) reviewedByBand.unknown += 1;
    else if (c >= 75) reviewedByBand.high += 1;
    else if (c >= 55) reviewedByBand.medium += 1;
    else reviewedByBand.low += 1;
  });
  console.log(`  reviewed rows by confidence band  : low ${reviewedByBand.low}   medium ${reviewedByBand.medium}   high ${reviewedByBand.high}   unknown ${reviewedByBand.unknown}`);
  if (reviewedByBand.high < MIN_SAMPLES_FOR_CALIBRATION / 3) {
    console.log('  Too few high-confidence reviews to know whether the curve holds there.');
  }

  console.log('\n' + '='.repeat(76));
  console.log('READ:');
  console.log('  - no fit passes validation      -> keep layer 3 evidence-only; identity is honest');
  console.log('  - overall_score fit beats adaptive_score fit -> retarget layer 3 before activating');
  console.log('  - a fit passes but the band table is lopsided -> add random-audit reviews first');
  console.log('  - a population fit passes and global does not -> the per-population split is earning its keep');
  console.log('='.repeat(76));

  if (WANT_JSON) {
    console.log('\nJSON_SUMMARY ' + JSON.stringify({
      generated_at: new Date().toISOString(),
      total_rows: rows.length,
      reviewed_rows: reviewed.length,
      min_samples: MIN_SAMPLES_FOR_CALIBRATION,
      global_adaptive: globalAdaptive,
      global_overall: globalOverall,
      populations: fitsByPop,
      confidence_gap: gap,
    }));
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error('layer3Report failed:', err);
  process.exit(1);
});

'use strict';

/**
 * verifyForwardPersonalization.js
 *
 * READ-ONLY forward-path verification for one student, run right after a real
 * device initial assessment. Writes nothing, mutates nothing.
 *
 *   node src/scripts/verifyForwardPersonalization.js --student-id=4
 *
 * Checks, in the order the product performs them:
 *   1. one new non-collection HandwritingAssessment
 *   2. the six canonical ShapeFeatures linked to it (warm-up rows excluded)
 *   3. StudentMotorBaseline created, legacy + progression_* populated
 *   4. family thresholds initialized, bounded, with provenance
 *   5. the SAME resolver normal letter practice uses returns them
 *
 * Every check prints PASS/FAIL on its own line so a failure is unambiguous.
 */

require('dotenv').config({ quiet: true });

const {
  HandwritingAssessment, ShapeFeature, StudentMotorBaseline, ThresholdHistory, sequelize,
} = require('../models');
const { REQUIRED_SHAPES, findEarliestEligibleAssessment } = require('../services/motorBaselineService');
const { INITIAL_PERSONALIZED_THRESHOLD_CEILING } = require('../services/dynamicThresholdService');
const { resolveProgressionThreshold } = require('../services/progressionThresholdResolver');

const log = (...a) => console.log(...a);
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

// One letter per family, from the real letterBaselineFamilies mapping.
const PROBE_LETTERS = [
  ['l', 'lowercase', 'straight'],
  ['c', 'lowercase', 'curved'],
  ['s', 'lowercase', 'complex'],
];

async function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--student-id='));
  const studentId = arg ? Number(arg.split('=')[1]) : NaN;
  if (!Number.isInteger(studentId) || studentId <= 0) {
    log('Usage: node src/scripts/verifyForwardPersonalization.js --student-id=<sid>');
    process.exitCode = 1;
    return;
  }

  log(`\n=== FORWARD PERSONALIZATION VERIFICATION — student ${studentId} ===\n`);

  // ── 1. The assessment ──
  log('1. HandwritingAssessment');
  const assessments = await HandwritingAssessment.findAll({
    where: { student_id: studentId, collection_mode: false },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });
  check('at least one non-collection assessment exists', assessments.length > 0,
    `count=${assessments.length}`);
  if (assessments.length === 0) return finish();

  const latest = assessments[assessments.length - 1];
  log(`      latest: id=${latest.id} created=${latest.created_at.toISOString()}` +
      ` motor_score=${latest.motor_score} collection_mode=${latest.collection_mode}`);
  log(`      motor_profile=${JSON.stringify(latest.motor_profile)}`);

  // ── 2. Canonical linked evidence ──
  log('\n2. ShapeFeature evidence (warm-up rows excluded by source)');
  const shapes = await ShapeFeature.findAll({
    where: { student_id: studentId, assessment_id: latest.id, source: 'initial_assessment' },
    attributes: ['shape_type', 'source', 'assessment_id', 'motor_score'],
    raw: true,
  });
  for (const s of shapes) {
    log(`      ${String(s.shape_type).padEnd(16)} source=${s.source}` +
        ` assessment_id=${s.assessment_id} motor_score=${s.motor_score}`);
  }
  const present = new Set(shapes.filter((s) => Number.isFinite(s.motor_score)).map((s) => s.shape_type));
  const missing = REQUIRED_SHAPES.filter((s) => !present.has(s));
  check('all six canonical shapes linked with a finite motor_score', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${present.size}/6`);

  const warmups = await ShapeFeature.count({
    where: { student_id: studentId, source: 'pre_writing_warmup' },
  });
  log(`      (pre_writing_warmup rows for this student: ${warmups} — must stay unlinked)`);

  // ── 3. The baseline ──
  log('\n3. StudentMotorBaseline');
  const baseline = await StudentMotorBaseline.findOne({ where: { student_id: studentId } });
  check('baseline created automatically', !!baseline);
  if (!baseline) {
    const { assessment: chosen, skipped } = await findEarliestEligibleAssessment({ studentId });
    log(`      selector would choose: ${chosen ? chosen.id : 'NONE'}`);
    log(`      skipped: ${JSON.stringify(skipped)}`);
    return finish();
  }
  log(`      source_assessment_id=${baseline.source_assessment_id}`);
  log(`      legacy      straight=${baseline.straight_score} curved=${baseline.curved_score}` +
      ` complex=${baseline.complex_score} overall=${baseline.overall_motor_score}`);
  log(`      progression straight=${baseline.progression_straight_score}` +
      ` curved=${baseline.progression_curved_score} complex=${baseline.progression_complex_score}`);
  check('all three progression families populated',
    [baseline.progression_straight_score, baseline.progression_curved_score,
      baseline.progression_complex_score].every((v) => typeof v === 'number' && Number.isFinite(v)));

  // ── 4. Threshold initialization ──
  log('\n4. Family thresholds');
  const rows = await ThresholdHistory.findAll({
    where: { student_id: studentId, scope_type: 'family' },
    order: [['id', 'ASC']], raw: true,
  });
  check('three family threshold rows exist', rows.length >= 3, `count=${rows.length}`);
  for (const r of rows) {
    const meta = r.recent_window_snapshot?.initialization ?? null;
    log(`      ${String(r.scope_key).padEnd(9)} threshold=${r.new_threshold}` +
        ` source=${r.source} reason=${r.reason}`);
    if (meta) {
      log(`                baseline=${meta.baseline_score} margin=${meta.margin}` +
          ` raw_target=${meta.raw_target} ceiling=${meta.ceiling_value}` +
          ` applied=${meta.ceiling_applied}`);
    }
    check(`${r.scope_key}: threshold <= ceiling`,
      Number(r.new_threshold) <= INITIAL_PERSONALIZED_THRESHOLD_CEILING,
      `${r.new_threshold} <= ${INITIAL_PERSONALIZED_THRESHOLD_CEILING}`);
    check(`${r.scope_key}: provenance recorded`, !!meta);
  }

  // ── 5. The resolver normal practice actually uses ──
  log('\n5. Resolver (the same call recordLetterCompletion makes)');
  for (const [letter, caseType, family] of PROBE_LETTERS) {
    const r = await resolveProgressionThreshold({ studentId, letter, caseType });
    log(`      ${letter}/${caseType} (${family}) -> threshold=${r.threshold}` +
        ` source=${r.source} family=${r.family} fallbackReason=${r.fallbackReason ?? 'n/a'}`);
    check(`${letter}: personalized, not the global fallback`,
      r.source === 'feature2_family', `source=${r.source}`);
    check(`${letter}: threshold <= ceiling`,
      Number(r.threshold) <= INITIAL_PERSONALIZED_THRESHOLD_CEILING);
  }

  finish();
}

function finish() {
  log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => { console.error('VERIFICATION ERROR:', err.message); process.exitCode = 1; })
  .finally(() => sequelize.close());

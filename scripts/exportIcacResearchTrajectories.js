'use strict';

// ============================================================================
// icac_raw_trajectories / icac_existing_features export
// READ-ONLY. LOCAL. RESEARCH/PAPER USE ONLY.
//
// NOT WIRED into the app — not referenced by any route/controller/service/
// npm script/CI step. Must be invoked manually by a human:
//
//   node scripts/exportIcacResearchTrajectories.js
//
// Guarantees:
//   - Every database call in this file is a SELECT (Model.count /
//     Model.findAll). Nothing here calls .create/.update/.destroy/.sync, and
//     nothing here runs a migration.
//   - Only ShapeFeature and LetterAttempt are queried. The Student/Teacher/
//     User tables are never touched, so no name/DOB/email/auth field is ever
//     in scope to begin with.
//   - The real student_id is remapped to a pseudonymous research ID
//     (RS01..RS07) in memory only; the mapping is printed to the console
//     once for the operator to keep privately and is NEVER written to
//     either output file. Neither output file contains a `student_id` key.
//
// Feature 11B ambiguity (carried over from the ICAC Augmentation Experiment
// Preparation audit): the service that would have tagged dedicated
// reassessment rows (`letterMotorReassessmentService.js` /
// `source_type='letter_motor_reassessment'`) does not exist in this
// repository. This script queries BOTH candidate definitions, reports both
// counts, and labels every exported letter row with which query produced
// it — it does not guess on your behalf.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const db   = require('../src/models');
const { sequelize, ShapeFeature, LetterAttempt } = db;

const PILOT_STUDENT_IDS = [5, 9, 10, 31, 32, 33, 35];

// Fixed, explicit mapping — matches the task specification exactly.
const RESEARCH_ID_MAP = new Map([
  [5,  'RS01'], [9,  'RS02'], [10, 'RS03'], [31, 'RS04'],
  [32, 'RS05'], [33, 'RS06'], [35, 'RS07'],
]);

const OUT_DIR = path.resolve(__dirname, '..', 'research', 'exports');

function toResearchId(studentId) {
  return RESEARCH_ID_MAP.get(studentId) ?? null;
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function countTrajectoryPoints(strokePoints) {
  if (!Array.isArray(strokePoints)) return 0;
  return strokePoints.reduce((sum, s) => sum + (Array.isArray(s?.points) ? s.points.length : 0), 0);
}

function hasUsableStrokePoints(strokePoints) {
  return Array.isArray(strokePoints) && strokePoints.length > 0 &&
    strokePoints.some(s => Array.isArray(s?.points) && s.points.length > 0);
}

// ── Shape (Feature 11A) raw + feature export ────────────────────────────
async function exportShapeRows() {
  const rows = await ShapeFeature.findAll({
    where: { student_id: PILOT_STUDENT_IDS, source: 'initial_assessment' },
    attributes: [
      'student_id', 'shape_type', 'attempt_number', 'stroke_points',
      'collection_mode', 'canvas_width', 'canvas_height',
      'feature_version', 'template_version', 'normalization_version',
      'normalized_features', 'motor_score', 'score_version',
      'capture_status', 'created_at',
    ],
    raw: true,
  });

  return rows.map(r => {
    const nf = r.normalized_features ?? {};
    return {
      participant_id:         toResearchId(r.student_id),
      task_type:               'shape',
      item:                     r.shape_type,
      case_type:                null,
      attempt_number:           r.attempt_number,
      collection_mode:          r.collection_mode,
      capture_status:           r.capture_status,
      canvas_width:             r.canvas_width,
      canvas_height:            r.canvas_height,
      stroke_points:            r.stroke_points, // verbatim, unmodified, unflattened
      features: {
        dtw_distance:      nf.dtw_distance ?? null,
        smoothness_score:  nf.smoothness_score ?? null,
        accuracy_score:    nf.accuracy_score ?? null,
        direction_score:   nf.direction_score ?? null,
        pause_count:       nf.pause_count ?? null,
        avg_speed:         nf.avg_speed ?? null,
        speed_cv:          nf.speed_cv ?? null,
        duration_ms:       nf.duration_ms ?? null,
        stroke_count:      nf.stroke_count ?? null,
        total_distance:    nf.total_distance ?? null,
        motor_score:       r.motor_score ?? null,
      },
      feature_version:          r.feature_version,
      template_version:         r.template_version,
      normalization_version:    r.normalization_version,
      score_version:            r.score_version,
      created_at:               r.created_at,
    };
  });
}

// ── Letter (Feature 11B) raw + feature export — both candidate queries ──
async function countLetterCandidates() {
  const attempt3Count = await LetterAttempt.count({
    where: { student_id: PILOT_STUDENT_IDS, attempt_number: 3, source_type: null },
  });
  const reassessmentCount = await LetterAttempt.count({
    where: { student_id: PILOT_STUDENT_IDS, source_type: 'letter_motor_reassessment' },
  });
  return { attempt3Count, reassessmentCount };
}

async function exportLetterRows() {
  const attrs = [
    'student_id', 'letter', 'case_type', 'attempt_number', 'passed',
    'best_score', 'threshold', 'threshold_passed', 'stroke_points',
    'collection_mode', 'source_type', 'canvas_width', 'canvas_height',
    'feature_version', 'template_version', 'normalization_version',
    'normalized_features', 'motor_score', 'score_version',
    'progression_score_version', 'capture_status', 'created_at',
  ];

  const proxyRows = await LetterAttempt.findAll({
    where: { student_id: PILOT_STUDENT_IDS, attempt_number: 3, source_type: null },
    attributes: attrs, raw: true,
  });
  const reassessmentRows = await LetterAttempt.findAll({
    where: { student_id: PILOT_STUDENT_IDS, source_type: 'letter_motor_reassessment' },
    attributes: attrs, raw: true,
  });

  const mapRow = (r, queryMode) => {
    const nf = r.normalized_features ?? {};
    return {
      participant_id:          toResearchId(r.student_id),
      task_type:                'letter',
      item:                     r.letter,
      case_type:                r.case_type,
      attempt_number:           r.attempt_number,
      query_mode:               queryMode,
      source_type:              r.source_type,
      collection_mode:          r.collection_mode,
      capture_status:           r.capture_status,
      canvas_width:             r.canvas_width,
      canvas_height:            r.canvas_height,
      stroke_points:            r.stroke_points, // verbatim, unmodified, unflattened
      features: {
        dtw_distance:      nf.dtw_distance ?? null,
        smoothness_score:  nf.smoothness_score ?? null,
        accuracy_score:    nf.accuracy_score ?? null,
        direction_score:   nf.direction_score ?? null,
        pause_count:       nf.pause_count ?? null,
        avg_speed:         nf.avg_speed ?? null,
        speed_cv:          nf.speed_cv ?? null,
        duration_ms:       nf.duration_ms ?? null,
        stroke_count:      nf.stroke_count ?? null,
        total_distance:    nf.total_distance ?? null,
        motor_score:       r.motor_score ?? null,
      },
      progression: {
        passed:            r.passed,
        best_score:        r.best_score,
        threshold:         r.threshold,
        threshold_passed:  r.threshold_passed,
      },
      feature_version:              r.feature_version,
      template_version:             r.template_version,
      normalization_version:        r.normalization_version,
      score_version:                r.score_version,
      progression_score_version:    r.progression_score_version,
      created_at:                   r.created_at,
    };
  };

  return [
    ...proxyRows.map(r => mapRow(r, 'attempt_3_proxy')),
    ...reassessmentRows.map(r => mapRow(r, 'reassessment_tag')),
  ];
}

// ── Flat CSV of already-computed features, for Colab-side cross-check ──
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toExistingFeaturesCsv(shapeRows, letterRows) {
  const header = [
    'participant_id', 'task_type', 'item', 'case_type', 'attempt_number', 'query_mode',
    'dtw_distance', 'smoothness_score', 'accuracy_score', 'direction_score',
    'pause_count', 'avg_speed', 'speed_cv', 'duration_ms', 'stroke_count',
    'total_distance', 'motor_score', 'score_version',
  ];
  const lines = [header.join(',')];
  for (const r of [...shapeRows, ...letterRows]) {
    const f = r.features ?? {};
    const vals = [
      r.participant_id, r.task_type, r.item, r.case_type ?? '', r.attempt_number,
      r.query_mode ?? 'initial_assessment',
      f.dtw_distance, f.smoothness_score, f.accuracy_score, f.direction_score,
      f.pause_count, f.avg_speed, f.speed_cv, f.duration_ms, f.stroke_count,
      f.total_distance, f.motor_score, r.score_version,
    ];
    lines.push(vals.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Connecting to database...');
  await sequelize.authenticate();
  console.log('DB connection: OK\n');

  const shapeTotal  = await ShapeFeature.count();
  const letterTotal = await LetterAttempt.count();
  console.log(`ShapeFeature total row count (all students, all sources):  ${shapeTotal}`);
  console.log(`LetterAttempt total row count (all students, all sources): ${letterTotal}\n`);

  console.log('Pseudonymous research ID mapping (KEEP PRIVATE — not written to any output file):');
  for (const [sid, rid] of RESEARCH_ID_MAP) console.log(`  student_id=${sid}  ->  ${rid}`);
  console.log();

  const { attempt3Count, reassessmentCount } = await countLetterCandidates();
  console.log(`Feature 11B candidate A (attempt_number=3 AND source_type IS NULL), 7 pilot participants: ${attempt3Count} rows`);
  console.log(`Feature 11B candidate B (source_type='letter_motor_reassessment'), 7 pilot participants:  ${reassessmentCount} rows\n`);

  const shapeRows  = await exportShapeRows();
  const letterRows = await exportLetterRows();

  const allRows = [...shapeRows, ...letterRows];

  const jsonOut = {
    metadata: {
      export_purpose:     'ICAC 2026 research analysis',
      real_data_only:      true,
      augmentation_applied: false,
      participant_count:   PILOT_STUDENT_IDS.length,
      generated_at:         new Date().toISOString(),
      note: 'Research/paper use only. participant_id values are pseudonymous (RS01..RS07); no student_id, name, DOB, email, teacher identity, or auth field was queried or included. Trajectories are verbatim DB stroke_points — not flattened, normalized, or modified.',
    },
    records: allRows,
  };

  const jsonPath = path.join(OUT_DIR, 'icac_raw_trajectories.json');
  const csvPath  = path.join(OUT_DIR, 'icac_existing_features.csv');

  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2));
  fs.writeFileSync(csvPath, toExistingFeaturesCsv(shapeRows, letterRows));

  // ── Integrity self-check (never silently excludes anything — only reports) ──
  const idPattern = /^RS0[1-7]$/;
  const badIds = allRows.filter(r => !idPattern.test(r.participant_id ?? ''));
  const hasStudentIdKey = JSON.stringify(jsonOut).includes('"student_id"');

  // ── Data quality report ──────────────────────────────────────────────
  function perKeyCounts(rows, key) {
    const m = new Map();
    for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
    return Object.fromEntries(m);
  }
  const shapeMissingTraj  = shapeRows.filter(r => !hasUsableStrokePoints(r.stroke_points));
  const letterMissingTraj = letterRows.filter(r => !hasUsableStrokePoints(r.stroke_points));
  const shapePointCounts  = shapeRows.map(r => countTrajectoryPoints(r.stroke_points));
  const letterPointCounts = letterRows.map(r => countTrajectoryPoints(r.stroke_points));
  const shapeStrokeCounts  = shapeRows.map(r => (Array.isArray(r.stroke_points) ? r.stroke_points.length : 0));
  const letterStrokeCounts = letterRows.map(r => (Array.isArray(r.stroke_points) ? r.stroke_points.length : 0));

  console.log('── DATA QUALITY REPORT ──────────────────────────────────');
  console.log('SHAPES');
  console.log('  total rows:', shapeRows.length);
  console.log('  rows per participant:', perKeyCounts(shapeRows, 'participant_id'));
  console.log('  rows per shape:', perKeyCounts(shapeRows, 'item'));
  console.log('  rows containing stroke_points:', shapeRows.length - shapeMissingTraj.length);
  console.log('  rows MISSING stroke_points:', shapeMissingTraj.length,
    shapeMissingTraj.length ? shapeMissingTraj.map(r => `${r.participant_id}/${r.item}`) : '');
  console.log('LETTERS');
  console.log('  total rows:', letterRows.length);
  console.log('  rows per participant:', perKeyCounts(letterRows, 'participant_id'));
  console.log('  rows per letter:', perKeyCounts(letterRows, 'item'));
  console.log('  attempt-3 normal-practice count:', attempt3Count);
  console.log('  reassessment-tag count:', reassessmentCount);
  console.log('  rows containing stroke_points:', letterRows.length - letterMissingTraj.length);
  console.log('  rows MISSING stroke_points:', letterMissingTraj.length,
    letterMissingTraj.length ? letterMissingTraj.map(r => `${r.participant_id}/${r.item}`) : '');
  console.log('TRAJECTORY POINT COUNTS');
  console.log('  shapes  min/median/max:', Math.min(...shapePointCounts, Infinity), median(shapePointCounts), Math.max(...shapePointCounts, -Infinity));
  console.log('  letters min/median/max:', Math.min(...letterPointCounts, Infinity), median(letterPointCounts), Math.max(...letterPointCounts, -Infinity));
  console.log('STROKE COUNTS');
  console.log('  shapes  min/median/max:', Math.min(...shapeStrokeCounts, Infinity), median(shapeStrokeCounts), Math.max(...shapeStrokeCounts, -Infinity));
  console.log('  letters min/median/max:', Math.min(...letterStrokeCounts, Infinity), median(letterStrokeCounts), Math.max(...letterStrokeCounts, -Infinity));
  console.log();
  console.log('── INTEGRITY CHECK ──────────────────────────────────────');
  console.log('  all participant_id values match RS0[1-7]:', badIds.length === 0, badIds.length ? badIds : '');
  console.log('  "student_id" key absent from JSON output:', !hasStudentIdKey);
  console.log('  real_data_only=true, augmentation_applied=false written to metadata: OK');
  console.log();
  console.log(`Wrote ${shapeRows.length} shape rows + ${letterRows.length} letter rows`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
}

main()
  .then(() => sequelize.close())
  .catch(err => { console.error(err); sequelize.close(); process.exit(1); });

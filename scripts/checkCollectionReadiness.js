'use strict';

// Read-only Data Collection Mode readiness report. Never writes to the
// database — every query below is a SELECT. Run with:
//   node scripts/checkCollectionReadiness.js
//
// Requires the item-1..4 migrations (20260714000001..000006) to have been
// applied first — it reads columns/tables/the view they create.

// Load the same .env the rest of the backend uses — same pattern as
// src/config/seed.js and scripts/seed-meta.js. This MUST happen before
// requiring ../src/models, since src/config/database.js reads
// process.env.DB_NAME/DB_HOST/etc. at construction time; without this the
// script silently tries to connect with undefined credentials.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const { QueryTypes } = require('sequelize');
const db = require('../src/models');
const { sequelize, CollectionSession, ShapeFeature, LetterAttempt, TeacherValidation } = db;
const { validateSession } = require('../src/utils/collectionProtocolValidation');

// Prints every field that can hold the real cause of a Sequelize/pg error —
// err.message alone is frequently empty or generic; the actual database
// error text usually lives on err.parent/err.original, and the failing SQL
// (if any) on err.sql.
function describeError(err) {
  console.error('name:   ', err?.name);
  console.error('message:', err?.message);
  console.error('parent message:  ', err?.parent?.message);
  console.error('original message:', err?.original?.message);
  if (err?.sql) console.error('sql:    ', err.sql);
  console.error('stack:\n', err?.stack);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function row(label, value) {
  console.log(`  ${label}: ${value}`);
}

async function scalar(sql) {
  const [result] = await sequelize.query(sql, { type: QueryTypes.SELECT });
  return Object.values(result)[0];
}

async function run() {
  // Confirms this script resolved the same database the backend connects
  // to — never logs DB_PASSWORD. If DB_NAME/DB_HOST print as "undefined",
  // .env wasn't found/loaded.
  console.log('DB config:', {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
  });

  await sequelize.authenticate();
  console.log('Data Collection Mode — readiness report (read-only)');
  console.log(new Date().toISOString());

  // ── Sessions ────────────────────────────────────────────────────────────
  section('Collection sessions');
  const sessions = await CollectionSession.findAll({ raw: true });
  row('Total collection sessions', sessions.length);
  row('Distinct students (sessions)', new Set(sessions.map(s => s.student_id)).size);
  const byStatus = {};
  for (const s of sessions) byStatus[s.capture_status] = (byStatus[s.capture_status] ?? 0) + 1;
  row('By capture_status', JSON.stringify(byStatus));

  // ── Coverage (collection_mode = true rows only) ────────────────────────
  section('Shapes / letters collected (collection_mode = true)');
  const shapeRows = await ShapeFeature.findAll({ where: { collection_mode: true }, raw: true });
  const letterRows = await LetterAttempt.findAll({ where: { collection_mode: true }, raw: true });
  const lowercaseRows = letterRows.filter(r => r.case_type === 'lowercase');
  const uppercaseRows = letterRows.filter(r => r.case_type === 'uppercase');

  row('Shape rows', shapeRows.length);
  row('Distinct shape types', [...new Set(shapeRows.map(r => r.shape_type))].sort().join(', ') || 'none');
  row('Lowercase letter-attempt rows', lowercaseRows.length);
  row('Distinct lowercase letters', [...new Set(lowercaseRows.map(r => r.letter))].sort().join(', ') || 'none');
  row('Uppercase letter-attempt rows', uppercaseRows.length);
  row('Distinct uppercase letters', [...new Set(uppercaseRows.map(r => r.letter))].sort().join(', ') || 'none');

  section('Attempts per task');
  function attemptCounts(rows, keyFn) {
    const counts = {};
    for (const r of rows) {
      const key = keyFn(r);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
  row('Attempts per shape type', JSON.stringify(attemptCounts(shapeRows, r => r.shape_type)));
  const lowercaseAttemptCounts = {};
  for (const r of lowercaseRows) lowercaseAttemptCounts[r.letter] = (lowercaseAttemptCounts[r.letter] ?? 0) + 1;
  row('Attempts per lowercase letter', JSON.stringify(lowercaseAttemptCounts));
  const uppercaseAttemptCounts = {};
  for (const r of uppercaseRows) uppercaseAttemptCounts[r.letter] = (uppercaseAttemptCounts[r.letter] ?? 0) + 1;
  row('Attempts per uppercase letter', JSON.stringify(uppercaseAttemptCounts));

  // ── Data quality ────────────────────────────────────────────────────────
  section('Missing / suspicious data (collection_mode = true rows)');
  const allRows = [...shapeRows, ...letterRows];
  const missingStrokePoints = allRows.filter(r => !Array.isArray(r.stroke_points) || r.stroke_points.length === 0).length;
  const missingFeatures     = allRows.filter(r => r.features == null || Object.keys(r.features).length === 0).length;
  const missingCanvasDims   = allRows.filter(r => r.canvas_width == null || r.canvas_height == null).length;
  const nullMotorScore      = allRows.filter(r => r.motor_score == null).length;
  const zeroDurationNonEmptyStrokes = allRows.filter(r =>
    Array.isArray(r.stroke_points) && r.stroke_points.length > 0 &&
    r.normalized_features && Number(r.normalized_features.duration_ms) === 0
  ).length;

  row('Rows with empty stroke_points', `${missingStrokePoints} / ${allRows.length}`);
  row('Rows with missing features', `${missingFeatures} / ${allRows.length}`);
  row('Rows with missing canvas_width/canvas_height', `${missingCanvasDims} / ${allRows.length}`);
  row('Rows with null motor_score', `${nullMotorScore} / ${allRows.length}`);
  row('Rows with duration_ms = 0 despite non-empty strokes (suspicious)', zeroDurationNonEmptyStrokes);

  // ── Protocol validation per session ────────────────────────────────────
  section('Incomplete sessions / duplicate protocol entries');
  let incompleteCount = 0;
  const allWarnings = [];
  for (const s of sessions) {
    const sShapes = shapeRows.filter(r => r.collection_session_id === s.id);
    const sLower  = lowercaseRows.filter(r => r.collection_session_id === s.id);
    const sUpper  = uppercaseRows.filter(r => r.collection_session_id === s.id);
    const warnings = validateSession({ shapeRows: sShapes, lowercaseRows: sLower, uppercaseRows: sUpper });
    if (warnings.length > 0) {
      incompleteCount++;
      allWarnings.push({ session: s.id, student_id: s.student_id, warnings });
    }
  }
  row('Sessions with at least one protocol warning', `${incompleteCount} / ${sessions.length}`);
  if (allWarnings.length > 0) {
    console.log('  Details:');
    for (const w of allWarnings) {
      console.log(`    session ${w.session} (student ${w.student_id}):`);
      for (const line of w.warnings) console.log(`      - ${line}`);
    }
  }

  // ── Teacher validation ──────────────────────────────────────────────────
  section('Teacher validation');
  const validations = await TeacherValidation.findAll({ raw: true });
  const validatedSessionIds = new Set(validations.filter(v => v.teacher_validated).map(v => v.collection_session_id));
  const missingValidation = sessions.filter(s => !validatedSessionIds.has(s.id));
  row('Sessions with teacher_validated = true', validatedSessionIds.size);
  row('Sessions missing teacher validation', `${missingValidation.length} / ${sessions.length}`);

  // ── ML export readiness ─────────────────────────────────────────────────
  section('ML export (handwriting_ml_samples)');
  try {
    const exportCount = await scalar(`
      SELECT COUNT(*) AS count FROM handwriting_ml_samples
      WHERE collection_mode = true AND capture_status = 'complete' AND collection_accepted = true
    `);
    row('Rows exportable today (item-12 filter)', exportCount);
  } catch (err) {
    row('Rows exportable today', 'ERROR — has migration 20260714000006 (the view) been applied? See details below.');
    describeError(err);
  }

  console.log('\nDone. No data was modified.');
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nReadiness script failed:');
    describeError(err);
    console.error('\nIf the message above mentions a missing column/table/view, run the pending migrations first:');
    console.error('  npx sequelize-cli db:migrate');
    console.error('If it mentions connection/auth (undefined host, ECONNREFUSED, password), check that auriva-backend/.env exists and has DB_HOST/DB_NAME/DB_USER/DB_PASSWORD set.');
    process.exit(1);
  });

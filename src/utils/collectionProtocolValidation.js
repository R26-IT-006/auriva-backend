'use strict';

// Mirrors the fixed research protocol defined on the frontend
// (auriva-frontend/src/constants/dataCollectionProtocol.js). Duplicated
// here deliberately — the backend and the mobile app are separate
// deployables and this validation must work from DB rows alone.
const EXPECTED_SHAPES = [
  'horizontal_line', 'vertical_line', 'full_circle',
  'half_circle', 'zigzag', 'curve_wave',
];
const EXPECTED_LOWERCASE = ['i', 'l', 't', 'o', 'c', 's', 'a', 'k', 'b', 'h'];
const EXPECTED_UPPERCASE = ['I', 'L', 'T', 'O', 'C', 'S', 'A', 'K', 'B', 'H'];
const ATTEMPTS_PER_LETTER = 3;

function hasStrokePoints(row) {
  return Array.isArray(row.stroke_points) && row.stroke_points.length > 0;
}

function hasFeatures(row) {
  return row.features != null && typeof row.features === 'object' && Object.keys(row.features).length > 0;
}

function describeRow(row) {
  return row.shape_type
    ? `shape "${row.shape_type}" (attempt ${row.attempt_number ?? '?'})`
    : `letter "${row.letter}" ${row.case_type ?? ''} (attempt ${row.attempt_number ?? '?'})`;
}

function checkLetterSet(rows, expectedLetters, label, warnings) {
  const countByLetter = {};
  for (const r of rows) countByLetter[r.letter] = (countByLetter[r.letter] ?? 0) + 1;

  const present = new Set(rows.map(r => r.letter));
  const missing = expectedLetters.filter(l => !present.has(l));
  if (missing.length > 0) {
    warnings.push(`Missing ${label} letters: ${missing.join(', ')}`);
  }

  for (const letter of expectedLetters) {
    if (!present.has(letter)) continue; // already reported above
    const count = countByLetter[letter];
    if (count !== ATTEMPTS_PER_LETTER) {
      warnings.push(`${label} letter "${letter}" has ${count} attempt row(s), expected ${ATTEMPTS_PER_LETTER}`);
    }
  }
}

function checkDuplicates(rows, keyFn, label, warnings) {
  const counts = {};
  for (const r of rows) {
    const key = keyFn(r);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const dups = Object.entries(counts).filter(([, c]) => c > 1).map(([k]) => k);
  if (dups.length > 0) {
    warnings.push(`Duplicate ${label} task session(s): ${dups.join(', ')}`);
  }
}

// Pure function over already-fetched rows — no DB access, so it's shared
// as-is between the completeCollectionSession controller endpoint and the
// read-only checkCollectionReadiness.js script (single source of truth,
// no risk of the two drifting apart).
//
// shapeRows: shape_features rows for one collection_session_id
// lowercaseRows / uppercaseRows: letter_attempts rows, split by case_type
function validateSession({ shapeRows = [], lowercaseRows = [], uppercaseRows = [] }) {
  const warnings = [];

  const shapesPresent = new Set(shapeRows.map(r => r.shape_type));
  const missingShapes  = EXPECTED_SHAPES.filter(s => !shapesPresent.has(s));
  if (missingShapes.length > 0) {
    warnings.push(`Missing shapes: ${missingShapes.join(', ')}`);
  }
  checkDuplicates(shapeRows, r => r.shape_type, 'shape', warnings);

  checkLetterSet(lowercaseRows, EXPECTED_LOWERCASE, 'lowercase', warnings);
  checkLetterSet(uppercaseRows, EXPECTED_UPPERCASE, 'uppercase', warnings);
  checkDuplicates(lowercaseRows, r => `lowercase:${r.letter}:attempt${r.attempt_number}`, 'lowercase letter', warnings);
  checkDuplicates(uppercaseRows, r => `uppercase:${r.letter}:attempt${r.attempt_number}`, 'uppercase letter', warnings);

  const allRows = [...shapeRows, ...lowercaseRows, ...uppercaseRows];

  // A single task_order legitimately appears on multiple rows (a letter's 3
  // attempt rows all share one task_order) — a real problem is a task_order
  // used by two *different* tasks (e.g. two different letters), not by
  // multiple attempts of the same task.
  const taskOrderToTasks = {};
  for (const r of allRows) {
    if (r.task_order == null) continue;
    const taskId = r.shape_type ? `shape:${r.shape_type}` : `letter:${r.case_type}:${r.letter}`;
    if (!taskOrderToTasks[r.task_order]) taskOrderToTasks[r.task_order] = new Set();
    taskOrderToTasks[r.task_order].add(taskId);
  }
  const conflicts = Object.entries(taskOrderToTasks).filter(([, tasks]) => tasks.size > 1);
  if (conflicts.length > 0) {
    warnings.push(`task_order reused by different tasks: ${conflicts.map(([o]) => o).join(', ')}`);
  }

  for (const row of allRows) {
    if (!hasStrokePoints(row)) warnings.push(`Empty stroke_points on ${describeRow(row)}`);
    if (!hasFeatures(row))     warnings.push(`Missing features on ${describeRow(row)}`);
  }

  return warnings;
}

module.exports = {
  EXPECTED_SHAPES,
  EXPECTED_LOWERCASE,
  EXPECTED_UPPERCASE,
  ATTEMPTS_PER_LETTER,
  validateSession,
};

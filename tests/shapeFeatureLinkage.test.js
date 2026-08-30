'use strict';

/**
 * ShapeFeature.assessment_id linkage — what the NULLs actually are.
 *
 * A previous audit reported "128 of 317 shape_features rows are unlinked" as a
 * P1 defect. It is not one. The `source` column splits the table perfectly:
 *
 *   source = 'initial_assessment'   189 rows   assessment_id ALWAYS set
 *   source = 'pre_writing_warmup'   128 rows   assessment_id ALWAYS null
 *
 * Warm-up captures are written with `assessment_id: null` deliberately
 * (handwritingController.submitPreWritingActivity) — they are practice
 * exercises, not initial-assessment evidence, and they must never contribute
 * to a motor baseline. `computeAuthoritativeFamilyProfile` filters on
 * assessment_id, so they correctly cannot.
 *
 * This suite exists so nobody "repairs" that NULL by back-linking warm-up
 * rows to an assessment, which would silently poison every progression
 * baseline with practice-exercise data.
 */

const fs = require('fs');
const path = require('path');

const controller = fs.readFileSync(
  path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
const authoritative = fs.readFileSync(
  path.resolve(__dirname, '../src/services/authoritativeMotorBaselineService.js'), 'utf8');

/** The `submitPreWritingActivity` row builder. */
function warmupRowBuilder() {
  const at = controller.indexOf("source:          'pre_writing_warmup'");
  expect(at).toBeGreaterThan(-1);
  return controller.slice(controller.lastIndexOf('const rows = results.map', at),
    controller.indexOf('ShapeFeature.bulkCreate(rows)', at));
}

// ─── The two writers ────────────────────────────────────────────────────

describe('there are exactly two ShapeFeature writers, with different linkage', () => {
  it('only two places create ShapeFeature rows at all', () => {
    const writes = controller.match(/ShapeFeature\.(bulkCreate|create)\(/g) ?? [];
    expect(writes).toHaveLength(2);
  });

  it('the initial assessment LINKS every row to its assessment', () => {
    // submitAssessment creates the assessment and all six shapes in one call,
    // so the id is always available — there is no window in which it is not.
    expect(controller).toMatch(/assessment_id:\s+assessment\.id,/);
  });

  it('pre-writing warm-ups deliberately write assessment_id: null', () => {
    const rows = warmupRowBuilder();
    expect(rows).toMatch(/assessment_id:\s+null,/);
    expect(rows).toMatch(/source:\s+'pre_writing_warmup',/);
  });

  it('warm-ups are refused in collection mode, so research data stays separate', () => {
    expect(controller).toMatch(/Pre-writing warm-ups are not part of collection mode/);
  });
});

// ─── Why the NULL is correct, not a defect ──────────────────────────────

describe('warm-up captures must never reach a motor baseline', () => {
  it('the authoritative profile reads ONLY rows tied to one assessment', () => {
    expect(authoritative).toMatch(
      /where: \{ student_id: studentId, assessment_id: assessmentId, collection_mode: false \}/);
  });

  it('SENTINEL — back-linking a warm-up row would poison the baseline', () => {
    // The guard is the query above: it selects by assessment_id. If a
    // warm-up row were ever given an assessment_id, it would be averaged into
    // that student's progression scores alongside the six real shapes.
    // This test fails the moment the warm-up writer stops writing null.
    const rows = warmupRowBuilder();
    expect(rows).not.toMatch(/assessment_id:\s+assessment/);
    expect(rows).not.toMatch(/assessment_id:\s+assessment_id/);
    expect(rows).not.toMatch(/assessment_id:\s+req\.body/);
  });

  it('the six assessment families are averaged from shape_type, not source', () => {
    expect(authoritative).toMatch(/horizontal_line', 'vertical_line'/);
    expect(authoritative).toMatch(/full_circle', 'half_circle'/);
    expect(authoritative).toMatch(/zigzag', 'curve_wave'/);
    // A warm-up activity_id is stored in shape_type too, which is exactly why
    // the assessment_id filter — not a shape_type filter — is what protects
    // the baseline.
    expect(authoritative).toMatch(/assessment_id: assessmentId/);
  });
});

// ─── Ownership ──────────────────────────────────────────────────────────

describe('ownership', () => {
  it('the assessment is created server-side from the authenticated request', () => {
    // The client never supplies an assessment_id for shape features: the same
    // call that creates the assessment writes its shapes, so a cross-student
    // id cannot be injected.
    const submit = controller.slice(controller.indexOf('async function submitAssessment'),
      controller.indexOf('async function submitPreWritingActivity'));
    expect(submit).not.toMatch(/req\.body\.assessment_id/);
    expect(submit).toMatch(/assessment_id:\s+assessment\.id/);
  });

  it('the warm-up endpoint checks student ownership before writing', () => {
    const warmup = controller.slice(controller.indexOf('async function submitPreWritingActivity'),
      controller.indexOf('async function getProgress'));
    expect(warmup).toMatch(/getOwnStudentById/);
  });
});

// ─── Historical rows are not to be mutated ──────────────────────────────

describe('historical unlinked rows', () => {
  it('no script back-links warm-up rows to an assessment', () => {
    const scriptsDir = path.resolve(__dirname, '../src/scripts');
    for (const file of fs.readdirSync(scriptsDir)) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/ShapeFeature[\s\S]{0,200}update\([\s\S]{0,120}assessment_id/);
    }
  });
});

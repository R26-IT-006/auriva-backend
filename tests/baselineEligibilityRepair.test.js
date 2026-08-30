'use strict';

/**
 * The baseline-eligibility repair.
 *
 * THE BUG (live, student 10): createInitialMotorBaseline picked "the earliest
 * non-collection assessment" and, if that row's motor_profile was unusable,
 * rejected the whole student — deliberately refusing to look further. Student
 * 10's earliest non-collection assessment (id 1, 2026-05-01) carries
 * motor_profile = NULL, while 59 valid assessments sit behind it. Result: no
 * baseline could EVER be created, no family thresholds were ever initialized,
 * and every letter fell back to GLOBAL_DEFAULT 55 permanently.
 *
 * The rule is now "earliest ELIGIBLE non-collection assessment". Chronology
 * still wins — it walks forward and takes the FIRST usable row, never a later
 * one when an earlier usable one exists.
 *
 * Nothing about the score maths changed: no formula, no margin, no clamping.
 */

const mockFindByPk        = jest.fn();
const mockAssessmentFindAll = jest.fn();
const mockBaselineFindOne = jest.fn();

// The selector now also requires linked initial-assessment shape evidence.
// Default: complete canonical evidence for every assessment queried, so an
// existing "this assessment is eligible" fixture still reads that way. Tests
// that care about missing/duplicate/non-finite evidence override it.
const CANONICAL_SHAPES = [
  'horizontal_line', 'vertical_line', 'full_circle', 'half_circle', 'zigzag', 'curve_wave',
];
const mockShapeFindAll = jest.fn(async (opts) => {
  const ids = opts?.where?.assessment_id;
  const list = Array.isArray(ids) ? ids : (ids == null ? [] : [ids]);
  return list.flatMap((assessment_id) =>
    CANONICAL_SHAPES.map((shape_type) => ({ assessment_id, shape_type, motor_score: 80 })));
});

const mockBaselineCreate  = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingAssessment: {
    findByPk: mockFindByPk,
    findOne:  jest.fn(),
    findAll:  mockAssessmentFindAll,
  },
  StudentMotorBaseline: { findOne: mockBaselineFindOne, create: mockBaselineCreate },
  ShapeFeature: { findAll: mockShapeFindAll },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  createInitialMotorBaseline, isEligibleInitialMotorAssessment, findEarliestEligibleAssessment,
} = require('../src/services/motorBaselineService');

const VALID_PROFILE = { straightScore: 72, curvedScore: 46, complexScore: 58 };

function assessment(over = {}) {
  return {
    id: 100, student_id: 10, collection_mode: false,
    motor_score: 61, motor_profile: { ...VALID_PROFILE },
    created_at: new Date('2026-05-08T00:00:00Z'),
    ...over,
  };
}

/** The exact shape of student 10's unusable first row. */
const BROKEN_FIRST = assessment({
  id: 1, motor_score: null, motor_profile: null,
  created_at: new Date('2026-05-01T00:00:00Z'),
});

beforeEach(() => {
  mockShapeFindAll.mockClear();
  jest.clearAllMocks();
  mockFindByPk.mockReset();
  mockAssessmentFindAll.mockReset();
  mockBaselineFindOne.mockReset();
  mockBaselineCreate.mockReset();
  mockBaselineFindOne.mockResolvedValue(null);
  mockBaselineCreate.mockImplementation(async (row) => ({ id: 999, ...row }));
});

// ─── The predicate ──────────────────────────────────────────────────────

describe('isEligibleInitialMotorAssessment', () => {
  it('accepts a normal assessment with a valid profile and score', () => {
    expect(isEligibleInitialMotorAssessment(assessment())).toEqual({ eligible: true, reason: null });
  });

  it('rejects a research/collection-protocol assessment', () => {
    expect(isEligibleInitialMotorAssessment(assessment({ collection_mode: true })))
      .toEqual({ eligible: false, reason: 'collection_assessment_not_eligible' });
  });

  it('rejects exactly what the baseline calculation cannot use', () => {
    const cases = [
      [{ motor_profile: null }, 'motor_profile_missing'],
      [{ motor_profile: { curvedScore: 1, complexScore: 1 } }, 'missing_straight_score'],
      [{ motor_profile: { straightScore: 1, complexScore: 1 } }, 'missing_curved_score'],
      [{ motor_profile: { straightScore: 1, curvedScore: 1 } }, 'missing_complex_score'],
      [{ motor_score: null }, 'invalid_overall_motor_score'],
      // NaN is reported as "missing", not "invalid" — the validator's own
      // long-standing vocabulary, unchanged by this repair.
      [{ motor_profile: { ...VALID_PROFILE, straightScore: NaN } }, 'missing_straight_score'],
      [{ motor_profile: { ...VALID_PROFILE, curvedScore: 101 } }, 'curved_score_out_of_range'],
    ];
    for (const [over, reason] of cases) {
      expect(isEligibleInitialMotorAssessment(assessment(over)))
        .toEqual({ eligible: false, reason });
    }
  });

  it('adds NO requirement the baseline calculation does not need', () => {
    // is_initial is documented as unreliable and must not gate eligibility;
    // nor must the presence of ShapeFeature rows (those feed progression_*,
    // which is attached separately and may legitimately be absent).
    expect(isEligibleInitialMotorAssessment(assessment({ is_initial: false })).eligible).toBe(true);
    expect(isEligibleInitialMotorAssessment(assessment({ finalized_at: null })).eligible).toBe(true);
  });

  it('never throws on a missing row', () => {
    expect(isEligibleInitialMotorAssessment(null))
      .toEqual({ eligible: false, reason: 'assessment_missing' });
  });
});

// ─── Chronology ─────────────────────────────────────────────────────────

describe('findEarliestEligibleAssessment walks forward in time', () => {
  it('SENTINEL — student 10 exactly: broken first row, valid rows behind it', async () => {
    const good = assessment({ id: 101, created_at: new Date('2026-05-08T00:00:00Z') });
    mockAssessmentFindAll.mockResolvedValue([BROKEN_FIRST, good]);

    const { assessment: chosen, skipped } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen.id).toBe(101);
    // ...and it reports what it stepped over rather than hiding it.
    expect(skipped).toEqual([{ id: 1, reason: 'motor_profile_missing' }]);
  });

  it('still picks the FIRST row when the first row is valid', async () => {
    const first  = assessment({ id: 10, created_at: new Date('2026-05-01T00:00:00Z') });
    const second = assessment({ id: 11, created_at: new Date('2026-05-02T00:00:00Z') });
    mockAssessmentFindAll.mockResolvedValue([first, second]);

    const { assessment: chosen, skipped } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen.id).toBe(10);
    expect(skipped).toEqual([]);
  });

  it('picks the EARLIER of two valid rows, never the later one', async () => {
    const bad    = assessment({ id: 1, motor_profile: null, created_at: new Date('2026-05-01T00:00:00Z') });
    const valid2 = assessment({ id: 2, created_at: new Date('2026-05-02T00:00:00Z') });
    const valid3 = assessment({ id: 3, created_at: new Date('2026-05-03T00:00:00Z') });
    mockAssessmentFindAll.mockResolvedValue([bad, valid2, valid3]);

    const { assessment: chosen } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen.id).toBe(2);   // never 3
  });

  it('returns nothing when no row is usable — never a fabricated choice', async () => {
    mockAssessmentFindAll.mockResolvedValue([
      BROKEN_FIRST, assessment({ id: 2, motor_score: null }),
    ]);
    const { assessment: chosen, skipped } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen).toBeNull();
    expect(skipped).toHaveLength(2);
  });

  it('queries only non-collection assessments, oldest first', async () => {
    mockAssessmentFindAll.mockResolvedValue([]);
    await findEarliestEligibleAssessment({ studentId: 10 });
    const opts = mockAssessmentFindAll.mock.calls[0][0];
    expect(opts.where).toEqual({ student_id: 10, collection_mode: false });
    expect(opts.order).toEqual([['created_at', 'ASC'], ['id', 'ASC']]);
  });
});

// ─── End-to-end through createInitialMotorBaseline ──────────────────────

describe('createInitialMotorBaseline with the repaired rule', () => {
  it('SENTINEL — the student-10 pattern now produces a baseline', async () => {
    const good = assessment({ id: 101 });
    mockFindByPk.mockResolvedValue(good);
    mockAssessmentFindAll.mockResolvedValue([BROKEN_FIRST, good]);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 101 });

    expect(res.status).toBe('created');
    // Legacy descriptive fields, copied verbatim — never recomputed.
    expect(res.baseline.straight_score).toBe(72);
    expect(res.baseline.curved_score).toBe(46);
    expect(res.baseline.complex_score).toBe(58);
    expect(res.baseline.overall_motor_score).toBe(61);
    // ...and progression_* is NOT written here: it belongs to the
    // authoritative attach step, from ShapeFeature.motor_score.
    const written = mockBaselineCreate.mock.calls[0][0];
    expect(written).not.toHaveProperty('progression_straight_score');
  });

  it('OLD BEHAVIOUR would have failed on that same input', async () => {
    // Proof the repair is load-bearing: under "earliest, eligible or not",
    // the chosen row is the broken one and its id never matches.
    const oldChoice = [BROKEN_FIRST, assessment({ id: 101 })][0];
    expect(oldChoice.id).toBe(1);
    expect(isEligibleInitialMotorAssessment(oldChoice).eligible).toBe(false);
  });

  it('a LATER valid assessment is still refused when an earlier valid one exists', async () => {
    const earlier = assessment({ id: 2, created_at: new Date('2026-05-02T00:00:00Z') });
    const later   = assessment({ id: 3, created_at: new Date('2026-05-03T00:00:00Z') });
    mockFindByPk.mockResolvedValue(later);
    mockAssessmentFindAll.mockResolvedValue([earlier, later]);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 3 });
    expect(res.status).toBe('not_initial_assessment');
    expect(res.reason).toBe('earlier_eligible_assessment_exists');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });

  it('an unusable assessment still reports its OWN specific reason', async () => {
    // Not the generic "not the initial one" — the caller and the backfill
    // both need to know WHY the data could not be used.
    mockFindByPk.mockResolvedValue(BROKEN_FIRST);
    mockAssessmentFindAll.mockResolvedValue([BROKEN_FIRST]);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 1 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('motor_profile_missing');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });

  it('no eligible assessment anywhere → no fabricated baseline', async () => {
    const other = assessment({ id: 2, motor_score: null });
    mockFindByPk.mockResolvedValue(assessment({ id: 3 }));
    mockAssessmentFindAll.mockResolvedValue([BROKEN_FIRST, other]);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 3 });
    expect(res.status).toBe('not_initial_assessment');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });

  it('a collection-mode assessment is still refused outright', async () => {
    const research = assessment({ id: 50, collection_mode: true });
    mockFindByPk.mockResolvedValue(research);
    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 50 });
    expect(res.status).toBe('collection_assessment_not_eligible');
    expect(mockAssessmentFindAll).not.toHaveBeenCalled();
  });

  it('remains idempotent — a second call creates no second row', async () => {
    const good = assessment({ id: 101 });
    mockFindByPk.mockResolvedValue(good);
    mockAssessmentFindAll.mockResolvedValue([BROKEN_FIRST, good]);
    mockBaselineFindOne.mockResolvedValueOnce({ id: 5, source_assessment_id: 101 });

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 101 });
    expect(res.status).toBe('already_exists');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });
});

// ─── The score maths is untouched ───────────────────────────────────────

describe('nothing about threshold mathematics changed', () => {
  it('the margin is still 5 and is still not clamped above 100', () => {
    const svc = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/dynamicThresholdService.js'), 'utf8');
    expect(svc).toMatch(/const INITIAL_THRESHOLD_MARGIN = 5;/);
    expect(svc).toMatch(/status: 'requires_review', reason: 'target_exceeds_score_range'/);
    expect(svc).toMatch(/Deliberately NOT clamped to 100/);
  });

  it('the global fallback is still 55, and still only a fallback', () => {
    const resolver = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/progressionThresholdResolver.js'), 'utf8');
    expect(resolver).toMatch(/const GLOBAL_DEFAULT = 55;/);
    expect(resolver).toMatch(/SOURCE_GLOBAL_SAFE_FALLBACK/);
  });

  it('progression_* comes from ShapeFeature.motor_score, never the legacy fields', () => {
    const auth = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/authoritativeMotorBaselineService.js'), 'utf8');
    expect(auth).toMatch(/attributes: \['shape_type', 'motor_score'\]/);
    expect(auth).toMatch(/progression_straight_score: profileResult\.scores\.straight/);
    // The legacy trio must never be the source of a progression value.
    const code = auth.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/progression_\w+_score:\s*\w*\.(straight|curved|complex)_score/);
  });

  it('the authoritative profile refuses research-protocol shape rows', () => {
    const auth = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/authoritativeMotorBaselineService.js'), 'utf8');
    expect(auth).toMatch(/collection_mode: false/);
  });
});

// ─── Operational eligibility: legacy profile + canonical shape evidence ──

const { evaluateShapeEvidence, REQUIRED_SHAPES } = require('../src/services/motorBaselineService');

/** Complete canonical evidence for one assessment. */
const fullEvidence = (assessment_id, score = 80) =>
  REQUIRED_SHAPES.map((shape_type) => ({ assessment_id, shape_type, motor_score: score }));

describe('the canonical shape set, not a row count', () => {
  it('is the SAME six tasks the authoritative profile averages over', () => {
    expect([...REQUIRED_SHAPES].sort()).toEqual([
      'curve_wave', 'full_circle', 'half_circle', 'horizontal_line', 'vertical_line', 'zigzag',
    ]);
    // Derived from FAMILY_SHAPES, never a second hand-written list.
    const svc = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/motorBaselineService.js'), 'utf8');
    expect(svc).toMatch(/Object\.values\(FAMILY_SHAPES\)\.flat\(\)/);
  });

  it('accepts a complete six-shape assessment', () => {
    expect(evaluateShapeEvidence(fullEvidence(1)))
      .toEqual({ sufficient: true, reason: null, missing: [] });
  });

  it('rejects 5 of 6 — an incomplete assessment is not a baseline', () => {
    const five = fullEvidence(1).slice(0, 5);
    const res = evaluateShapeEvidence(five);
    expect(res.sufficient).toBe(false);
    expect(res.missing).toEqual(['curve_wave']);
  });

  it('SENTINEL — six DUPLICATE rows do not satisfy the set', () => {
    // COUNT(*) >= 6 would have passed this and produced a baseline with two
    // null progression families.
    const dupes = Array.from({ length: 6 },
      () => ({ assessment_id: 1, shape_type: 'horizontal_line', motor_score: 80 }));
    const res = evaluateShapeEvidence(dupes);
    expect(res.sufficient).toBe(false);
    expect(res.missing).toHaveLength(5);
  });

  it('rejects a required shape whose motor_score is not finite', () => {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, '80']) {
      const rows = fullEvidence(1).map((r, i) => (i === 2 ? { ...r, motor_score: bad } : r));
      const res = evaluateShapeEvidence(rows);
      expect(res.sufficient).toBe(false);
      expect(res.missing).toEqual(['full_circle']);
    }
  });

  it('treats absent evidence as insufficient, never as "fine"', () => {
    expect(evaluateShapeEvidence(undefined).sufficient).toBe(false);
    expect(evaluateShapeEvidence([]).sufficient).toBe(false);
  });
});

describe('findEarliestEligibleAssessment applies BOTH halves', () => {
  const mkShape = (rowsByAssessment) =>
    mockShapeFindAll.mockImplementation(async (opts) => {
      const ids = opts?.where?.assessment_id ?? [];
      return (Array.isArray(ids) ? ids : [ids]).flatMap((id) => rowsByAssessment[id] ?? []);
    });

  it('SENTINEL — student 10 exactly: 101 has a valid profile but NO evidence, 176 has both', async () => {
    const a101 = assessment({ id: 101, created_at: new Date('2026-05-08T00:00:00Z') });
    const a176 = assessment({ id: 176, created_at: new Date('2026-06-17T00:00:00Z') });
    mockAssessmentFindAll.mockResolvedValue([a101, a176]);
    mkShape({ 176: fullEvidence(176) });   // 101 has none

    const { assessment: chosen, skipped } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen.id).toBe(176);
    expect(skipped).toEqual([
      { id: 101, reason: 'incomplete_shape_evidence', missing: [...REQUIRED_SHAPES] },
    ]);
  });

  it('an EARLIER fully eligible assessment still wins', async () => {
    const early = assessment({ id: 5, created_at: new Date('2026-05-01T00:00:00Z') });
    const late  = assessment({ id: 6, created_at: new Date('2026-06-01T00:00:00Z') });
    mockAssessmentFindAll.mockResolvedValue([early, late]);
    mkShape({ 5: fullEvidence(5), 6: fullEvidence(6) });

    const { assessment: chosen } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen.id).toBe(5);
  });

  it('no fully eligible assessment → nothing selected, fallback 55 stays', async () => {
    const a = assessment({ id: 9 });
    mockAssessmentFindAll.mockResolvedValue([a]);
    mkShape({ 9: fullEvidence(9).slice(0, 4) });   // incomplete

    const { assessment: chosen, skipped } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen).toBeNull();
    expect(skipped[0].reason).toBe('incomplete_shape_evidence');
  });

  it('queries ONLY initial_assessment evidence — warm-ups can never qualify', async () => {
    mockAssessmentFindAll.mockResolvedValue([assessment({ id: 3 })]);
    mkShape({ 3: fullEvidence(3) });
    await findEarliestEligibleAssessment({ studentId: 10 });

    const where = mockShapeFindAll.mock.calls[0][0].where;
    expect(where.source).toBe('initial_assessment');
    expect(where.collection_mode).toBe(false);
    expect(where.student_id).toBe(10);
  });

  it('uses ONE evidence query for all candidates, not one per assessment', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      assessment({ id: 100 + i, created_at: new Date(2026, 0, i + 1) }));
    mockAssessmentFindAll.mockResolvedValue(many);
    mkShape({ 119: fullEvidence(119) });

    await findEarliestEligibleAssessment({ studentId: 10 });
    expect(mockShapeFindAll).toHaveBeenCalledTimes(1);
  });

  it('an evidence read failure fails CLOSED — no unverified baseline', async () => {
    mockAssessmentFindAll.mockResolvedValue([assessment({ id: 3 })]);
    mockShapeFindAll.mockRejectedValue(new Error('db down'));

    const { assessment: chosen } = await findEarliestEligibleAssessment({ studentId: 10 });
    expect(chosen).toBeNull();
  });

  it('the backfill uses this same selector — one definition, no drift', () => {
    const script = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/scripts/backfillMotorBaselines.js'), 'utf8');
    expect(script).toMatch(/findEarliestEligibleAssessment/);
    expect(script).not.toMatch(/collection_mode: false,\s*\n\s*\},\s*\n\s*order: \[\['created_at'/);
  });
});

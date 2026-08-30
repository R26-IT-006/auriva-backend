'use strict';

// Motor Score Unification, Phase 2 — authoritativeMotorBaselineService.js.
const mockShapeFeatureFindAll = jest.fn();
const mockBaselineFindOne = jest.fn();

jest.mock('../src/models', () => ({
  ShapeFeature: { findAll: (...a) => mockShapeFeatureFindAll(...a) },
  StudentMotorBaseline: { findOne: (...a) => mockBaselineFindOne(...a) },
}));

const { computeAuthoritativeFamilyProfile, attachAuthoritativeFamilyProfile } = require('../src/services/authoritativeMotorBaselineService');

const STUDENT_ID = 10;
const ASSESSMENT_ID = 55;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('computeAuthoritativeFamilyProfile', () => {
  it('averages ShapeFeature.motor_score per family, mirroring calculateMotorProfile\'s own shape grouping', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([
      { shape_type: 'horizontal_line', motor_score: 80 },
      { shape_type: 'vertical_line',   motor_score: 90 },
      { shape_type: 'full_circle',     motor_score: 70 },
      { shape_type: 'half_circle',     motor_score: 60 },
      { shape_type: 'zigzag',          motor_score: 50 },
      { shape_type: 'curve_wave',      motor_score: 40 },
    ]);
    const result = await computeAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    expect(result.status).toBe('computed');
    expect(result.scores).toEqual({ straight: 85, curved: 65, complex: 45 });
  });

  it('the query is collection_mode: false and scoped to this exact assessment_id — never mixes research rows or other assessments', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([]);
    await computeAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    const whereArg = mockShapeFeatureFindAll.mock.calls[0][0].where;
    expect(whereArg).toEqual({ student_id: STUDENT_ID, assessment_id: ASSESSMENT_ID, collection_mode: false });
  });

  it('a family with no matching shape rows averages to null, never a fabricated 0', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([
      { shape_type: 'horizontal_line', motor_score: 80 },
      { shape_type: 'vertical_line',   motor_score: 90 },
      // curved/complex shapes entirely missing from this (malformed) export
    ]);
    const result = await computeAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    expect(result.scores.straight).toBe(85);
    expect(result.scores.curved).toBeNull();
    expect(result.scores.complex).toBeNull();
  });

  it('no ShapeFeature rows at all -> status no_shape_features, never a crash', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([]);
    const result = await computeAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    expect(result.status).toBe('no_shape_features');
    expect(result.scores).toBeNull();
  });

  it('invalid ids rejected without ever querying the DB', async () => {
    const result = await computeAuthoritativeFamilyProfile({ studentId: -1, assessmentId: ASSESSMENT_ID });
    expect(result.status).toBe('invalid_input');
    expect(mockShapeFeatureFindAll).not.toHaveBeenCalled();
  });
});

describe('attachAuthoritativeFamilyProfile', () => {
  it('writes progression_*_score onto the EXISTING baseline row, never straight_score/curved_score/complex_score', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([
      { shape_type: 'horizontal_line', motor_score: 80 }, { shape_type: 'vertical_line', motor_score: 90 },
      { shape_type: 'full_circle', motor_score: 70 }, { shape_type: 'half_circle', motor_score: 60 },
      { shape_type: 'zigzag', motor_score: 50 }, { shape_type: 'curve_wave', motor_score: 40 },
    ]);
    const update = jest.fn().mockResolvedValue(undefined);
    mockBaselineFindOne.mockResolvedValueOnce({ update });

    const result = await attachAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });

    expect(result.status).toBe('computed');
    expect(update).toHaveBeenCalledWith({
      progression_straight_score: 85, progression_curved_score: 65, progression_complex_score: 45,
    });
    const updateArg = update.mock.calls[0][0];
    expect(updateArg).not.toHaveProperty('straight_score');
    expect(updateArg).not.toHaveProperty('curved_score');
    expect(updateArg).not.toHaveProperty('complex_score');
  });

  it('no baseline row found -> baseline_not_found, never throws', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([{ shape_type: 'horizontal_line', motor_score: 80 }]);
    mockBaselineFindOne.mockResolvedValueOnce(null);
    const result = await attachAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    expect(result.status).toBe('baseline_not_found');
  });

  it('a DB failure during the update resolves to save_failed, never throws (non-fatal, spec §7)', async () => {
    mockShapeFeatureFindAll.mockResolvedValueOnce([{ shape_type: 'horizontal_line', motor_score: 80 }]);
    mockBaselineFindOne.mockResolvedValueOnce({ update: jest.fn().mockRejectedValue(new Error('db down')) });
    const result = await attachAuthoritativeFamilyProfile({ studentId: STUDENT_ID, assessmentId: ASSESSMENT_ID });
    expect(result.status).toBe('save_failed');
  });
});

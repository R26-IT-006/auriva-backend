'use strict';

// Feature 9 Step 3 — getTeacherValidationHistory() and
// getLatestValidationForRecommendation() read-path tests. Mocks only
// ../src/models (findAll/findOne) — matches the read-only test discipline
// every prior feature's own history/read-service test files already used.
// No live DB write ever happens in this file; both functions under test are
// read-only, and the mock model exposes no write methods at all.

jest.mock('../src/models', () => ({
  TeacherRecommendationValidation: { findAll: jest.fn(), findOne: jest.fn() },
}));

const { TeacherRecommendationValidation } = require('../src/models');
const {
  getTeacherValidationHistory, getLatestValidationForRecommendation,
} = require('../src/services/teacherRecommendationValidationService');

const STUDENT_ID = 13;
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

function row(overrides = {}) {
  return {
    id: 1,
    student_id: STUDENT_ID,
    teacher_id: 4,
    case_type: 'lowercase',
    family: 'curved',
    recommendation_type: 'motor_family_practice',
    recommendation_title: 'Curved Movement Practice',
    focus_letters: ['c', 'o'],
    suggested_activities: ['Circle tracing exercises'],
    rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods.',
    validation: 'confirmed',
    teacher_note: null,
    evidence_fingerprint: FP_A,
    recommendation_fingerprint: FP_A,
    persistent_policy_version: 'persistent_difficulty_v1',
    recommendation_policy_version: 'worksheet_recommendation_v1',
    mapping_version: 'letter-baseline-family-v1',
    created_at: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  TeacherRecommendationValidation.findAll.mockReset();
  TeacherRecommendationValidation.findOne.mockReset();
});

// ─── 57-69: getTeacherValidationHistory ─────────────────────────────────────

describe('getTeacherValidationHistory', () => {
  it('57. an empty history returns an empty events array and empty latestByStream', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(result.status).toBe('evaluated');
    expect(result.events).toEqual([]);
    expect(result.latestByStream.lowercase).toEqual({});
    expect(result.latestByStream.uppercase).toEqual({});
  });

  it('58. requests newest-first ordering and preserves the DB-given order (never re-sorted client-side)', async () => {
    const newer = row({ id: 2, created_at: new Date('2026-08-12T00:00:00.000Z') });
    const older = row({ id: 1, created_at: new Date('2026-08-10T00:00:00.000Z') });
    TeacherRecommendationValidation.findAll.mockResolvedValue([newer, older]);

    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });

    expect(TeacherRecommendationValidation.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ order: [['created_at', 'DESC'], ['id', 'DESC']] })
    );
    expect(result.events.map((e) => e.id)).toEqual([2, 1]);
  });

  it('59. an id tiebreak is requested as the secondary sort key', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([]);
    await getTeacherValidationHistory({ studentId: STUDENT_ID });
    const [{ order }] = TeacherRecommendationValidation.findAll.mock.calls[0];
    expect(order[1]).toEqual(['id', 'DESC']);
  });

  it('60. a caseType filter narrows the where clause', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([]);
    await getTeacherValidationHistory({ studentId: STUDENT_ID, caseType: 'uppercase' });
    const [{ where }] = TeacherRecommendationValidation.findAll.mock.calls[0];
    expect(where.case_type).toBe('uppercase');
  });

  it('61. a family filter narrows the where clause', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([]);
    await getTeacherValidationHistory({ studentId: STUDENT_ID, family: 'straight' });
    const [{ where }] = TeacherRecommendationValidation.findAll.mock.calls[0];
    expect(where.family).toBe('straight');
  });

  it('62. an invalid filter value returns invalid_input, not a silently-ignored filter', async () => {
    const badCaseType = await getTeacherValidationHistory({ studentId: STUDENT_ID, caseType: 'mixedcase' });
    expect(badCaseType.status).toBe('invalid_input');
    const badFamily = await getTeacherValidationHistory({ studentId: STUDENT_ID, family: 'diagonal' });
    expect(badFamily.status).toBe('invalid_input');
    expect(TeacherRecommendationValidation.findAll).not.toHaveBeenCalled();
  });

  it('63. returns the safe public event shape', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row()]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(result.events[0]).toEqual({
      id: 1,
      caseType: 'lowercase',
      family: 'curved',
      recommendation: { type: 'motor_family_practice', title: 'Curved Movement Practice', focusLetters: ['c', 'o'] },
      validation: 'confirmed',
      teacherNote: null,
      validatedAt: '2026-08-10T00:00:00.000Z',
    });
  });

  it('64. fingerprints are excluded from the public event shape', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row()]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    const serialized = JSON.stringify(result.events[0]);
    expect(serialized).not.toMatch(/evidence_fingerprint|evidenceFingerprint/);
    expect(serialized).not.toMatch(/recommendation_fingerprint|recommendationFingerprint/);
  });

  it('65. policy/mapping versions are excluded from the public event shape', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row()]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    const serialized = JSON.stringify(result.events[0]);
    expect(serialized).not.toMatch(/policy_version|PolicyVersion|mapping_version|mappingVersion/);
  });

  it('66. teacherId is excluded from the public event shape', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row()]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    const serialized = JSON.stringify(result.events[0]);
    expect(serialized).not.toMatch(/teacher_id|teacherId/);
  });

  it('67. teacherNote is returned when present', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row({ teacher_note: 'Tired today' })]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(result.events[0].teacherNote).toBe('Tired today');
  });

  it('68. the recommendation snapshot (type/title/focusLetters) is returned', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row()]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(result.events[0].recommendation).toEqual({
      type: 'motor_family_practice', title: 'Curved Movement Practice', focusLetters: ['c', 'o'],
    });
  });

  it('69. latestByStream picks the first (newest) row per (caseType, family)', async () => {
    const newerCurved = row({ id: 2, validation: 'dismissed', created_at: new Date('2026-08-12T00:00:00.000Z') });
    const olderCurved = row({ id: 1, validation: 'confirmed', created_at: new Date('2026-08-10T00:00:00.000Z') });
    const straightUpper = row({
      id: 3, case_type: 'uppercase', family: 'straight', validation: 'confirmed',
      created_at: new Date('2026-08-11T00:00:00.000Z'),
    });
    // Already newest-first, as the real DB ORDER BY would return.
    TeacherRecommendationValidation.findAll.mockResolvedValue([straightUpper, newerCurved, olderCurved]);

    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });

    expect(result.latestByStream.lowercase.curved.validation).toBe('dismissed');
    expect(result.latestByStream.uppercase.straight.validation).toBe('confirmed');
    expect(result.latestByStream.lowercase.straight).toBeUndefined();
  });
});

// ─── 70-77: getLatestValidationForRecommendation ────────────────────────────

describe('getLatestValidationForRecommendation', () => {
  it('70. no matching event returns current: null', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_A,
    });
    expect(result.status).toBe('evaluated');
    expect(result.current).toBeNull();
  });

  it('71. one matching event returns its validation/teacherNote/validatedAt', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(row({ teacher_note: 'Focus on o before c' }));
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_A,
    });
    expect(result.current).toEqual({
      validation: 'confirmed', teacherNote: 'Focus on o before c', validatedAt: '2026-08-10T00:00:00.000Z',
    });
  });

  it('72. two actions on the same fingerprint resolve to the latest (query orders newest-first; mock simulates the DB pick)', async () => {
    // The service asks the DB for ORDER BY created_at DESC, id DESC LIMIT
    // effectively 1 (findOne) — this test simulates the DB already having
    // resolved "confirmed then dismissed" to the latest ('dismissed') row.
    TeacherRecommendationValidation.findOne.mockResolvedValue(row({ id: 2, validation: 'dismissed' }));
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_A,
    });
    expect(result.current.validation).toBe('dismissed');

    const [{ order }] = TeacherRecommendationValidation.findOne.mock.calls[0];
    expect(order).toEqual([['created_at', 'DESC'], ['id', 'DESC']]);
  });

  it('73. a new recommendation fingerprint does not inherit an older fingerprint\'s validation', async () => {
    // Querying with FP_B (new evidence) — the mock represents the DB
    // correctly finding no row, because the prior events were all written
    // against FP_A.
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_B,
    });
    expect(result.current).toBeNull();
    const [{ where }] = TeacherRecommendationValidation.findOne.mock.calls[0];
    expect(where.recommendation_fingerprint).toBe(FP_B);
  });

  it('74. the query is scoped by recommendation_fingerprint, not just (student, case, family) — same stream, different evidence stays separate', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_B,
    });
    const [{ where }] = TeacherRecommendationValidation.findOne.mock.calls[0];
    expect(Object.keys(where).sort()).toEqual(
      ['student_id', 'case_type', 'family', 'recommendation_fingerprint'].sort()
    );
  });

  it('75. case isolation — the where clause includes the requested case_type', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'uppercase', family: 'curved', recommendationFingerprint: FP_A,
    });
    const [{ where }] = TeacherRecommendationValidation.findOne.mock.calls[0];
    expect(where.case_type).toBe('uppercase');
  });

  it('76. family isolation — the where clause includes the requested family', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'straight', recommendationFingerprint: FP_A,
    });
    const [{ where }] = TeacherRecommendationValidation.findOne.mock.calls[0];
    expect(where.family).toBe('straight');
  });

  it('77. student isolation — the where clause includes the requested student_id', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    await getLatestValidationForRecommendation({
      studentId: 10, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_A,
    });
    const [{ where }] = TeacherRecommendationValidation.findOne.mock.calls[0];
    expect(where.student_id).toBe(10);
  });

  it('rejects invalid input without querying the model', async () => {
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'mixedcase', family: 'curved', recommendationFingerprint: FP_A,
    });
    expect(result.status).toBe('invalid_input');
    expect(TeacherRecommendationValidation.findOne).not.toHaveBeenCalled();
  });
});

// ─── read-only guarantee (spec §70) ──────────────────────────────────────────

describe('read-only guarantee for both history functions (spec §70)', () => {
  it('getTeacherValidationHistory never calls a write method on the model mock', async () => {
    TeacherRecommendationValidation.findAll.mockResolvedValue([row()]);
    await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(TeacherRecommendationValidation.findOne).not.toHaveBeenCalled();
    // The mock exposes no create/update/destroy/findOrCreate methods at all
    // for this file — calling any of them would throw, which no test here does.
  });

  it('getLatestValidationForRecommendation never calls findAll', async () => {
    TeacherRecommendationValidation.findOne.mockResolvedValue(null);
    await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP_A,
    });
    expect(TeacherRecommendationValidation.findAll).not.toHaveBeenCalled();
  });
});

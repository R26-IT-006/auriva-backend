'use strict';

// Feature 2 Step 7 — recordLetterCompletion()'s integration with
// resolveProgressionThreshold(). Mocks progressionThresholdResolver
// directly (its own behavior is exhaustively covered by
// tests/progressionThresholdResolver.test.js) so these tests focus purely
// on the CONTROLLER's use of the resolution result: gating math, response
// shape, and — critically — every existing side effect (LetterAttempt
// persistence, blocked_attempts, legacy auto-lower/auto-raise, collection
// mode) firing exactly where it did before Step 7.
//
// Step 8 note: dynamicThresholdService (processDynamicThresholdAfterLetterSession)
// is ALSO mocked here — its own behavior is exhaustively covered by
// tests/dynamicThresholdOrchestration.test.js and
// tests/recordLetterCompletionOrchestration.test.js. Isolating it here keeps
// these Step 7 tests from depending on real DB-shaped mocks they were never
// designed to provide.
const mockResolveProgressionThreshold = jest.fn();
const mockGetStudentThreshold = jest.fn();
const mockProcessDynamicThresholdAfterLetterSession = jest.fn();

const mockLetterProgressFindOrCreate = jest.fn();
const mockLetterProgressFindOne = jest.fn();
const mockLetterProgressFindAll = jest.fn();
const mockStudentFindByPk = jest.fn();
const mockLetterAttemptBulkCreate = jest.fn();

jest.mock('../src/services/progressionThresholdResolver', () => ({
  resolveProgressionThreshold: (...a) => mockResolveProgressionThreshold(...a),
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  processDynamicThresholdAfterLetterSession: (...a) => mockProcessDynamicThresholdAfterLetterSession(...a),
}));

jest.mock('../src/utils/thresholdUtils', () => ({
  getStudentThreshold: (...a) => mockGetStudentThreshold(...a),
}));

jest.mock('../src/models', () => ({
  HandwritingAssessment: {},
  LetterProgress: {
    findOrCreate: (...a) => mockLetterProgressFindOrCreate(...a),
    findOne:      (...a) => mockLetterProgressFindOne(...a),
    findAll:      (...a) => mockLetterProgressFindAll(...a),
  },
  Student: { findByPk: (...a) => mockStudentFindByPk(...a) },
  ExplanationResult: {}, RecommendationHistory: {}, StudentMotorFeature: {}, ShapeFeature: {},
  LetterAttempt: { bulkCreate: (...a) => mockLetterAttemptBulkCreate(...a) },
}));

jest.mock('../src/utils/featureNormalization', () => ({
  normalizeShapeFeatures: jest.fn(),
  normalizeLetterFeatures: jest.fn().mockReturnValue({ normalized: { stroke_order_meta: null }, validity: {} }),
}));

// Motor Score Unification — computeMotorScore() is now the authoritative
// score source for recordLetterCompletion's own pass/fail decision, so
// this mock is controllable per-test (default 80) rather than fixed.
const mockComputeMotorScore = jest.fn();
jest.mock('../src/utils/motorScore', () => ({
  computeMotorScore: (...a) => mockComputeMotorScore(...a),
}));

jest.mock('../src/services/explainabilityService', () => ({ analyzeMotorDifficulty: jest.fn() }));
jest.mock('../src/services/motorBaselineService', () => ({ createInitialMotorBaseline: jest.fn(), getStudentMotorBaseline: jest.fn() }));
// Pre-device P0 fix (Blocker 2) — recordLetterCompletion now verifies
// ownership before any write. mockGetOwnStudentById resolves successfully
// by default; authorization-failure behavior is covered by
// recordLetterCompletionAuthorization.test.js.
const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const { recordLetterCompletion } = require('../src/controllers/handwritingController');

function makeReq(overrides = {}) {
  return {
    user: { id: 7 },
    body: {
      student_id: 13, letter: 'c', case_type: 'lowercase',
      attempt_scores: [90], wrote_correctly: true,
      attempts: [{ attempt_number: 1, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] }],
      ...overrides,
    },
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeProgressRecord(overrides = {}) {
  return { id: 1, increment: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined), ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 7 });
  mockComputeMotorScore.mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' });
  // jest.clearAllMocks() does NOT clear a mock's queued
  // .mockResolvedValueOnce() entries, only its call history — reset here so
  // a once-value queued by one test can never leak into the next test.
  mockResolveProgressionThreshold.mockReset();
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]); // fewer than 5 -> auto-raise does not trigger by default
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(55);
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue({ status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null });
});

function feature2Result(overrides = {}) {
  return { status: 'resolved', threshold: 88, source: 'feature2_family', family: 'curved', historyId: 2, ...overrides };
}

// ─── Controller 1/2/3 — mapped letters use the Feature 2 threshold ────────

describe('Controller 1 — mapped curved letter uses Feature 2 threshold', () => {
  it('gates on the resolved family threshold', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88, family: 'curved' }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [90] }), res);

    expect(mockResolveProgressionThreshold).toHaveBeenCalledWith({ studentId: 13, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: undefined });
    const body = res.json.mock.calls[0][0];
    expect(body.threshold).toBe(88);
    expect(body.thresholdSource).toBe('feature2_family');
    expect(body.thresholdFamily).toBe('curved');
  });
});

describe('Controller 2 — mapped straight letter uses the corresponding target', () => {
  it('resolves to straight', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 67, family: 'straight' }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'i', attempt_scores: [70] }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.threshold).toBe(67);
    expect(body.thresholdFamily).toBe('straight');
  });
});

describe('Controller 3 — mapped complex letter uses the corresponding target', () => {
  it('resolves to complex', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 73, family: 'complex' }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'v', attempt_scores: [80] }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.threshold).toBe(73);
    expect(body.thresholdFamily).toBe('complex');
  });
});

// ─── Controller 4/5 — legacy fallback paths ────────────────────────────────

describe('Controller 4 — ambiguous letter uses legacy fallback', () => {
  it('thresholdFamily is null, source is a legacy tier', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 55, source: 'global_default', family: null, historyId: null });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'a', attempt_scores: [60] }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.threshold).toBe(55);
    expect(body.thresholdSource).toBe('global_default');
    expect(body.thresholdFamily).toBeNull();
  });
});

describe('Controller 5 — a student with no Feature 2 initialization behaves exactly as before', () => {
  it('produces the same completed/threshold shape as the pre-Step-7 legacy path', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 55, source: 'global_default', family: 'curved', historyId: null });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [60] }), res); // 60 >= 55 -> success

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.id).toBe(1);
    expect(body).not.toHaveProperty('completed'); // success shape never had this field
  });
});

// ─── Controller 6 — explicit quality_threshold still wins ─────────────────

describe('Controller 6 — explicit quality_threshold is passed through and wins', () => {
  it('forwards requestedQualityThreshold to the resolver', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 75, source: 'request_override', family: null, historyId: null });
    await recordLetterCompletion(makeReq({ quality_threshold: 75, attempt_scores: [80] }), makeRes());

    expect(mockResolveProgressionThreshold).toHaveBeenCalledWith(expect.objectContaining({ requestedQualityThreshold: 75 }));
  });
});

// ─── Controller 7/8 — gate math unchanged ──────────────────────────────────

describe('Controller 7 — Feature 2 target causes a correct fail when bestScore is below it', () => {
  it('completed:false, bestScore/threshold reported', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    // Motor Score Unification — bestScore is now the backend-computed
    // authoritative score, not attempt_scores (diagnostic-only below).
    mockComputeMotorScore.mockReturnValue({ motor_score: 70, quality_score: 70, score_version: 'v1' });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [70] }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.completed).toBe(false);
    expect(body.bestScore).toBe(70);
    expect(body.threshold).toBe(88);
    expect(body.message).toBe('Quality threshold not met');
  });
});

describe('Controller 8 — Feature 2 target allows a correct pass when bestScore meets it', () => {
  it('enters the existing success branch (201/200 + record id)', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockComputeMotorScore.mockReturnValue({ motor_score: 88, quality_score: 88, score_version: 'v1' });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [88] }), res); // exactly meets -> >= passes

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 1, letter: 'c', case_type: 'lowercase' }));
  });
});

// ─── Controller 9 — LetterAttempt persistence unchanged ───────────────────

describe('Controller 9 — LetterAttempt persistence still receives the resolved threshold', () => {
  it('bulkCreate rows carry the Feature 2-resolved threshold value', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockComputeMotorScore.mockReturnValue({ motor_score: 90, quality_score: 90, score_version: 'v1' });
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [90] }), makeRes());

    expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
    const insertedRows = mockLetterAttemptBulkCreate.mock.calls[0][0];
    expect(insertedRows[0].threshold).toBe(88);
    expect(insertedRows[0].best_score).toBe(90);
  });
});

// ─── Controller 10 — blocked_attempts unchanged ────────────────────────────

describe('Controller 10 — blocked_attempts still increments on failure', () => {
  it('calls increment exactly as before', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const rec = makeProgressRecord();
    mockLetterProgressFindOrCreate.mockResolvedValueOnce([rec, true]);
    mockLetterProgressFindOne.mockResolvedValueOnce({ id: 1, blocked_attempts: 1 });

    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [70] }), makeRes());

    expect(rec.increment).toHaveBeenCalledWith('blocked_attempts', { by: 1 });
  });
});

// ─── Controller 11 — legacy auto-lower unchanged ───────────────────────────

describe('Controller 11 — legacy auto-lower still writes personal_thresholds, even for a Feature-2-gated letter', () => {
  it('lowers by 5 (floor 20) when blocked_attempts > 3 — documents that this write becomes non-gating for that mapped letter, but still happens', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockLetterProgressFindOrCreate.mockResolvedValueOnce([makeProgressRecord(), true]);
    mockLetterProgressFindOne.mockResolvedValueOnce({ id: 1, blocked_attempts: 4 }); // > 3
    const studentUpdate = jest.fn().mockResolvedValue(undefined);
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: { c: 65 }, update: studentUpdate });

    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [70] }), makeRes());

    expect(studentUpdate).toHaveBeenCalledWith({ personal_thresholds: { c: 60 } }); // 65 - 5
  });
});

// ─── Controller 12 — legacy auto-raise unchanged ───────────────────────────

describe('Controller 12 — legacy auto-raise still fires on 5 clean consecutive passes', () => {
  it('raises personal_thresholds.default by 5 (cap 85)', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockLetterProgressFindOrCreate.mockResolvedValueOnce([makeProgressRecord(), true]);
    mockLetterProgressFindAll.mockResolvedValueOnce([
      { blocked_attempts: 0 }, { blocked_attempts: 0 }, { blocked_attempts: 0 }, { blocked_attempts: 0 }, { blocked_attempts: 0 },
    ]);
    const studentUpdate = jest.fn().mockResolvedValue(undefined);
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: { default: 55 }, update: studentUpdate });
    mockComputeMotorScore.mockReturnValue({ motor_score: 90, quality_score: 90, score_version: 'v1' });

    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [90] }), makeRes());

    expect(studentUpdate).toHaveBeenCalledWith({ personal_thresholds: { default: 60 } });
  });
});

// ─── Controller 13 — collection mode bypass unchanged ──────────────────────

describe('Controller 13 — collection mode never touches the new resolver', () => {
  it('resolveProgressionThreshold is never called; the old getStudentThreshold path is used exactly as before', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ collection_mode: true, attempt_scores: [90] }), res);

    expect(mockResolveProgressionThreshold).not.toHaveBeenCalled();
    expect(mockGetStudentThreshold).toHaveBeenCalledWith(13, 'c');
    expect(res.json).toHaveBeenCalledWith({ completed: true, collection_mode: true });
  });
});

// ─── Controller 14 — additive response metadata ────────────────────────────

describe('Controller 14 — threshold source metadata is additive only', () => {
  it('failure response keeps every existing field and adds the two new ones', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88, family: 'curved' }));
    mockComputeMotorScore.mockReturnValue({ motor_score: 70, quality_score: 70, score_version: 'v1' });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [70] }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({
      completed: false, bestScore: 70, threshold: 88, message: 'Quality threshold not met',
      thresholdSource: 'feature2_family', thresholdFamily: 'curved',
    });
  });

  it('success response keeps every existing field and adds the two new ones', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88, family: 'curved' }));
    mockComputeMotorScore.mockReturnValue({ motor_score: 90, quality_score: 90, score_version: 'v1' });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'c', attempt_scores: [90] }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({
      id: 1, letter: 'c', case_type: 'lowercase',
      threshold: 88, thresholdSource: 'feature2_family', thresholdFamily: 'curved',
    });
  });
});

// ─── Controller 15 — no DIRECT automatic threshold persistence (Step 7 scope) ─
//
// UPDATED for Step 8: recordLetterCompletion now DOES trigger automatic
// evaluation — but only ever indirectly, through the single orchestration
// entry point processDynamicThresholdAfterLetterSession() (mocked in this
// file; see tests/dynamicThresholdOrchestration.test.js and
// tests/recordLetterCompletionOrchestration.test.js for that function's own
// exhaustive coverage). This test's real, still-true claim: the controller
// never calls the lower-level Step 5/6B functions directly/redundantly —
// there is exactly one trigger path, not several.

describe('Controller 15 — recordLetterCompletion never calls Step 5/6B functions directly (only via the single Step 8 orchestration entry point)', () => {
  it('the controller source never references the lower-level functions by name — only processDynamicThresholdAfterLetterSession', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    expect(source).not.toMatch(/persistAutomaticThresholdDecisions|evaluateDynamicThresholds|classifyAutomaticThresholdPersistence|setTeacherFamilyThreshold/);
    expect(source).toMatch(/processDynamicThresholdAfterLetterSession/);
  });
});

// ─── Section 33 — regression fixture for non-Feature-2 students ───────────

describe('Section 33 — byte-identical behavior for a student with no family target', () => {
  it('a legacy-sourced resolution produces the exact same completed:false shape the pre-Step-7 code would have', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 57, source: 'legacy_default', family: null, historyId: null });
    mockComputeMotorScore.mockReturnValue({ motor_score: 50, quality_score: 50, score_version: 'v1' });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'z', attempt_scores: [50] }), res); // 50 < 57

    expect(res.json).toHaveBeenCalledWith({
      completed: false, bestScore: 50, threshold: 57,
      thresholdSource: 'legacy_default', thresholdFamily: null,
      dynamicThresholdStatus: 'not_applicable', dynamicThresholdNextThreshold: null,
      message: 'Quality threshold not met',
    });
  });
});

'use strict';

// Feature 11B Phase 5 — recordLetterCompletion()'s integration with
// runLetterMotorMasteryEvidence()/letterMotorMasteryService.onLetterMastered().
// Mocks letterMotorMasteryService directly (its own logic is exhaustively
// covered by tests/letterMotorMasteryService.test.js) so these tests focus
// purely on the CONTROLLER's integration: trigger placement/gating
// (any saved passing session), non-fatal error handling, collection-mode
// exclusion, and response-shape isolation (spec §19/§20/§21) — mirrors
// tests/recordLetterCompletionOrchestration.test.js's exact convention.

const mockResolveProgressionThreshold = jest.fn();
const mockProcessDynamicThresholdAfterLetterSession = jest.fn();
const mockGetStudentThreshold = jest.fn();
const mockOnLetterMastered = jest.fn();

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

jest.mock('../src/services/letterMotorMasteryService', () => ({
  onLetterMastered: (...a) => mockOnLetterMastered(...a),
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
// score source for recordLetterCompletion's own pass/fail decision (not
// just for persistence), so this mock is a controllable jest.fn() (default
// 80, matching every previous test's assumed "passing" score) rather than
// a fixed inline return value, so the one test that needs a genuinely
// LOW authoritative score can override it.
const mockComputeMotorScore = jest.fn();
jest.mock('../src/utils/motorScore', () => ({
  computeMotorScore: (...a) => mockComputeMotorScore(...a),
}));

jest.mock('../src/services/explainabilityService', () => ({ analyzeMotorDifficulty: jest.fn() }));
jest.mock('../src/services/motorBaselineService', () => ({ createInitialMotorBaseline: jest.fn(), getStudentMotorBaseline: jest.fn() }));
jest.mock('../src/services/motorClusterService', () => ({ predictInitialMotorCluster: jest.fn() }));
// Pre-device P0 fix (Blocker 2) — recordLetterCompletion now verifies
// ownership before any write. mockGetOwnStudentById resolves successfully
// by default (the "owned student" happy path every test here exercises);
// authorization-failure behavior itself is covered by the dedicated
// recordLetterCompletionAuthorization.test.js.
const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));
jest.mock('../src/services/letterCategoryCompletionService', () => ({}));

const { recordLetterCompletion } = require('../src/controllers/handwritingController');

function makeReq(overrides = {}) {
  return {
    user: { id: 7 },
    body: {
      student_id: 13, letter: 'l', case_type: 'lowercase',
      attempt_scores: [90], wrote_correctly: true,
      attempts: [
        // Fixture note: `strokes` must be NON-EMPTY. Capture completeness is checked
        // before coverage (src/utils/captureStatus.js), and an attempt with no strokes
        // is a CAPTURE FAULT that never reaches evaluation — so an empty array here
        // would silently stop these suites from testing what they are about. The
        // geometry itself is irrelevant; computeMotorScore is mocked.
        { attempt_number: 1, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [{ stroke_id: 1, points: [{ x: 10, y: 10 }, { x: 200, y: 10 }] }] },
        { attempt_number: 2, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [{ stroke_id: 1, points: [{ x: 10, y: 10 }, { x: 200, y: 10 }] }] },
        { attempt_number: 3, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [{ stroke_id: 1, points: [{ x: 10, y: 10 }, { x: 200, y: 10 }] }] },
      ],
      ...overrides,
    },
  };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
function makeProgressRecord(overrides = {}) {
  return { id: 1, increment: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined), ...overrides };
}
function feature2Result(overrides = {}) {
  return { status: 'resolved', threshold: 55, source: 'global_default', family: null, historyId: null, ...overrides };
}
function orchestrationResult(overrides = {}) {
  return { status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 7 });
  mockComputeMotorScore.mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' });
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]); // created === true by default
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]);
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(55);
  mockResolveProgressionThreshold.mockResolvedValue(feature2Result());
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue(orchestrationResult());
  mockOnLetterMastered.mockResolvedValue({ status: 'evidence_created', evidence: { id: 1 }, milestoneResults: [] });
});

describe('First mastery (created === true) triggers the evidence-freeze hook', () => {
  it('onLetterMastered is called with studentId/letter/caseType/sessionKey after the save', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);

    expect(mockOnLetterMastered).toHaveBeenCalledTimes(1);
    const callArgs = mockOnLetterMastered.mock.calls[0][0];
    expect(callArgs.studentId).toBe(13);
    expect(callArgs.letter).toBe('l');
    expect(callArgs.caseType).toBe('lowercase');
    expect(typeof callArgs.sessionKey).toBe('string');

    expect(mockLetterAttemptBulkCreate.mock.invocationCallOrder[0])
      .toBeLessThan(mockOnLetterMastered.mock.invocationCallOrder[0]);
  });

  it('Feature 11B still leaks no field of its own into the response', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    // The three mastery_* fields are the attempt-3-only policy's own
    // ADDITIVE metadata (see config/masteryPolicy.js), not Feature 11B's.
    // Every pre-existing field is still present and unchanged — that is what
    // this assertion protects.
    expect(Object.keys(body).sort()).toEqual(
      [
        'dynamicThresholdNextThreshold', 'dynamicThresholdStatus', 'id', 'letter',
        'case_type', 'threshold', 'thresholdFamily', 'thresholdSource',
        'mastery_score', 'mastery_attempt_number', 'mastery_policy_version',
        // P1 capture fix — additive: whether the cycle was actually judged,
        // and whether it spends one of the day's three.
        'evaluation_status', 'cycle_consumed',
      ].sort()
    );
    // Nothing named after the evidence hook ever appears.
    expect(Object.keys(body).some(k => /evidence|milestone/i.test(k))).toBe(false);
  });
});

// The hook used to be gated on `created === true`, which looked like "first
// mastery" but was not: the blocked branch ALSO calls
// LetterProgress.findOrCreate() for its blocked_attempts counter, so any
// child who failed a letter even once already had a row by the time they
// passed — and the freeze silently never ran for that letter. Immutability
// is enforced inside onLetterMastered() (which returns
// 'evidence_already_exists' without writing) and by the evidence table's
// unique key, NOT by this call site.
describe('A passing session triggers the hook even when the LetterProgress row already existed', () => {
  it('calls onLetterMastered when created === false — the post-blocked-attempt mastery path', async () => {
    mockLetterProgressFindOrCreate.mockResolvedValueOnce([makeProgressRecord(), false]); // created === false
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);
    expect(mockOnLetterMastered).toHaveBeenCalledTimes(1);
    expect(mockOnLetterMastered).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 13, letter: 'l', caseType: 'lowercase' })
    );
  });

  it('still returns 200 (not 201) for an already-existing row — response shape is unchanged', async () => {
    mockLetterProgressFindOrCreate.mockResolvedValueOnce([makeProgressRecord(), false]);
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('Failed session (blocked branch) never triggers the hook', () => {
  it('a below-threshold session does not call onLetterMastered (the branch returns before the hook)', async () => {
    // Motor Score Unification — attempt_scores is no longer authoritative;
    // the below-threshold outcome must come from the backend-computed
    // motor score instead (20 < the 55 threshold).
    mockComputeMotorScore.mockReturnValue({ motor_score: 20, quality_score: 20, score_version: 'v1' });
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [20] }), res); // diagnostic-only, does not itself drive the outcome
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
    expect(mockLetterProgressFindOrCreate).toHaveBeenCalledTimes(1); // only the blocked_attempts bookkeeping row
  });
});

describe('Collection mode never triggers the hook', () => {
  it('the hook is never called in collection mode (structurally unreachable — early return)', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ collection_mode: true, attempt_scores: [90] }), res);
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ completed: true, collection_mode: true });
  });
});

describe('attemptsSaved gating', () => {
  it('the hook does not run if the LetterAttempt save itself failed', async () => {
    mockLetterAttemptBulkCreate.mockRejectedValueOnce(new Error('connection terminated'));
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
  });
});

describe('Non-fatal error handling', () => {
  it('a throw from onLetterMastered does not turn a successful completion into a server error', async () => {
    mockOnLetterMastered.mockRejectedValueOnce(new Error('unexpected mastery-service bug'));
    const res = makeRes();

    await expect(recordLetterCompletion(makeReq(), res)).resolves.toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.id).toBe(1);
    expect(JSON.stringify(body)).not.toContain('unexpected mastery-service bug');
  });

  it('a rejected (non-throwing) service result also never affects the response', async () => {
    mockOnLetterMastered.mockResolvedValueOnce({ status: 'save_failed', evidence: null, milestoneResults: null });
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

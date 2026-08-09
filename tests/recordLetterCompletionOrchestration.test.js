'use strict';

// Feature 2 Step 8 — recordLetterCompletion()'s integration with
// processDynamicThresholdAfterLetterSession(). Mocks
// dynamicThresholdService directly (its own decision/persistence logic is
// exhaustively covered by tests/dynamicThresholdService.test.js's Section
// 34/36-42 suites) so these tests focus purely on the CONTROLLER's
// integration: trigger placement/ordering, non-fatal error handling,
// collection-mode exclusion, and additive-only response metadata.
const mockResolveProgressionThreshold = jest.fn();
const mockProcessDynamicThresholdAfterLetterSession = jest.fn();
const mockGetStudentThreshold = jest.fn();

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

jest.mock('../src/utils/motorScore', () => ({
  computeMotorScore: jest.fn().mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' }),
}));

jest.mock('../src/services/explainabilityService', () => ({ analyzeMotorDifficulty: jest.fn() }));
jest.mock('../src/services/motorBaselineService', () => ({ createInitialMotorBaseline: jest.fn(), getStudentMotorBaseline: jest.fn() }));
jest.mock('../src/services/teacherService', () => ({}));

const { recordLetterCompletion } = require('../src/controllers/handwritingController');

function makeReq(overrides = {}) {
  return {
    body: {
      student_id: 13, letter: 'c', case_type: 'lowercase',
      attempt_scores: [90], wrote_correctly: true,
      attempts: [
        { attempt_number: 1, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
        { attempt_number: 2, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
        { attempt_number: 3, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
      ],
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

function feature2Result(overrides = {}) {
  return { status: 'resolved', threshold: 88, source: 'feature2_family', family: 'curved', historyId: 2, ...overrides };
}

function orchestrationResult(overrides = {}) {
  return { status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]);
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(55);
  mockResolveProgressionThreshold.mockResolvedValue(feature2Result());
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue(orchestrationResult());
});

// ─── Section 35 — Failure branch ───────────────────────────────────────────

describe('Section 35 — Failure branch', () => {
  it('Test 1/2/3: session fails current threshold, attempt rows are saved, orchestration runs AFTER the save', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [70] }), res); // 70 < 88

    expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledTimes(1);
    // Call-order proof: the save happens strictly before orchestration.
    expect(mockLetterAttemptBulkCreate.mock.invocationCallOrder[0])
      .toBeLessThan(mockProcessDynamicThresholdAfterLetterSession.mock.invocationCallOrder[0]);
  });

  it('Test 4: original completed:false response is preserved', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'insufficient_data', family: 'curved' }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [70] }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.completed).toBe(false);
    expect(body.bestScore).toBe(70);
    expect(body.threshold).toBe(88);
    expect(body.message).toBe('Quality threshold not met');
  });

  it('Test 5: the automatic adaptation result is additive only — every existing field still present', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'automatic_created', family: 'curved', newThreshold: 93 }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [70] }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({
      completed: false, bestScore: 70, threshold: 88,
      thresholdSource: 'feature2_family', thresholdFamily: 'curved',
      message: 'Quality threshold not met',
      dynamicThresholdStatus: 'automatic_created', dynamicThresholdNextThreshold: 93,
    });
  });

  it('orchestration does NOT run if the save itself failed', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockLetterAttemptBulkCreate.mockRejectedValueOnce(new Error('connection terminated'));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [70] }), res);

    expect(mockProcessDynamicThresholdAfterLetterSession).not.toHaveBeenCalled();
    // The original failure response is still returned — a DB save error
    // does not turn into a 500.
    const body = res.json.mock.calls[0][0];
    expect(body.completed).toBe(false);
    expect(body.dynamicThresholdStatus).toBeNull();
  });
});

// ─── Section 35 — Success branch ───────────────────────────────────────────

describe('Section 35 — Success branch', () => {
  it('Test 6/7/8: session passes current threshold, attempts saved, orchestration runs AFTER the save', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [90] }), res); // 90 >= 88

    expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledTimes(1);
    expect(mockLetterAttemptBulkCreate.mock.invocationCallOrder[0])
      .toBeLessThan(mockProcessDynamicThresholdAfterLetterSession.mock.invocationCallOrder[0]);
  });

  it('Test 9: original success response shape is preserved', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [90] }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 1, letter: 'c', case_type: 'lowercase' }));
  });

  it('Test 10: the automatic adaptation result is additive only in the success response too', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'hold', family: 'curved' }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [90] }), res);

    expect(res.json.mock.calls[0][0]).toMatchObject({
      id: 1, letter: 'c', case_type: 'lowercase',
      threshold: 88, thresholdSource: 'feature2_family', thresholdFamily: 'curved',
      dynamicThresholdStatus: 'hold', dynamicThresholdNextThreshold: null,
    });
  });

  it('orchestration does NOT run if the save itself failed', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockLetterAttemptBulkCreate.mockRejectedValueOnce(new Error('connection terminated'));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [90] }), res);

    expect(mockProcessDynamicThresholdAfterLetterSession).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].dynamicThresholdStatus).toBeNull();
  });
});

// ─── Section 36 — ordering / future-session-only guarantee (controller level) ─

describe('Section 36 — the just-completed session\'s own threshold is never retroactively changed', () => {
  it('response.threshold reflects the ORIGINAL 88 even though orchestration (afterward) creates 93', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'automatic_created', family: 'curved', newThreshold: 93 }));
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attempt_scores: [89] }), res); // 89 >= 88 -> passes against the OLD threshold

    const body = res.json.mock.calls[0][0];
    expect(body.threshold).toBe(88); // NOT retroactively 93
    expect(body.dynamicThresholdNextThreshold).toBe(93); // reported separately, additively
  });
});

// ─── Non-fatal error handling ───────────────────────────────────────────────

describe('Non-fatal error handling', () => {
  it('an orchestration throw does not turn a successful completion into a server error', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockProcessDynamicThresholdAfterLetterSession.mockRejectedValueOnce(new Error('unexpected orchestration bug'));
    const res = makeRes();

    await expect(recordLetterCompletion(makeReq({ attempt_scores: [90] }), res)).resolves.toBeUndefined();

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.id).toBe(1);
    expect(body.dynamicThresholdStatus).toBe('error');
    // The raw error message must never reach the response.
    expect(JSON.stringify(body)).not.toContain('unexpected orchestration bug');
  });

  it('an orchestration throw does not turn a failed completion into a server error', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    mockProcessDynamicThresholdAfterLetterSession.mockRejectedValueOnce(new Error('unexpected orchestration bug'));
    const res = makeRes();

    await expect(recordLetterCompletion(makeReq({ attempt_scores: [70] }), res)).resolves.toBeUndefined();

    const body = res.json.mock.calls[0][0];
    expect(body.completed).toBe(false);
    expect(body.dynamicThresholdStatus).toBe('error');
  });
});

// ─── Collection mode exclusion (Section 3/43 — double protection) ─────────

describe('Collection mode never triggers orchestration', () => {
  it('processDynamicThresholdAfterLetterSession is never called in collection mode', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ collection_mode: true, attempt_scores: [90] }), res);

    expect(mockProcessDynamicThresholdAfterLetterSession).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ completed: true, collection_mode: true });
  });
});

// ─── Section 42 — explicit request override skip, verified at the controller level ─

describe('Section 42 — explicit quality_threshold is forwarded so orchestration can skip contaminated evidence', () => {
  it('requestedQualityThreshold is passed through to processDynamicThresholdAfterLetterSession', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 75, source: 'request_override', family: null, historyId: null });
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'skipped_request_override' }));

    const res = makeRes();
    await recordLetterCompletion(makeReq({ quality_threshold: 75, attempt_scores: [80] }), res);

    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledWith(
      expect.objectContaining({ requestedQualityThreshold: 75 })
    );
    expect(res.json.mock.calls[0][0].dynamicThresholdStatus).toBe('skipped_request_override');
  });
});

// ─── Section 32/33 — session-level trigger deduplication + hasAttempt3Evidence ─

describe('Section 32/5 — orchestration is triggered exactly once per request, gated on attempt-3 evidence', () => {
  it('is called exactly once even with a duplicate-shaped attempts array (live-pattern regression: 1,2,3,3,3,3)', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const req = makeReq({
      attempts: [
        { attempt_number: 1, features: {}, strokes: [] },
        { attempt_number: 2, features: {}, strokes: [] },
        { attempt_number: 3, features: {}, strokes: [] },
        { attempt_number: 3, features: {}, strokes: [] },
        { attempt_number: 3, features: {}, strokes: [] },
      ],
      attempt_scores: [90],
    });
    await recordLetterCompletion(req, makeRes());

    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledTimes(1);
    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttempt3Evidence: true })
    );
  });

  it('hasAttempt3Evidence is false when attempts only reach attempt 2 (e.g. a malformed/partial request)', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const req = makeReq({
      attempts: [
        { attempt_number: 1, features: {}, strokes: [] },
        { attempt_number: 2, features: {}, strokes: [] },
      ],
      attempt_scores: [90],
    });
    await recordLetterCompletion(req, makeRes());

    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttempt3Evidence: false })
    );
  });

  it('hasAttempt3Evidence is false when attempts is absent entirely', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce(feature2Result({ threshold: 88 }));
    const req = makeReq({ attempts: undefined, attempt_scores: [90] });
    await recordLetterCompletion(req, makeRes());

    expect(mockProcessDynamicThresholdAfterLetterSession).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttempt3Evidence: false })
    );
  });
});

// ─── Section 45 — regression: student with no Feature 2 initialization ────

describe('Section 45 — regression: a student with no baseline/Feature 2 target behaves exactly as before', () => {
  it('legacy gate, existing LetterProgress/LetterAttempt persistence, no automatic Feature 2 write', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 55, source: 'global_default', family: null, historyId: null });
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'not_applicable', family: null }));

    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'q', attempt_scores: [60] }), res); // 60 >= 55 -> success

    expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      threshold: 55, thresholdSource: 'global_default', thresholdFamily: null,
      dynamicThresholdStatus: 'not_applicable',
    });
  });
});

// ─── Section 46 — regression: ambiguous letter for a Feature-2-initialized student ─

describe('Section 46 — regression: an ambiguous letter never triggers family adaptation, even for an initialized student', () => {
  it('legacy threshold gate, dynamicThresholdStatus not_applicable, family null', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({ status: 'resolved', threshold: 55, source: 'global_default', family: null, historyId: null });
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValueOnce(orchestrationResult({ status: 'not_applicable', family: null }));

    const res = makeRes();
    await recordLetterCompletion(makeReq({ letter: 'a', attempt_scores: [40] }), res); // 40 < 55 -> fail

    const body = res.json.mock.calls[0][0];
    expect(body.thresholdFamily).toBeNull();
    expect(body.dynamicThresholdStatus).toBe('not_applicable');
  });
});

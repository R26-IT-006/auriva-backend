'use strict';

// Verifies finalizeAssessment()'s integration with motorBaselineService,
// without hitting the real database or the real explainability engine.
// Mock names must start with "mock" for Jest's module-factory hoisting.
const mockFindByPk             = jest.fn(); // HandwritingAssessment.findByPk
const mockExplanationFindAll   = jest.fn(); // ExplanationResult.findAll — idempotency anchor (Reliability Step 1)
const mockExplanationCreate    = jest.fn(); // ExplanationResult.create
const mockRecommendationCreate = jest.fn(); // RecommendationHistory.create
const mockAnalyzeMotorDifficulty     = jest.fn(); // explainabilityService.analyzeMotorDifficulty
const mockCreateInitialMotorBaseline = jest.fn(); // motorBaselineService.createInitialMotorBaseline

jest.mock('../src/models', () => ({
  HandwritingAssessment: { findByPk: mockFindByPk },
  ExplanationResult:     { findAll: mockExplanationFindAll, create: mockExplanationCreate },
  RecommendationHistory: { create: mockRecommendationCreate },
}));

jest.mock('../src/services/explainabilityService', () => ({
  analyzeMotorDifficulty: mockAnalyzeMotorDifficulty,
}));

jest.mock('../src/services/motorBaselineService', () => ({
  createInitialMotorBaseline: mockCreateInitialMotorBaseline,
}));

const { finalizeAssessment } = require('../src/controllers/handwritingController');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeAssessmentInstance(overrides = {}) {
  const instance = {
    id:         101,
    student_id: 10,
    is_initial: true,
    shapes:     [],
    ...overrides,
  };
  // Real Sequelize .update() mutates the instance and resolves it — mirrored
  // here so assessment.student_id/assessment.id reads after update() still
  // reflect the persisted row, exactly like the real controller relies on.
  instance.update = jest.fn(async (fields) => {
    Object.assign(instance, fields);
    return instance;
  });
  return instance;
}

function makeReq(overrides = {}) {
  return {
    params: { id: '101' },
    body: {
      motor_score:   61,
      motor_profile: { straightScore: 72, curvedScore: 46, complexScore: 58 },
      ...overrides,
    },
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

const DEFAULT_DIFFICULTY_RESULT = {
  difficultyKey:        'NONE',
  difficulty:            'None',
  confidence:            90,
  featureContributions: [],
  explanation:           [],
  recommendations:       [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAnalyzeMotorDifficulty.mockReturnValue(DEFAULT_DIFFICULTY_RESULT);
  mockExplanationFindAll.mockResolvedValue([]); // no existing row by default — every test here is a first-time finalize
  mockExplanationCreate.mockResolvedValue({ id: 1 });
  mockRecommendationCreate.mockResolvedValue({ id: 1 });
});

// ─── Test 1 — Eligible initial assessment ──────────────────────────────────

describe('Test 1 — eligible initial assessment', () => {
  it('response includes baselineStatus=created / baselineId, all previous fields preserved', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 15 }, reason: null });

    const req = makeReq();
    const res = makeRes();
    await finalizeAssessment(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      id:             101,
      is_initial:     true,
      motor_score:    61,
      difficulty:     'None',
      difficultyKey:  'NONE',
      message:        'Assessment finalized',
      baselineStatus: 'created',
      baselineId:     15,
    }));
  });
});

// ─── Test 2 — Duplicate finalize ───────────────────────────────────────────

describe('Test 2 — duplicate finalize', () => {
  it('returns already_exists with the same baseline id, still a successful response', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'already_exists', baseline: { id: 15 }, reason: null });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      baselineStatus: 'already_exists',
      baselineId:     15,
      message:        'Assessment finalized',
    }));
  });
});

// ─── Test 3 — Later assessment ─────────────────────────────────────────────

describe('Test 3 — later assessment', () => {
  it('baselineId is null, finalize still succeeds', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'not_initial_assessment', baseline: null, reason: null });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      baselineStatus: 'not_initial_assessment',
      baselineId:     null,
      message:        'Assessment finalized',
    }));
  });
});

// ─── Test 4 — Collection assessment ────────────────────────────────────────

describe('Test 4 — collection assessment', () => {
  it('baselineId is null, finalize still succeeds, collection behavior untouched', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'collection_assessment_not_eligible', baseline: null, reason: null });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      baselineStatus: 'collection_assessment_not_eligible',
      baselineId:     null,
      message:        'Assessment finalized',
    }));
  });
});

// ─── Test 5 — Invalid profile ───────────────────────────────────────────────

describe('Test 5 — invalid profile', () => {
  it('baselineId is null, finalize still succeeds, reason forwarded', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'invalid_motor_profile', baseline: null, reason: 'missing_curved_score' });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      baselineStatus: 'invalid_motor_profile',
      baselineId:     null,
      baselineReason: 'missing_curved_score',
      message:        'Assessment finalized',
    }));
  });
});

// ─── Test 6 — Service-level DB failure result ──────────────────────────────

describe('Test 6 — service resolves save_failed', () => {
  it('finalize still succeeds', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'save_failed', baseline: null, reason: null });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      baselineStatus: 'save_failed',
      baselineId:     null,
      message:        'Assessment finalized',
    }));
  });
});

// ─── Test 7 — Service unexpectedly throws ──────────────────────────────────

describe('Test 7 — service throws', () => {
  it('resolves to baselineStatus=save_failed without a failed HTTP response, and never exposes the raw error', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    // A distinctive message (not a substring of our own reason vocabulary,
    // unlike the literal word "unexpected") makes the leak check below
    // meaningful rather than an accidental self-match.
    mockCreateInitialMotorBaseline.mockRejectedValueOnce(new Error('db-connection-string-leaked-secret-xyz'));

    const res = makeRes();
    await expect(finalizeAssessment(makeReq(), res)).resolves.toBeUndefined();

    expect(res.json).toHaveBeenCalledTimes(1);
    const responseBody = res.json.mock.calls[0][0];
    expect(responseBody.baselineStatus).toBe('save_failed');
    expect(responseBody.baselineId).toBeNull();
    expect(responseBody.baselineReason).toBe('unexpected_service_error');
    // The raw thrown error message must never reach the client.
    expect(JSON.stringify(responseBody)).not.toContain('db-connection-string-leaked-secret-xyz');
  });
});

// ─── Test 8 — Service called after assessment update ───────────────────────

describe('Test 8 — call order', () => {
  it('assessment.update() is called before the baseline service', async () => {
    const assessment = makeAssessmentInstance();
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 15 }, reason: null });

    await finalizeAssessment(makeReq(), makeRes());

    expect(assessment.update).toHaveBeenCalled();
    expect(mockCreateInitialMotorBaseline).toHaveBeenCalled();
    expect(assessment.update.mock.invocationCallOrder[0])
      .toBeLessThan(mockCreateInitialMotorBaseline.mock.invocationCallOrder[0]);
  });
});

// ─── Test 9 — Correct identifiers ──────────────────────────────────────────

describe('Test 9 — identifiers passed to the service', () => {
  it('uses assessment.student_id / assessment.id from the persisted row, not request-body values', async () => {
    const assessment = makeAssessmentInstance({ id: 101, student_id: 10 });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 15 }, reason: null });

    // finalize's request body has no student_id field at all in the real
    // route contract — this proves the service call can only ever come from
    // the persisted assessment, never from client-supplied data.
    await finalizeAssessment(makeReq(), makeRes());

    expect(mockCreateInitialMotorBaseline).toHaveBeenCalledWith({
      studentId:    10,
      assessmentId: 101,
    });
  });
});

// ─── Test 10 — Existing explainability behavior preserved ─────────────────

describe('Test 10 — explainability behavior preserved', () => {
  it('ExplanationResult and RecommendationHistory are still created when a difficulty is detected', async () => {
    mockAnalyzeMotorDifficulty.mockReturnValue({
      difficultyKey:        'WEAK_CURVE_CONTROL',
      difficulty:            'Weak Curve Control',
      confidence:            75,
      featureContributions: [],
      explanation:           [],
      recommendations:       [],
    });
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 15 }, reason: null });

    await finalizeAssessment(makeReq(), makeRes());

    expect(mockExplanationCreate).toHaveBeenCalledWith(expect.objectContaining({
      assessment_id:    101,
      student_id:       10,
      difficulty_type:  'WEAK_CURVE_CONTROL',
    }));
    expect(mockRecommendationCreate).toHaveBeenCalledWith(expect.objectContaining({
      student_id:      10,
      difficulty_type: 'WEAK_CURVE_CONTROL',
    }));
  });

  it('explainability still runs even when the baseline service throws', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance());
    mockCreateInitialMotorBaseline.mockRejectedValueOnce(new Error('unexpected'));

    await finalizeAssessment(makeReq(), makeRes());

    expect(mockExplanationCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Regression: existing validation guard is untouched ───────────────────

describe('Existing validation preserved', () => {
  it('still throws ApiError(422) when motor_profile is missing from the request body, before touching the baseline service', async () => {
    const req = { params: { id: '101' }, body: { motor_score: 61 } };
    await expect(finalizeAssessment(req, makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockFindByPk).not.toHaveBeenCalled();
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });

  it('still throws ApiError(404) when the assessment does not exist, before calling the baseline service', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    await expect(finalizeAssessment(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

'use strict';

// Verifies finalizeAssessment()'s idempotency (Reliability Step 1) in
// isolation, without hitting the real database or the real explainability
// engine. Mock names must start with "mock" for Jest's hoisting.
const mockFindByPk             = jest.fn(); // HandwritingAssessment.findByPk
const mockExplanationFindAll   = jest.fn(); // ExplanationResult.findAll — the idempotency anchor
const mockExplanationCreate    = jest.fn(); // ExplanationResult.create
const mockRecommendationCreate = jest.fn(); // RecommendationHistory.create
const mockAnalyzeMotorDifficulty     = jest.fn(); // explainabilityService.analyzeMotorDifficulty
const mockCreateInitialMotorBaseline = jest.fn(); // motorBaselineService.createInitialMotorBaseline
// Feature 2 final workflow integration — createInitialFamilyThresholds is
// now called automatically from finalizeAssessment() right after the
// baseline result, whenever a valid baseline row exists for this student.
const mockCreateInitialFamilyThresholds = jest.fn();
const mockLoggerInfo  = jest.fn();
const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

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

jest.mock('../src/services/dynamicThresholdService', () => ({
  createInitialFamilyThresholds: (...a) => mockCreateInitialFamilyThresholds(...a),
  processDynamicThresholdAfterLetterSession: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: mockLoggerInfo, warn: mockLoggerWarn, error: mockLoggerError, debug: jest.fn(), http: jest.fn(),
}));

const { finalizeAssessment } = require('../src/controllers/handwritingController');

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Mirrors the real persisted motor_profile shape exactly (verified against
// live data — assessment 202's real stored row), including the unrounded
// float shapeScores values, so equality-comparison tests are meaningful.
function makeMotorProfile(overrides = {}) {
  return {
    straightScore: 62,
    curvedScore: 83,
    complexScore: 68,
    primaryStrength: 'curved',
    categoryOrder: ['curved', 'straight', 'mixed'],
    recommendedSequence: 'CURVED → STRAIGHT → MIXED',
    shapeScores: {
      horizontal_line: 96.18294270833334,
      vertical_line:   27.69287109375,
      full_circle:      82.01462596678289,
      half_circle:      84.84839190235775,
      zigzag:            70.95069537915764,
      curve_wave:        65.28743223499002,
    },
    ...overrides,
  };
}

function makeAssessmentInstance(overrides = {}) {
  const instance = {
    id: 101, student_id: 10, is_initial: true, shapes: [],
    motor_score: null, motor_profile: null,
    ...overrides,
  };
  // Mirrors real Sequelize .update() — mutates in place, so a re-fetch of
  // the "same row" later in a test reflects the previous call's write.
  instance.update = jest.fn(async (fields) => { Object.assign(instance, fields); return instance; });
  return instance;
}

function makeReq(overrides = {}) {
  return {
    params: { id: '101' },
    body: { motor_score: 61, motor_profile: makeMotorProfile(), ...overrides },
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

const NONE_RESULT = {
  difficultyKey: 'NONE', difficulty: 'Good Motor Control', confidence: null,
  featureContributions: [], explanation: [], recommendations: [],
};
const WEAK_RESULT = {
  difficultyKey: 'WEAK_CURVE_CONTROL', difficulty: 'Weak Curve Control', confidence: 75,
  featureContributions: [], explanation: [], recommendations: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAnalyzeMotorDifficulty.mockReturnValue(WEAK_RESULT);
  mockExplanationCreate.mockResolvedValue({ id: 1 });
  mockRecommendationCreate.mockResolvedValue({ id: 1 });
  mockCreateInitialMotorBaseline.mockResolvedValue({ status: 'created', baseline: { id: 5 }, reason: null });
  mockCreateInitialFamilyThresholds.mockResolvedValue({
    status: 'created', studentId: 10, baselineId: 5, baselineVersion: 'baseline-v1', mappingVersion: 'letter-baseline-family-v1', margin: 5,
    created: {
      straight: { status: 'created', historyId: 1, newThreshold: 90 },
      curved:   { status: 'created', historyId: 2, newThreshold: 88 },
      complex:  { status: 'created', historyId: 3, newThreshold: 73 },
    },
  });
});

// ─── Test 1 — First finalize ────────────────────────────────────────────────

describe('Test 1 — first finalize', () => {
  it('updates the assessment, creates ExplanationResult + RecommendationHistory, calls baseline, 200', async () => {
    const assessment = makeAssessmentInstance(); // motor_score/motor_profile null
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(assessment.update).toHaveBeenCalledWith({ motor_score: 61, motor_profile: expect.objectContaining({ straightScore: 62 }) });
    expect(mockExplanationCreate).toHaveBeenCalledTimes(1);
    expect(mockRecommendationCreate).toHaveBeenCalledTimes(1); // WEAK_RESULT is non-NONE
    expect(mockCreateInitialMotorBaseline).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ finalizeStatus: 'finalized' }));
  });
});

// ─── Test 2 — Exact resend ──────────────────────────────────────────────────

describe('Test 2 — exact resend', () => {
  it('does not duplicate ExplanationResult/RecommendationHistory, still calls baseline, 200', async () => {
    const profile    = makeMotorProfile();
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: profile });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 9, difficulty_label: 'Weak Curve Control', difficulty_type: 'WEAK_CURVE_CONTROL' }]);

    const res = makeRes();
    // A different object instance with the same values — not the same reference.
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: makeMotorProfile() }), res);

    expect(assessment.update).not.toHaveBeenCalled();
    expect(mockExplanationCreate).not.toHaveBeenCalled();
    expect(mockRecommendationCreate).not.toHaveBeenCalled();
    expect(mockCreateInitialMotorBaseline).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ finalizeStatus: 'already_finalized' }));
  });
});

// ─── Test 3 — Resend with existing explanation ─────────────────────────────

describe('Test 3 — resend with existing explanation', () => {
  it('the response reflects the existing ExplanationResult, not a fresh recompute', async () => {
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: makeMotorProfile() });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 9, difficulty_label: 'Weak Curve Control', difficulty_type: 'WEAK_CURVE_CONTROL' }]);
    // Deliberately different from the persisted row, to prove it is NOT used.
    mockAnalyzeMotorDifficulty.mockReturnValue({
      difficultyKey: 'ZIGZAG_INSTABILITY', difficulty: 'Zigzag Instability', confidence: 50,
      featureContributions: [], explanation: [], recommendations: [],
    });

    const res = makeRes();
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: makeMotorProfile() }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      difficulty: 'Weak Curve Control', difficultyKey: 'WEAK_CURVE_CONTROL',
    }));
    expect(mockAnalyzeMotorDifficulty).not.toHaveBeenCalled();
  });
});

// ─── Test 4 — Resend when explanation missing ──────────────────────────────

describe('Test 4 — resend when explanation missing', () => {
  it('fills the gap with a fresh ExplanationResult but does NOT create RecommendationHistory', async () => {
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: makeMotorProfile() });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]); // none found, even though this is a resend

    const res = makeRes();
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: makeMotorProfile() }), res);

    expect(mockAnalyzeMotorDifficulty).toHaveBeenCalledTimes(1); // "pure difficulty calculation may be used for response"
    expect(mockExplanationCreate).toHaveBeenCalledTimes(1);      // fills the gap — assessment_id proves no duplicate
    expect(mockRecommendationCreate).not.toHaveBeenCalled();     // conservative — cannot prove non-duplication
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ finalizeStatus: 'already_finalized' }));
  });
});

// ─── Test 5 — Conflicting motor_score ──────────────────────────────────────

describe('Test 5 — same assessment, different motor_score', () => {
  it('rejects with 409, no mutation at all', async () => {
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: makeMotorProfile() });
    mockFindByPk.mockResolvedValueOnce(assessment);

    await expect(finalizeAssessment(makeReq({ motor_score: 67 }), makeRes()))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(assessment.update).not.toHaveBeenCalled();
    expect(mockExplanationFindAll).not.toHaveBeenCalled();
    expect(mockExplanationCreate).not.toHaveBeenCalled();
    expect(mockRecommendationCreate).not.toHaveBeenCalled();
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 6 — Conflicting motor_profile ────────────────────────────────────

describe('Test 6 — same assessment, different motor_profile', () => {
  it('rejects with 409 when curvedScore differs', async () => {
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: makeMotorProfile() });
    mockFindByPk.mockResolvedValueOnce(assessment);

    const differentProfile = makeMotorProfile({ curvedScore: 99 });
    await expect(finalizeAssessment(makeReq({ motor_score: 61, motor_profile: differentProfile }), makeRes()))
      .rejects.toMatchObject({ statusCode: 409 });

    expect(assessment.update).not.toHaveBeenCalled();
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 7 — Equivalent cloned object ─────────────────────────────────────

describe('Test 7 — equivalent cloned object', () => {
  it('recognizes a structurally-identical but different object instance as a resend', async () => {
    const stored      = makeMotorProfile();
    const assessment  = makeAssessmentInstance({ motor_score: 61, motor_profile: stored });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 9, difficulty_label: 'x', difficulty_type: 'WEAK_CURVE_CONTROL' }]);

    const cloned = JSON.parse(JSON.stringify(stored));
    expect(cloned).not.toBe(stored); // genuinely different object instance

    const res = makeRes();
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: cloned }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ finalizeStatus: 'already_finalized' }));
    expect(assessment.update).not.toHaveBeenCalled();
  });
});

// ─── Test 8 — Key ordering differences ─────────────────────────────────────

describe('Test 8 — key ordering differences', () => {
  it('does not depend on object key order', async () => {
    const stored     = makeMotorProfile();
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: stored });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 9, difficulty_label: 'x', difficulty_type: 'WEAK_CURVE_CONTROL' }]);

    // Same values, reversed key insertion order (including inside shapeScores).
    const reordered = {
      shapeScores: {
        curve_wave: stored.shapeScores.curve_wave, zigzag: stored.shapeScores.zigzag,
        half_circle: stored.shapeScores.half_circle, full_circle: stored.shapeScores.full_circle,
        vertical_line: stored.shapeScores.vertical_line, horizontal_line: stored.shapeScores.horizontal_line,
      },
      recommendedSequence: stored.recommendedSequence,
      categoryOrder:       [...stored.categoryOrder],
      primaryStrength:     stored.primaryStrength,
      complexScore:        stored.complexScore,
      curvedScore:         stored.curvedScore,
      straightScore:       stored.straightScore,
    };

    const res = makeRes();
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: reordered }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ finalizeStatus: 'already_finalized' }));
  });
});

// ─── Test 9 — Recommendation difficulty NONE ───────────────────────────────

describe('Test 9 — difficulty NONE', () => {
  it('first-time and resend both leave RecommendationHistory at 0', async () => {
    mockAnalyzeMotorDifficulty.mockReturnValue(NONE_RESULT);

    const assessment = makeAssessmentInstance(); // null/null
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);
    mockExplanationCreate.mockResolvedValueOnce({ id: 20 });

    await finalizeAssessment(makeReq(), makeRes());
    expect(mockExplanationCreate).toHaveBeenCalledTimes(1);
    expect(mockRecommendationCreate).not.toHaveBeenCalled();

    // resend — same underlying row, now finalized by the call above
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 20, difficulty_label: 'Good Motor Control', difficulty_type: 'NONE' }]);

    await finalizeAssessment(makeReq(), makeRes());
    expect(mockExplanationCreate).toHaveBeenCalledTimes(1); // still 1
    expect(mockRecommendationCreate).not.toHaveBeenCalled();
  });
});

// ─── Test 10 — Baseline retry after resend ─────────────────────────────────

describe('Test 10 — baseline retry after resend', () => {
  it('retries baseline creation on resend without duplicating explanation/recommendation', async () => {
    const assessment = makeAssessmentInstance(); // first call: null/null
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);
    mockExplanationCreate.mockResolvedValueOnce({ id: 30 });
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'save_failed', baseline: null, reason: null });

    const res1 = makeRes();
    await finalizeAssessment(makeReq(), res1);
    expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ baselineStatus: 'save_failed', finalizeStatus: 'finalized' }));

    // resend — assessment now carries the persisted motor_score/motor_profile from the first call
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 30, difficulty_label: 'Weak Curve Control', difficulty_type: 'WEAK_CURVE_CONTROL' }]);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 5 }, reason: null });

    const res2 = makeRes();
    await finalizeAssessment(makeReq(), res2);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ baselineStatus: 'created', baselineId: 5, finalizeStatus: 'already_finalized' }));

    expect(mockExplanationCreate).toHaveBeenCalledTimes(1);    // never duplicated
    expect(mockRecommendationCreate).toHaveBeenCalledTimes(1); // only on the genuine first-time call
    expect(mockCreateInitialMotorBaseline).toHaveBeenCalledTimes(2); // retried, as designed
  });
});

// ─── Test 11 — Response-loss simulation ────────────────────────────────────

describe('Test 11 — response-loss simulation', () => {
  it('two identical requests leave exactly one logical write for explanation/recommendation, baseline stays idempotent', async () => {
    const assessment = makeAssessmentInstance();
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);
    mockExplanationCreate.mockResolvedValueOnce({ id: 40 });

    // "First controller call succeeds server-side, client never receives the response."
    await finalizeAssessment(makeReq(), makeRes());

    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 40, difficulty_label: 'Weak Curve Control', difficulty_type: 'WEAK_CURVE_CONTROL' }]);
    // Baseline's own idempotency contract (unchanged this step) — already_exists on retry.
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'already_exists', baseline: { id: 5 }, reason: null });

    // "The same request arrives again."
    const res2 = makeRes();
    await finalizeAssessment(makeReq(), res2);

    expect(mockExplanationCreate).toHaveBeenCalledTimes(1);
    expect(mockRecommendationCreate).toHaveBeenCalledTimes(1);
    expect(mockCreateInitialMotorBaseline).toHaveBeenCalledTimes(2); // called both times — that's what idempotent means
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ baselineStatus: 'already_exists', baselineId: 5 }));
  });
});

// ─── Test 12 — Existing duplicate explanations ─────────────────────────────

describe('Test 12 — existing duplicate explanations', () => {
  it('reuses the earliest of 2 historical rows, logs a warning, creates no third row, finalize succeeds', async () => {
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: makeMotorProfile() });
    mockFindByPk.mockResolvedValueOnce(assessment);
    // Mirrors the real historical duplicates found on live data (assessment 113 / 202).
    const earliest = { id: 6, difficulty_label: 'Good Motor Control', difficulty_type: 'NONE', created_at: new Date('2026-05-08T13:21:16Z') };
    const later    = { id: 7, difficulty_label: 'Good Motor Control', difficulty_type: 'NONE', created_at: new Date('2026-05-08T13:21:31Z') };
    mockExplanationFindAll.mockResolvedValueOnce([earliest, later]);

    const res = makeRes();
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: makeMotorProfile() }), res);

    expect(mockExplanationCreate).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Multiple ExplanationResult'),
      expect.objectContaining({ assessmentId: 101 }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ difficultyKey: 'NONE' }));
  });
});

// ─── Test 13-17 — Feature 2 automatic family-threshold initialization ──────
// (Final workflow integration — no manual admin script required.)

describe('Test 13 — successful baseline finalize automatically initializes Feature 2', () => {
  it('calls createInitialFamilyThresholds once, with only studentId, and reports its status', async () => {
    const assessment = makeAssessmentInstance();
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 5 }, reason: null });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(mockCreateInitialFamilyThresholds).toHaveBeenCalledTimes(1);
    expect(mockCreateInitialFamilyThresholds).toHaveBeenCalledWith({ studentId: 10 });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ familyThresholdStatus: 'created' }));
  });
});

describe('Test 14 — repeated finalize does not duplicate thresholds', () => {
  it('a resend still calls createInitialFamilyThresholds, which itself resolves to already_initialized (never a duplicate)', async () => {
    const assessment = makeAssessmentInstance({ motor_score: 61, motor_profile: makeMotorProfile() });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([{ id: 9, difficulty_label: 'x', difficulty_type: 'WEAK_CURVE_CONTROL' }]);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'already_exists', baseline: { id: 5 }, reason: null });
    mockCreateInitialFamilyThresholds.mockResolvedValueOnce({
      status: 'already_initialized', studentId: 10, baselineId: 5, baselineVersion: 'baseline-v1', mappingVersion: 'letter-baseline-family-v1', margin: 5,
      created: { straight: { status: 'already_initialized', historyId: 1, newThreshold: 90 } },
    });

    const res = makeRes();
    await finalizeAssessment(makeReq({ motor_score: 61, motor_profile: makeMotorProfile() }), res);

    expect(mockCreateInitialFamilyThresholds).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ familyThresholdStatus: 'already_initialized' }));
  });
});

describe('Test 15 — existing initialized student does not duplicate (student_baseline_already_exists)', () => {
  it('still attempts initialization (which itself resolves to already_initialized), covering a baseline from an earlier assessment', async () => {
    const assessment = makeAssessmentInstance();
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'student_baseline_already_exists', baseline: { id: 5 }, reason: null });

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(mockCreateInitialFamilyThresholds).toHaveBeenCalledTimes(1);
  });
});

describe('Test 16 — no baseline yet -> Feature 2 initialization is skipped, never called', () => {
  it.each(['invalid_motor_profile', 'save_failed', 'collection_assessment_not_eligible', 'not_initial_assessment'])(
    'baselineStatus=%s never triggers createInitialFamilyThresholds',
    async (baselineStatus) => {
      const assessment = makeAssessmentInstance();
      mockFindByPk.mockResolvedValueOnce(assessment);
      mockExplanationFindAll.mockResolvedValueOnce([]);
      mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: baselineStatus, baseline: null, reason: null });

      const res = makeRes();
      await finalizeAssessment(makeReq(), res);

      expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ familyThresholdStatus: 'skipped_no_baseline' }));
    }
  );
});

describe('Test 17 — Feature 2 initialization failure is non-fatal', () => {
  it('a thrown error from createInitialFamilyThresholds never rolls back finalize or changes its status code', async () => {
    const assessment = makeAssessmentInstance();
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockExplanationFindAll.mockResolvedValueOnce([]);
    mockCreateInitialFamilyThresholds.mockRejectedValueOnce(new Error('DB down'));

    const res = makeRes();
    await finalizeAssessment(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ familyThresholdStatus: 'save_failed', finalizeStatus: 'finalized' }));
  });
});

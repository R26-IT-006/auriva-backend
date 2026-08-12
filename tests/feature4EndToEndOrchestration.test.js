'use strict';

// Feature 4 Step 6 — Final Orchestration + End-to-End Validation (backend).
//
// Integration-oriented tests exercising the COMPLETE backend chain for a
// pre-writing recommendation: getPreWritingRecommendation (controller) →
// evaluatePreWritingRecommendation (Step 4) → getPreWritingPrimitiveMapping
// (Step 2, pure) + getEasiestActivityId (Step 4 catalogue, pure) →
// evaluateDynamicThresholds (REAL Feature 2 Step 5) + evaluateSupportRecommendations
// (REAL Feature 3 Step 5) → their own real internals (getCurrentFamilyThreshold,
// getRecentFamilyPerformance, getSupportPerformanceByFamily). Only
// ../src/models is mocked (LetterAttempt + ThresholdHistory, plus every
// write-method stand-in for the read-only-guarantee assertions) — every
// other layer is the REAL, unmodified module, proving the actual
// composition Feature 4 relies on rather than a stubbed approximation. Same
// convention as tests/feature3EndToEndOrchestration.test.js.
const mockLaFindAll    = jest.fn();
const mockLaCount      = jest.fn();
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();
const mockLaSave       = jest.fn();

const mockThFindOne    = jest.fn();
const mockThFindAll    = jest.fn();
const mockThCreate     = jest.fn();
const mockThBulkCreate = jest.fn();
const mockThUpdate     = jest.fn();
const mockThDestroy    = jest.fn();

const mockSfCreate     = jest.fn();
const mockSfBulkCreate = jest.fn();
const mockSfUpdate     = jest.fn();
const mockSfDestroy    = jest.fn();

const mockStudentFindByPk = jest.fn();
const mockStudentFindOne  = jest.fn();
const mockStudentUpdate   = jest.fn();
const mockTransaction     = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    count:   (...a) => mockLaCount(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate, destroy: mockLaDestroy, save: mockLaSave,
  },
  ThresholdHistory: {
    findOne: (...a) => mockThFindOne(...a),
    findAll: (...a) => mockThFindAll(...a),
    create: mockThCreate, bulkCreate: mockThBulkCreate, update: mockThUpdate, destroy: mockThDestroy,
  },
  ShapeFeature: {
    create: mockSfCreate, bulkCreate: mockSfBulkCreate, update: mockSfUpdate, destroy: mockSfDestroy,
  },
  Student: { findByPk: (...a) => mockStudentFindByPk(...a), findOne: (...a) => mockStudentFindOne(...a), update: mockStudentUpdate },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const { evaluatePreWritingRecommendation, REASON } = require('../src/services/adaptivePreWritingService');
const { evaluateDynamicThresholds } = require('../src/services/dynamicThresholdService');
const { evaluateSupportRecommendations } = require('../src/services/adaptiveSupportService');
const { getPreWritingRecommendation } = require('../src/controllers/handwritingController');

// ─── Shared fixtures — same proven formula as feature3EndToEndOrchestration ─

function featuresForScore(score) {
  const dtw = (45 * (100 - score)) / 70;
  return { smoothness: 0, dtw_distance: dtw, pauseCount: 0, strokeCount: 1, completionTime: 1000 };
}

let idCounter;
beforeEach(() => { idCounter = 1; });
function nextId() { return idCounter++; }

function attemptRow(overrides = {}) {
  return {
    id: nextId(), student_id: 13, letter: 'o', case_type: 'lowercase',
    session_key: `s-${idCounter}`, attempt_number: 3, support_level: null,
    collection_mode: false, capture_status: 'complete',
    features: featuresForScore(80),
    created_at: new Date(2026, 0, 1, 0, 0, idCounter),
    ...overrides,
  };
}

/** attempt_number=3 rows for Feature 2's per-family window (curved: c/o). */
function feature2Attempts(scores) {
  return scores.map(score => attemptRow({ letter: 'o', attempt_number: 3, features: featuresForScore(score) }));
}

/** attempt_number rows for Feature 3's support-level windows (1=high, 2=medium, 3=low). */
function feature3Attempts(level, scores) {
  const attemptNumber = { high: 1, medium: 2, low: 3 }[level];
  return scores.map(score => attemptRow({ letter: 'o', attempt_number: attemptNumber, features: featuresForScore(score) }));
}

function makeThresholdRow(overrides = {}) {
  return {
    id: 1, student_id: 13, scope_type: 'family', scope_key: 'curved', baseline_family: 'curved',
    old_threshold: null, new_threshold: 80, source: 'initial_from_baseline', reason: 'baseline_plus_margin',
    baseline_id: 1, baseline_version: 'baseline-v1', mapping_version: 'letter-baseline-family-v1',
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

const READ_FAILED = Symbol('READ_FAILED');

function setupTargets(fixture) {
  mockThFindOne.mockImplementation(({ where }) => {
    const value = fixture[where.scope_key];
    if (value === READ_FAILED) return Promise.reject(new Error('connection lost'));
    return Promise.resolve(value ?? null);
  });
}

/**
 * Routes LetterAttempt.findAll() to the right fixture based on the actual
 * `where` shape each real caller uses: Feature 2's fetchFamilyWindow()
 * always includes `attempt_number: 3` in its where clause (one call per
 * family, all three routed to the same feature2Rows here — this test only
 * ever asserts on the 'curved' family's resulting decision, so straight/
 * complex incidentally seeing the same rows is harmless); Feature 3's
 * getSupportPerformanceByFamily() issues exactly one broader query with NO
 * attempt_number key at all.
 */
function setupRows({ feature2Rows = [], feature3Rows = [] } = {}) {
  mockLaFindAll.mockImplementation(({ where } = {}) => {
    if (Object.prototype.hasOwnProperty.call(where, 'attempt_number')) {
      return Promise.resolve(feature2Rows);
    }
    return Promise.resolve(feature3Rows);
  });
}

function makeReq({ studentId = '13', letter = 'c', caseType = 'lowercase', userId = 14 } = {}) {
  return { params: { studentId, letter, caseType }, user: { id: userId } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave,
                     mockThCreate, mockThBulkCreate, mockThUpdate, mockThDestroy,
                     mockSfCreate, mockSfBulkCreate, mockSfUpdate, mockSfDestroy, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaCount.mockResolvedValue(0);
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
  setupTargets({ straight: null, curved: makeThresholdRow(), complex: null });
  setupRows({});
});

// ─── §38 Test 1 — Feature 3 review trigger ─────────────────────────────────

describe('E2E Test 1 — Feature 3 support_review trigger (real Feature 2 + Feature 3 chain)', () => {
  it('Feature2=hold + Feature3=support_review (real row data) → recommended, reason=feature3_support_review', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),          // 2/5 meet 80 → hold
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),  // 0/5 meet 80, complete → support_review
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.signals).toEqual({ feature2Decision: 'hold', feature3Decision: 'support_review' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE3_SUPPORT_REVIEW);
    expect(result.activityId).toBe('connect_curve_dots');
  });
});

// ─── §38 Test 2 — Feature 2 review trigger ─────────────────────────────────

describe('E2E Test 2 — Feature 2 support_review trigger (real chain)', () => {
  it('Feature2=support_review + Feature3=recommend_high (real row data) → recommended, reason=feature2_support_review', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),          // 0/5 meet 80 → support_review
      feature3Rows: feature3Attempts('high', [82, 81, 83, 79, 84]),  // 4/5 meet 80, complete → recommend_high
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'recommend_high' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE2_SUPPORT_REVIEW);
    // Proves Feature 3's recommend_high is NOT itself sufficient — Feature 2
    // is the only reason this recommendation fired.
  });
});

// ─── §38 Test 3 — both review, Feature 3 priority ──────────────────────────

describe('E2E Test 3 — both support_review (real chain) — Feature 3 reason priority', () => {
  it('Feature2=support_review + Feature3=support_review → recommended, reason=feature3_support_review, both diagnostics visible', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'support_review' });
    expect(result.reason).toBe(REASON.FEATURE3_SUPPORT_REVIEW);
    expect(result.recommended).toBe(true);
  });
});

// ─── §38 Test 4 — no persistent difficulty ─────────────────────────────────

describe('E2E Test 4 — no persistent difficulty (real chain)', () => {
  it('Feature2=hold + Feature3=recommend_medium → not recommended, reason=no_persistent_difficulty', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),            // 2/5 → hold
      feature3Rows: feature3Attempts('medium', [82, 81, 83, 79, 84]),  // 4/5 medium → recommend_medium
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals).toEqual({ feature2Decision: 'hold', feature3Decision: 'recommend_medium' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
    expect(result.activityId).toBeNull();
  });

  it('Feature2=raise + Feature3=recommend_low → not recommended, reason=no_persistent_difficulty', async () => {
    setupRows({
      feature2Rows: feature2Attempts([95, 96, 97, 98, 99]),         // 5/5 → raise
      feature3Rows: feature3Attempts('low', [82, 81, 83, 79, 84]),  // 4/5 low → recommend_low
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals.feature2Decision).toBe('raise');
    expect(result.signals.feature3Decision).toBe('recommend_low');
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });
});

// ─── §38 Test 5 — insufficient data ────────────────────────────────────────

describe('E2E Test 5 — insufficient data (real chain, sparse evidence on both sides)', () => {
  it('fewer than 5 attempts on both sides → insufficient_data, never a default warm-up', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81]),           // only 2 — incomplete window
      feature3Rows: feature3Attempts('high', [70, 71]),   // only 2 — incomplete window
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals).toEqual({ feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.INSUFFICIENT_DATA);
  });
});

// ─── §38 Test 6 — no target ─────────────────────────────────────────────────

describe('E2E Test 6 — no family target (real chain)', () => {
  it('no ThresholdHistory row for curved → insufficient_target, no fallback to 55', async () => {
    setupTargets({ straight: null, curved: null, complex: null });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals.feature2Decision).toBe('no_target');
    expect(result.signals.feature3Decision).toBe('insufficient_target');
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.INSUFFICIENT_TARGET);
  });
});

// ─── §38 Test 7 — ambiguous letter ─────────────────────────────────────────

describe('E2E Test 7 — ambiguous letter (real chain, zero DB reads)', () => {
  it('"a" is Feature 2-ambiguous → not_applicable, never queries Feature 2/3 at all', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.reason).toBe(REASON.NOT_APPLICABLE);
    expect(result.recommended).toBe(false);
    expect(result.signals).toBeNull();
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
  });
});

// ─── §38 Test 8 — u/U no activity ──────────────────────────────────────────

describe('E2E Test 8 — u/U no activity available (real chain, zero DB reads)', () => {
  it('"u" resolves family=complex/primitiveGroup=mixed → no_activity_available, never substitutes, zero DB reads', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'u', caseType: 'lowercase' });
    expect(result.family).toBe('complex');
    expect(result.primitiveGroup).toBe('mixed');
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_ACTIVITY_AVAILABLE);
    expect(result.activityId).toBeNull();
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  it('"U" (uppercase) behaves identically', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'U', caseType: 'uppercase' });
    expect(result.reason).toBe(REASON.NO_ACTIVITY_AVAILABLE);
    expect(result.activityId).toBeNull();
  });
});

// ─── §38 Test 9 — deterministic activity ───────────────────────────────────

describe('E2E Test 9 — deterministic activity selection (real chain, repeated calls)', () => {
  it('the same signals always resolve to the same activityId across repeated evaluations', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [82, 81, 83, 79, 84]),
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' }))
    );
    const uniqueIds = new Set(results.map(r => r.activityId));
    expect(uniqueIds.size).toBe(1);
    expect([...uniqueIds][0]).toBe('connect_curve_dots');
  });
});

// ─── §38 Test 10 — exactly one activity id ─────────────────────────────────

describe('E2E Test 10 — exactly one activity id, never a list', () => {
  it('activityId is a single string, not an array, even though multiple activities exist for the curved group', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [82, 81, 83, 79, 84]),
    });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(typeof result.activityId).toBe('string');
    expect(Array.isArray(result.activityId)).toBe(false);
  });
});

// ─── §38 Test 11 — read failure ─────────────────────────────────────────────

describe('E2E Test 11 — read failure (real chain, fail-closed)', () => {
  it('a ThresholdHistory read error propagates to status=read_failed, never a partial recommendation', async () => {
    setupTargets({ straight: null, curved: READ_FAILED, complex: null });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.recommended).toBe(false);
  });

  it('the controller maps a service read_failed to a 500 ApiError', async () => {
    setupTargets({ straight: null, curved: READ_FAILED, complex: null });
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
  });
});

// ─── §38 Test 12 — zero DB writes ──────────────────────────────────────────

describe('E2E Test 12 — zero DB writes across every scenario', () => {
  it('a full support_review-triggering evaluation performs zero writes of any kind', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
    });
    await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expectNoWrites();
  });

  it('driven through the real controller, still zero writes', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
    });
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommended: true }));
    expectNoWrites();
  });
});

// ─── §38 Test 13 — Feature 2 threshold service remains unchanged/independent ─

describe('E2E Test 13 — Feature 2 threshold decision is unaffected by a Feature 4 evaluation', () => {
  it('calling evaluatePreWritingRecommendation does not alter what evaluateDynamicThresholds independently returns', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
    });
    const before = await evaluateDynamicThresholds({ studentId: 13 });
    await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    const after = await evaluateDynamicThresholds({ studentId: 13 });
    expect(after.families.curved.decision).toBe(before.families.curved.decision);
    expect(after.families.curved.currentThreshold).toBe(before.families.curved.currentThreshold);
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

// ─── §38 Test 14 — Feature 3 support-decision service remains unchanged/independent ─

describe('E2E Test 14 — Feature 3 support decision is unaffected by a Feature 4 evaluation', () => {
  it('calling evaluatePreWritingRecommendation does not alter what evaluateSupportRecommendations independently returns', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
    });
    const before = await evaluateSupportRecommendations({ studentId: 13 });
    await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    const after = await evaluateSupportRecommendations({ studentId: 13 });
    expect(after.families.curved.decision).toBe(before.families.curved.decision);
    expect(after.families.curved.recommendedSupport).toBe(before.families.curved.recommendedSupport);
  });
});

// ─── Full HTTP-facing chain — headline scenario driven through the controller ─

describe('Full chain through the controller — headline acceptance scenario', () => {
  it('Feature 3 support_review on "c" (real Feature 2 + Feature 3 data) → the minimal child-facing payload the frontend actually consumes', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
    });
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith({
      status: 'evaluated', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: 'curved', primitiveGroup: 'curved',
      recommended: true, activityId: 'connect_curve_dots', reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    });
    expectNoWrites();
  });
});

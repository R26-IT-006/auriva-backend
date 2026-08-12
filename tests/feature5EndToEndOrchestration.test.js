'use strict';

// Feature 5 Step 4 — Final Orchestration + End-to-End Validation (backend).
//
// Integration-oriented tests exercising the COMPLETE backend chain for a
// repetition recommendation: getRepetitionRecommendation (controller) →
// evaluateRepetitionRecommendation (Step 2) → getBaselineFamily (pure) →
// repetitionPolicy's cap check → evaluateDynamicThresholds (REAL Feature 2
// Step 5) + evaluateSupportRecommendations (REAL Feature 3 Step 5) + a REAL
// LetterAttempt history read → buildCycleHistory (pure). Only ../src/models
// is mocked (LetterAttempt + ThresholdHistory, plus every write-method
// stand-in for the read-only-guarantee assertions) — every other layer is
// the REAL, unmodified module. Same convention as
// tests/feature4EndToEndOrchestration.test.js.
const mockLaFindAll    = jest.fn();
const mockLaCount      = jest.fn();
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();
const mockLaSave       = jest.fn();

const mockLpFindOne      = jest.fn().mockResolvedValue(null);
const mockLpFindOrCreate = jest.fn();
const mockLpCreate       = jest.fn();
const mockLpUpdate       = jest.fn();
const mockLpIncrement    = jest.fn();
const mockLpDestroy      = jest.fn();

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

const mockTransaction = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    count:   (...a) => mockLaCount(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate, destroy: mockLaDestroy, save: mockLaSave,
  },
  LetterProgress: {
    findOne: (...a) => mockLpFindOne(...a),
    findOrCreate: (...a) => mockLpFindOrCreate(...a),
    create: mockLpCreate, update: mockLpUpdate, increment: mockLpIncrement, destroy: mockLpDestroy,
  },
  ThresholdHistory: {
    findOne: (...a) => mockThFindOne(...a),
    findAll: (...a) => mockThFindAll(...a),
    create: mockThCreate, bulkCreate: mockThBulkCreate, update: mockThUpdate, destroy: mockThDestroy,
  },
  ShapeFeature: {
    create: mockSfCreate, bulkCreate: mockSfBulkCreate, update: mockSfUpdate, destroy: mockSfDestroy,
  },
  Student: { findByPk: jest.fn().mockResolvedValue(null), findOne: jest.fn().mockResolvedValue(null), update: jest.fn() },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const { evaluateRepetitionRecommendation } = require('../src/services/repetitionRecommendationService');
const { evaluateDynamicThresholds } = require('../src/services/dynamicThresholdService');
const { evaluateSupportRecommendations } = require('../src/services/adaptiveSupportService');
const { getRepetitionRecommendation } = require('../src/controllers/handwritingController');

// ─── Shared fixtures — same proven formula as feature4EndToEndOrchestration ─

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

function feature2Attempts(scores) {
  return scores.map(score => attemptRow({ letter: 'o', attempt_number: 3, features: featuresForScore(score) }));
}

function feature3Attempts(level, scores) {
  const attemptNumber = { high: 1, medium: 2, low: 3 }[level];
  return scores.map(score => attemptRow({ letter: 'o', attempt_number: attemptNumber, features: featuresForScore(score) }));
}

/** History rows for repetitionRecommendationService's own cycle-count query
 * — same (letter='c', caseType='lowercase') the tests below evaluate. */
function historySession(sessionKey, attemptNumbers) {
  return attemptNumbers.map(n => ({ session_key: sessionKey, attempt_number: n }));
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
 * `where` shape each real caller uses:
 *   - Feature 2's fetchFamilyWindow() always includes `attempt_number` —
 *     checked FIRST (its where clause also happens to include
 *     capture_status, so order matters).
 *   - Feature 3's getSupportPerformanceByFamily() has no attempt_number but
 *     does include `capture_status`.
 *   - repetitionRecommendationService's own history query has neither —
 *     only student_id/letter/case_type/collection_mode.
 */
function setupRows({ feature2Rows = [], feature3Rows = [], historyRows = [] } = {}) {
  mockLaFindAll.mockImplementation(({ where } = {}) => {
    if (Object.prototype.hasOwnProperty.call(where, 'attempt_number')) {
      return Promise.resolve(feature2Rows);
    }
    if (Object.prototype.hasOwnProperty.call(where, 'capture_status')) {
      return Promise.resolve(feature3Rows);
    }
    return Promise.resolve(historyRows);
  });
}

function makeReq({ studentId = '13', letter = 'c', caseType = 'lowercase', userId = 14, adaptiveRepetitionsUsed } = {}) {
  const query = adaptiveRepetitionsUsed === undefined ? {} : { adaptiveRepetitionsUsed: String(adaptiveRepetitionsUsed) };
  return { params: { studentId, letter, caseType }, query, user: { id: userId } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave,
                     mockLpCreate, mockLpUpdate, mockLpIncrement, mockLpDestroy,
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

// ─── §50 Test 1 — Feature 3 support_review trigger ─────────────────────────

describe('E2E Test 1 — Feature 3 support_review trigger (real Feature 2 + Feature 3 + history chain)', () => {
  it('Feature2=hold + Feature3=support_review (real row data) -> shouldRepeat, reason=feature3_support_review', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),          // 2/5 meet 80 -> hold
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),  // 0/5 meet 80, complete -> support_review
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
    expect(result.status).toBe('evaluated');
    expect(result.signals).toEqual({ feature2Decision: 'hold', feature3Decision: 'support_review' });
    expect(result.shouldRepeat).toBe(true);
    expect(result.reason).toBe('feature3_support_review');
    expect(result.history).toEqual({ totalCycles: 1, cleanCycles: 1, malformedCycles: 0 });
  });
});

// ─── §50 Test 2 — Feature 2 support_review trigger ─────────────────────────

describe('E2E Test 2 — Feature 2 support_review trigger (real chain)', () => {
  it('Feature2=support_review + Feature3=recommend_high -> shouldRepeat, reason=feature2_support_review', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),          // 0/5 -> support_review
      feature3Rows: feature3Attempts('high', [82, 81, 83, 79, 84]),  // 4/5 -> recommend_high
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'recommend_high' });
    expect(result.shouldRepeat).toBe(true);
    expect(result.reason).toBe('feature2_support_review');
    // Proves Feature 3's recommend_high is NOT itself sufficient.
  });
});

// ─── §50 Test 3 — both review, Feature 3 priority ──────────────────────────

describe('E2E Test 3 — both support_review (real chain) — Feature 3 reason priority', () => {
  it('shouldRepeat=true, reason=feature3_support_review, both diagnostics visible', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'support_review' });
    expect(result.reason).toBe('feature3_support_review');
  });
});

// ─── §50 Test 4 — no persistent difficulty ─────────────────────────────────

describe('E2E Test 4 — no persistent difficulty (real chain)', () => {
  it('Feature2=hold + Feature3=recommend_medium -> not repeated, reason=no_persistent_difficulty', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),
      feature3Rows: feature3Attempts('medium', [82, 81, 83, 79, 84]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe('no_persistent_difficulty');
  });

  it('Feature2=raise + Feature3=recommend_low -> not repeated, reason=no_persistent_difficulty', async () => {
    setupRows({
      feature2Rows: feature2Attempts([95, 96, 97, 98, 99]),
      feature3Rows: feature3Attempts('low', [82, 81, 83, 79, 84]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals.feature2Decision).toBe('raise');
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe('no_persistent_difficulty');
  });
});

// ─── §50 Test 5 — insufficient data ────────────────────────────────────────

describe('E2E Test 5 — insufficient data (real chain, sparse evidence)', () => {
  it('fewer than 5 attempts on both sides -> insufficient_data, never a default repetition', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81]),
      feature3Rows: feature3Attempts('high', [70, 71]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals).toEqual({ feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe('insufficient_data');
  });
});

// ─── §50 Test 6 — insufficient target ──────────────────────────────────────

describe('E2E Test 6 — no family target (real chain)', () => {
  it('no ThresholdHistory row for curved -> insufficient_target, no fallback to 55', async () => {
    setupTargets({ straight: null, curved: null, complex: null });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals.feature2Decision).toBe('no_target');
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe('insufficient_target');
  });
});

// ─── §50 Test 7 — ambiguous letter ─────────────────────────────────────────

describe('E2E Test 7 — ambiguous letter (real chain, zero DB reads)', () => {
  it('"a" is Feature 2-ambiguous -> not_applicable, never queries Feature 2/3/history at all', async () => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.reason).toBe('not_applicable');
    expect(result.shouldRepeat).toBe(false);
    expect(result.signals).toBeNull();
    expect(result.history).toBeNull();
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
  });
});

// ─── §50 Test 8 — cap reached ───────────────────────────────────────────────

describe('E2E Test 8 — cap reached (real chain, zero expensive reads)', () => {
  it('adaptiveRepetitionsUsed=1 (== cap) -> cap_reached, signals/history null, zero Feature 2/3/history reads', async () => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 1 });
    expect(result.reason).toBe('cap_reached');
    expect(result.family).toBe('curved');
    expect(result.signals).toBeNull();
    expect(result.history).toBeNull();
    expect(result.policy).toEqual({ maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 1, remainingAdaptiveRepetitions: 0 });
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  it('driven through the real controller with ?adaptiveRepetitionsUsed=1', async () => {
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c', adaptiveRepetitionsUsed: 1 }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cap_reached', signals: null, history: null }));
    expectNoWrites();
  });
});

// ─── §50 Test 9 — history diagnostic only ──────────────────────────────────

describe('E2E Test 9 — history is diagnostic only, never a trigger (real chain, 30 real history rows)', () => {
  it('30 historical cycles + no support_review -> no repetition, history still fully reported', async () => {
    const manyHistoryRows = [];
    for (let i = 0; i < 30; i++) manyHistoryRows.push(...historySession(`s${i}`, [1, 2, 3]));
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),           // hold
      feature3Rows: feature3Attempts('high', [82, 81, 83, 79, 84]),   // recommend_high
      historyRows: manyHistoryRows,
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history.totalCycles).toBe(30);
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe('no_persistent_difficulty');
  });
});

// ─── §50 Test 10 — malformed history ────────────────────────────────────────

describe('E2E Test 10 — malformed session history counted diagnostically, never gates the decision', () => {
  it('malformed sessions do not suppress an otherwise-qualifying repetition', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: [...historySession('s1', [3]), ...historySession('s2', [1, 2])], // both malformed
    });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history).toEqual({ totalCycles: 2, cleanCycles: 0, malformedCycles: 2 });
    expect(result.shouldRepeat).toBe(true); // still fires — malformed history never suppresses
  });
});

// ─── §50 Test 11 — read failure ─────────────────────────────────────────────

describe('E2E Test 11 — read failure (real chain, fail-closed)', () => {
  it('a ThresholdHistory read error propagates to status=read_failed, never a partial recommendation', async () => {
    setupTargets({ straight: null, curved: READ_FAILED, complex: null });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.shouldRepeat).toBe(false);
  });

  it('the controller maps a service read_failed to a 500 ApiError', async () => {
    setupTargets({ straight: null, curved: READ_FAILED, complex: null });
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
  });
});

// ─── §50 Test 12 — zero DB writes ───────────────────────────────────────────

describe('E2E Test 12 — zero DB writes across every scenario', () => {
  it('a full support_review-triggering evaluation performs zero writes of any kind', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expectNoWrites();
  });

  it('driven through the real controller, still zero writes', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ shouldRepeat: true }));
    expectNoWrites();
    // Specifically confirm blocked_attempts/LetterProgress is never touched.
    expect(mockLpIncrement).not.toHaveBeenCalled();
    expect(mockLpFindOrCreate).not.toHaveBeenCalled();
  });
});

// ─── §50 Test 13 — Feature 2 independence ──────────────────────────────────

describe('E2E Test 13 — Feature 2 threshold decision is unaffected by a Feature 5 evaluation', () => {
  it('calling evaluateRepetitionRecommendation does not alter what evaluateDynamicThresholds independently returns', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const before = await evaluateDynamicThresholds({ studentId: 13 });
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    const after = await evaluateDynamicThresholds({ studentId: 13 });
    expect(after.families.curved.decision).toBe(before.families.curved.decision);
    expect(after.families.curved.currentThreshold).toBe(before.families.curved.currentThreshold);
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

// ─── §50 Test 14 — Feature 3 independence ──────────────────────────────────

describe('E2E Test 14 — Feature 3 support decision is unaffected by a Feature 5 evaluation', () => {
  it('calling evaluateRepetitionRecommendation does not alter what evaluateSupportRecommendations independently returns', async () => {
    setupRows({
      feature2Rows: feature2Attempts([60, 61, 62, 63, 64]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const before = await evaluateSupportRecommendations({ studentId: 13 });
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    const after = await evaluateSupportRecommendations({ studentId: 13 });
    expect(after.families.curved.decision).toBe(before.families.curved.decision);
    expect(after.families.curved.recommendedSupport).toBe(before.families.curved.recommendedSupport);
  });
});

// ─── Full HTTP-facing chain — headline scenario driven through the controller ─

describe('Full chain through the controller — headline acceptance scenario', () => {
  it('Feature 3 support_review on "c" (real Feature 2 + Feature 3 + history data) -> the minimal child-facing payload the frontend actually consumes', async () => {
    setupRows({
      feature2Rows: feature2Attempts([82, 81, 60, 61, 62]),
      feature3Rows: feature3Attempts('high', [70, 71, 72, 73, 74]),
      historyRows: historySession('s1', [1, 2, 3]),
    });
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c', adaptiveRepetitionsUsed: 0 }), res);
    expect(res.json).toHaveBeenCalledWith({
      status: 'evaluated', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: 'curved', shouldRepeat: true, reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
      policy: { maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 0, remainingAdaptiveRepetitions: 1 },
      history: { totalCycles: 1, cleanCycles: 1, malformedCycles: 0 },
    });
    expectNoWrites();
  });
});

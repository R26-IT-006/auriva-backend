'use strict';

// Feature 3 Step 3 — saveLetterAttempts() / recordLetterCompletion()
// integration tests for per-attempt support_level persistence.
//
// saveLetterAttempts() is not exported (private to handwritingController.js
// — module.exports only lists the route handlers), so — exactly like
// tests/recordLetterCompletionOrchestration.test.js already does for
// Feature 2 Step 8's controller integration — these tests drive it
// indirectly through recordLetterCompletion() and inspect what was passed
// to the mocked LetterAttempt.bulkCreate(). Same mocking shape as that file
// (models, feature normalization, motor score, Feature 2 services all
// mocked so these tests exercise only the support_level plumbing, not logic
// already covered elsewhere).
const mockResolveProgressionThreshold = jest.fn();
const mockProcessDynamicThresholdAfterLetterSession = jest.fn();
const mockGetStudentThreshold = jest.fn();

const mockLetterProgressFindOrCreate = jest.fn();
const mockLetterProgressFindOne = jest.fn();
const mockLetterProgressFindAll = jest.fn();
const mockStudentFindByPk = jest.fn();
const mockLetterAttemptBulkCreate = jest.fn();

const mockLoggerWarn = jest.fn();

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
  // Pass raw features straight through inside `normalized` so per-row
  // feature-data equivalence (Save Test 8) is easy to assert.
  normalizeLetterFeatures: jest.fn((features) => ({
    normalized: { ...features, stroke_order_meta: features?.stroke_order_meta ?? null },
    validity: {},
  })),
}));

jest.mock('../src/utils/motorScore', () => ({
  computeMotorScore: jest.fn().mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' }),
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

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), error: jest.fn(), debug: jest.fn(),
  warn: (...a) => mockLoggerWarn(...a),
}));

const { recordLetterCompletion } = require('../src/controllers/handwritingController');

function makeAttempt(attemptNumber, overrides = {}) {
  return {
    attempt_number: attemptNumber,
    features: { smoothness: 0.1, dtw_distance: 10, pauseCount: 0, completionTime: 400, strokeCount: 1 },
    strokes: [],
    ...overrides,
  };
}

function makeReq(overrides = {}) {
  return {
    user: { id: 7 },
    body: {
      student_id: 13, letter: 'c', case_type: 'lowercase',
      attempt_scores: [90], wrote_correctly: true,
      attempts: [
        makeAttempt(1, { support_level: 'high' }),
        makeAttempt(2, { support_level: 'medium' }),
        makeAttempt(3, { support_level: 'low' }),
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
  return { status: 'resolved', threshold: 50, source: 'legacy_default', family: null, historyId: null, ...overrides };
}

function orchestrationResult(overrides = {}) {
  return { status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 7 });
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]); // avoids the 5-clean-pass auto-raise branch
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(55);
  mockResolveProgressionThreshold.mockResolvedValue(feature2Result());
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue(orchestrationResult());
});

function bulkCreateRows() {
  expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
  return mockLetterAttemptBulkCreate.mock.calls[0][0];
}

// ─── Save Test 1 — three explicit support values persist separately ───────

describe('Save Test 1 — three explicit support values persist separately', () => {
  it('each row carries its own attempt\'s support_level, not one shared value', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    expect(rows.map(r => r.support_level)).toEqual(['high', 'medium', 'low']);
  });
});

// ─── Save Test 2/3/4 — per-attempt mapping ─────────────────────────────────

describe('Save Test 2 — attempt 1 high', () => {
  it('row for attempt_number 1 has support_level = high', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    const row = rows.find(r => r.attempt_number === 1);
    expect(row.support_level).toBe('high');
  });
});

describe('Save Test 3 — attempt 2 medium', () => {
  it('row for attempt_number 2 has support_level = medium', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    const row = rows.find(r => r.attempt_number === 2);
    expect(row.support_level).toBe('medium');
  });
});

describe('Save Test 4 — attempt 3 low', () => {
  it('row for attempt_number 3 has support_level = low', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    const row = rows.find(r => r.attempt_number === 3);
    expect(row.support_level).toBe('low');
  });
});

// ─── Save Test 5 — missing support_level remains null ─────────────────────

describe('Save Test 5 — missing support_level remains null', () => {
  it('an attempt object with no support_level key persists null, and does not block the request', async () => {
    const req = makeReq({
      attempts: [
        { attempt_number: 1, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] }, // no support_level
      ],
    });
    const res = makeRes();
    await recordLetterCompletion(req, res);
    const rows = bulkCreateRows();
    expect(rows[0].support_level).toBeNull();
    expect(res.json).toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled(); // absent is not a warning case
  });

  it('an invalid explicit support_level persists null AND logs a warning (never rejects the request)', async () => {
    const req = makeReq({
      attempts: [
        { attempt_number: 1, support_level: 'extreme', features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
      ],
    });
    const res = makeRes();
    await recordLetterCompletion(req, res);
    const rows = bulkCreateRows();
    expect(rows[0].support_level).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toMatch(/invalid support_level/i);
    expect(res.json).toHaveBeenCalled();
  });
});

// ─── Save Test 6 — collection attempt 3 can persist low ───────────────────

describe('Save Test 6 — collection attempt 3 can persist low', () => {
  it('collection-mode requests persist the logical support identity per attempt, including low at attempt 3', async () => {
    const req = makeReq({
      collection_mode: true,
      attempts: [
        makeAttempt(1, { support_level: 'high' }),
        makeAttempt(2, { support_level: 'medium' }),
        makeAttempt(3, { support_level: 'low' }),
      ],
    });
    const res = makeRes();
    await recordLetterCompletion(req, res);
    const rows = bulkCreateRows();
    expect(rows.map(r => r.support_level)).toEqual(['high', 'medium', 'low']);
    expect(rows.every(r => r.collection_mode === true)).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ completed: true, collection_mode: true }));
  });
});

// ─── Save Test 7 — no value copied across attempts ─────────────────────────

describe('Save Test 7 — no value copied across attempts', () => {
  it('support_level differs per row while best_score/threshold (genuinely session-level) stay identical across rows', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();

    const supportLevels = rows.map(r => r.support_level);
    expect(new Set(supportLevels).size).toBe(3); // all three distinct — never copied

    // Contrast: best_score/threshold ARE session-level and SHOULD be
    // identical across every row of the session — confirms support_level's
    // per-row behavior is a deliberate difference, not an oversight.
    expect(new Set(rows.map(r => r.best_score)).size).toBe(1);
    expect(new Set(rows.map(r => r.threshold)).size).toBe(1);
  });
});

// ─── Save Test 8 — existing feature data unchanged ─────────────────────────

describe('Save Test 8 — existing feature data unchanged', () => {
  it('features/normalized_features/motor_score are computed exactly as before, unaffected by adding support_level', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();

    expect(rows[0].features).toEqual({ smoothness: 0.1, dtw_distance: 10, pauseCount: 0, completionTime: 400, strokeCount: 1 });
    expect(rows[0].motor_score).toBe(80);
    expect(rows[0].quality_score).toBe(80);
    expect(rows[0].score_version).toBe('v1');
  });
});

// ─── Save Test 9 — existing session_key behavior unchanged ────────────────

describe('Save Test 9 — existing session_key behavior unchanged', () => {
  it('all rows from one completion call share one generated session_key', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    const keys = new Set(rows.map(r => r.session_key));
    expect(keys.size).toBe(1);
    expect(typeof rows[0].session_key).toBe('string');
    expect(rows[0].session_key.length).toBeGreaterThan(0);
  });
});

// ─── Save Test 10 — existing capture metadata unchanged ───────────────────

describe('Save Test 10 — existing capture metadata unchanged', () => {
  it('capture_status/collection_mode/collection_accepted still compute as before', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    for (const row of rows) {
      expect(row.collection_mode).toBe(false);
      expect(row.collection_accepted).toBe(true);
      expect(['complete', 'incomplete']).toContain(row.capture_status);
    }
  });
});

// ─── Backward compatibility — old payload shape (no support_level at all) ─

describe('Backward compatibility — old client payload without support_level', () => {
  it('letter completion still succeeds; every row persists support_level = null', async () => {
    const req = makeReq({
      // Coverage-fix audit: attempt_scores overridden to match this
      // override's 3-entry attempts array — makeReq's default
      // attempt_scores ([90], a single-element simplified default) would
      // otherwise mismatch this test's 3-entry attempts and trip the new
      // index-alignment fail-open warning, which this test isn't about.
      attempt_scores: [90, 90, 90],
      attempts: [
        { attempt_number: 1, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
        { attempt_number: 2, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
        { attempt_number: 3, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
      ],
    });
    const res = makeRes();

    await expect(recordLetterCompletion(req, res)).resolves.not.toThrow();

    const rows = bulkCreateRows();
    expect(rows.every(r => r.support_level === null)).toBe(true);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

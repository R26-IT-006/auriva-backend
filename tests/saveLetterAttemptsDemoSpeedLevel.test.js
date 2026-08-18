'use strict';

// Feature 6 Step 5 — saveLetterAttempts() / recordLetterCompletion()
// integration tests for per-attempt demo_speed_level persistence. Mirrors
// tests/saveLetterAttemptsSupportLevel.test.js's exact convention (same
// mocking shape, same indirect-drive-through-the-controller approach since
// saveLetterAttempts is private to handwritingController.js).
//
// Covers spec §52 items 15-18: valid save, invalid rejected to null, null
// accepted, and no historical backfill — plus the attempt-level HIGH/slow,
// MEDIUM/null, LOW/null shape from spec §37.
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
jest.mock('../src/services/teacherService', () => ({}));

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
    body: {
      student_id: 13, letter: 'c', case_type: 'lowercase',
      attempt_scores: [90], wrote_correctly: true,
      attempts: [
        makeAttempt(1, { support_level: 'high', demo_speed_level: 'slow' }),
        makeAttempt(2, { support_level: 'medium', demo_speed_level: null }),
        makeAttempt(3, { support_level: 'low', demo_speed_level: null }),
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
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]);
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(55);
  mockResolveProgressionThreshold.mockResolvedValue(feature2Result());
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue(orchestrationResult());
});

function bulkCreateRows() {
  expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
  return mockLetterAttemptBulkCreate.mock.calls[0][0];
}

// ─── Item 15 — valid demo_speed_level saves exactly as sent, per attempt ──

describe('Item 15 — valid demo_speed_level values persist exactly as sent, per attempt', () => {
  it('matches the HIGH->slow, MEDIUM->null, LOW->null shape from spec §37', async () => {
    // Coverage-fix audit: attempt_scores overridden to match makeReq's
    // default 3-entry attempts array — see saveLetterAttemptsSupportLevel
    // .test.js's identical note for why.
    await recordLetterCompletion(makeReq({ attempt_scores: [90, 90, 90] }), makeRes());
    const rows = bulkCreateRows();
    expect(rows.map(r => r.demo_speed_level)).toEqual(['slow', null, null]);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('a valid "standard" demo_speed_level also persists exactly as sent', async () => {
    const req = makeReq({ attempts: [makeAttempt(1, { support_level: 'high', demo_speed_level: 'standard' })] });
    await recordLetterCompletion(req, makeRes());
    const rows = bulkCreateRows();
    expect(rows[0].demo_speed_level).toBe('standard');
  });

  it('a same-letter retry\'s new HIGH attempt may again store "slow" — that is correct (spec §38)', async () => {
    const req = makeReq({
      attempts: [
        makeAttempt(1, { support_level: 'high', demo_speed_level: 'slow' }), // first HIGH attempt of the retry cycle
      ],
    });
    await recordLetterCompletion(req, makeRes());
    const rows = bulkCreateRows();
    expect(rows[0].demo_speed_level).toBe('slow');
  });
});

// ─── Item 16 — invalid demo_speed_level rejected to null + warning ────────

describe('Item 16 — invalid demo_speed_level is rejected to null, with a logged warning, never blocking the save', () => {
  it('an unapproved value ("fast") persists null and logs exactly one warning', async () => {
    const req = makeReq({ attempts: [makeAttempt(1, { support_level: 'high', demo_speed_level: 'fast' })] });
    const res = makeRes();
    await recordLetterCompletion(req, res);
    const rows = bulkCreateRows();
    expect(rows[0].demo_speed_level).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toMatch(/invalid demo_speed_level/i);
    expect(res.json).toHaveBeenCalled();
  });

  it.each(['medium', 'RANDOM', 0.21, true, {}, []])('a malformed value %p never throws and always persists null', async (bad) => {
    const req = makeReq({ attempts: [makeAttempt(1, { support_level: 'high', demo_speed_level: bad })] });
    await expect(recordLetterCompletion(req, makeRes())).resolves.not.toThrow();
    const rows = bulkCreateRows();
    expect(rows[0].demo_speed_level).toBeNull();
  });
});

// ─── Item 17 — null accepted silently ──────────────────────────────────────

describe('Item 17 — an explicit or absent demo_speed_level is accepted silently as null (no warning)', () => {
  it('explicit null — the expected shape for MEDIUM/LOW/reduce-motion/collection attempts', async () => {
    const req = makeReq({ attempts: [makeAttempt(2, { support_level: 'medium', demo_speed_level: null })] });
    const res = makeRes();
    await recordLetterCompletion(req, res);
    const rows = bulkCreateRows();
    expect(rows[0].demo_speed_level).toBeNull();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('absent key entirely (older client, predates Feature 6 Step 5) — also null, never blocks the save', async () => {
    const req = makeReq({
      attempts: [{ attempt_number: 1, support_level: 'high', features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] }],
    });
    const res = makeRes();
    await expect(recordLetterCompletion(req, res)).resolves.not.toThrow();
    const rows = bulkCreateRows();
    expect(rows[0].demo_speed_level).toBeNull();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});

// ─── Item 18 — no historical backfill ──────────────────────────────────────

describe('Item 18 — this save path never backfills or touches historical rows', () => {
  it('bulkCreate is called exactly once with only the new session\'s rows — an insert-only append, never an UPDATE of existing data', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
    const rows = bulkCreateRows();
    expect(rows).toHaveLength(3);
  });

  it('the LetterAttempt mock exposes no update/destroy method for this controller to have called even if it wanted to', () => {
    const models = require('../src/models');
    expect(models.LetterAttempt.update).toBeUndefined();
    expect(models.LetterAttempt.destroy).toBeUndefined();
  });
});

// ─── No server-side derivation (spec §41) ──────────────────────────────────

describe('demo_speed_level is never derived server-side', () => {
  it('a HIGH-support attempt with no demo_speed_level sent still persists null, never a guessed "standard"', async () => {
    const req = makeReq({ attempts: [makeAttempt(1, { support_level: 'high' })] }); // no demo_speed_level key
    const res = makeRes();
    await recordLetterCompletion(req, res);
    const rows = bulkCreateRows();
    expect(rows[0].support_level).toBe('high');
    expect(rows[0].demo_speed_level).toBeNull();
  });

  it('the resolver function never reads a.support_level, a.attempt_number, or any recommendation field to derive demo_speed_level', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/function resolveAttemptDemoSpeedLevel[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/support_level|attempt_number|recommendedSpeedLevel/);
  });
});

// ─── Per-attempt, not session-level (mirrors support_level's own proof) ────

describe('demo_speed_level is per-attempt, never copied across a session\'s rows', () => {
  it('differs per row while collection_mode/best_score (genuinely session-level) stay identical', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    const rows = bulkCreateRows();
    expect(rows.map(r => r.demo_speed_level)).toEqual(['slow', null, null]);
    expect(new Set(rows.map(r => r.best_score)).size).toBe(1);
    expect(new Set(rows.map(r => r.collection_mode)).size).toBe(1);
  });
});

// ─── Backward compatibility ─────────────────────────────────────────────────

describe('Backward compatibility — old client payload without demo_speed_level at all', () => {
  it('letter completion still succeeds; every row persists demo_speed_level = null', async () => {
    const req = makeReq({
      // Coverage-fix audit: attempt_scores overridden to match this
      // override's 3-entry attempts array — see saveLetterAttemptsSupportLevel
      // .test.js's identical note for why.
      attempt_scores: [90, 90, 90],
      attempts: [
        { attempt_number: 1, support_level: 'high', features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
        { attempt_number: 2, support_level: 'medium', features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
        { attempt_number: 3, support_level: 'low', features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [] },
      ],
    });
    const res = makeRes();

    await expect(recordLetterCompletion(req, res)).resolves.not.toThrow();

    const rows = bulkCreateRows();
    expect(rows.every(r => r.demo_speed_level === null)).toBe(true);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

'use strict';

// Mastery-semantics correction — recordLetterCompletion()'s letter_progress
// WRITE behaviour, and every mastery READER that depends on it.
//
// Reuses the mock scaffolding of recordLetterCompletionMasteryHook.test.js
// (same controller, same boundaries) so these tests exercise the real
// controller code path rather than a re-implementation.
//
// ORIGINAL HEADER, for the shared scaffolding below:
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


// ═══════════════════════════════════════════════════════════════════════════
// WRITE behaviour — mastered_at is set only by a real mastery event
// ═══════════════════════════════════════════════════════════════════════════

/** Forces the failure branch: authoritative score below the threshold. */
function failThisSession() {
  mockComputeMotorScore.mockReturnValue({ motor_score: 10, quality_score: 10, score_version: 'v1' });
}

describe('1. a FAILED session records progress but never mastery', () => {
  it('creates/updates letter_progress WITHOUT setting mastered_at', async () => {
    failThisSession();
    const rec = makeProgressRecord({ blocked_attempts: 0 });
    mockLetterProgressFindOrCreate.mockResolvedValue([rec, true]);

    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);

    expect(mockLetterProgressFindOrCreate).toHaveBeenCalledTimes(1);
    const defaults = mockLetterProgressFindOrCreate.mock.calls[0][0].defaults;
    expect(defaults).not.toHaveProperty('mastered_at');
    // And nothing later stamps it either.
    for (const call of rec.update.mock.calls) {
      expect(call[0]).not.toHaveProperty('mastered_at');
    }
  });

  it('still increments blocked_attempts (unchanged behaviour)', async () => {
    failThisSession();
    const rec = makeProgressRecord();
    mockLetterProgressFindOrCreate.mockResolvedValue([rec, true]);

    await recordLetterCompletion(makeReq(), makeRes());
    expect(rec.increment).toHaveBeenCalledWith('blocked_attempts', { by: 1 });
  });

  it('reports completed:false and never calls the evidence hook', async () => {
    failThisSession();
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);

    expect(res.json.mock.calls[0][0].completed).toBe(false);
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
  });
});

describe('2. a PASSING session sets mastered_at', () => {
  it('direct PASS stamps mastered_at at creation', async () => {
    const before = Date.now();
    await recordLetterCompletion(makeReq(), makeRes());
    const after = Date.now();

    const defaults = mockLetterProgressFindOrCreate.mock.calls[0][0].defaults;
    expect(defaults.mastered_at).toBeInstanceOf(Date);
    expect(defaults.mastered_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(defaults.mastered_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('FAIL -> PASS stamps mastered_at on the existing, previously-unmastered row', async () => {
    // The row already exists (created by an earlier failure) and has never
    // been mastered — findOrCreate therefore ignores `defaults`.
    const rec = makeProgressRecord({ mastered_at: null });
    mockLetterProgressFindOrCreate.mockResolvedValue([rec, false]);

    await recordLetterCompletion(makeReq(), makeRes());

    const masteryUpdate = rec.update.mock.calls.find(c => 'mastered_at' in c[0]);
    expect(masteryUpdate).toBeDefined();
    expect(masteryUpdate[0].mastered_at).toBeInstanceOf(Date);
  });

  it('a repeated PASS never rewrites the ORIGINAL mastery timestamp', async () => {
    const original = new Date('2026-01-01T00:00:00.000Z');
    const rec = makeProgressRecord({ mastered_at: original });
    mockLetterProgressFindOrCreate.mockResolvedValue([rec, false]);

    await recordLetterCompletion(makeReq(), makeRes());

    const masteryUpdate = rec.update.mock.calls.find(c => 'mastered_at' in c[0]);
    expect(masteryUpdate).toBeUndefined();
  });

  it('the evidence hook still runs on a real mastery', async () => {
    await recordLetterCompletion(makeReq(), makeRes());
    expect(mockOnLetterMastered).toHaveBeenCalledTimes(1);
  });
});

describe('3. mastery counts read mastered_at, never row existence', () => {
  it('the progress endpoint counts only mastered rows', () => {
    const src = require('fs').readFileSync(
      require.resolve('../src/controllers/handwritingController.js'), 'utf8');
    const block = src.slice(
      src.indexOf('lowercase_completed, uppercase_completed'),
      src.indexOf('const reason = latest'),
    );
    expect(block).toMatch(/case_type: 'lowercase', mastered_at: \{ \[Op\.ne\]: null \}/);
    expect(block).toMatch(/case_type: 'uppercase', mastered_at: \{ \[Op\.ne\]: null \}/);
  });

  it('pass/fail, threshold and Motor Score rules are untouched by this change', async () => {
    // The pass gate is still bestScore >= threshold, decided before any
    // letter_progress write.
    const src = require('fs').readFileSync(
      require.resolve('../src/controllers/handwritingController.js'), 'utf8');
    expect(src).toMatch(/if \(masteryScore == null \|\| masteryScore < threshold\)/);

    // A failing score still fails, a passing score still passes.
    failThisSession();
    const failRes = makeRes();
    await recordLetterCompletion(makeReq(), failRes);
    expect(failRes.json.mock.calls[0][0].completed).toBe(false);

    jest.clearAllMocks();
    mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 7 });
    mockComputeMotorScore.mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' });
    mockLetterAttemptBulkCreate.mockResolvedValue([]);
    mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
    mockLetterProgressFindAll.mockResolvedValue([]);
    mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn() });
    mockResolveProgressionThreshold.mockResolvedValue(feature2Result());
    mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue(orchestrationResult());
    mockOnLetterMastered.mockResolvedValue({ status: 'evidence_created' });

    // The success path returns the mastery record itself (id/letter/threshold)
    // and a 201/200 — never a `completed:false`.
    const passRes = makeRes();
    await recordLetterCompletion(makeReq(), passRes);
    const body = passRes.json.mock.calls[0][0];
    expect(body).toHaveProperty('id');
    expect(body.completed).toBeUndefined();
    expect(passRes.status).toHaveBeenCalledWith(201);
  });

  it('the 5-clean-passes threshold rule is deliberately NOT changed', () => {
    const src = require('fs').readFileSync(
      require.resolve('../src/controllers/handwritingController.js'), 'utf8');
    // Still reads every row and still keys on blocked_attempts — this is a
    // threshold calculation, explicitly out of scope for the mastery fix.
    expect(src).toMatch(/recentPasses\.every\(r => r\.blocked_attempts === 0\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// READERS — every mastery read filters on mastered_at
// ═══════════════════════════════════════════════════════════════════════════

describe('4. mastery readers require mastered_at IS NOT NULL', () => {
  const fs = require('fs');
  const read = (p) => fs.readFileSync(require.resolve(p), 'utf8');

  it('getMasteredLetterPairs filters on mastered_at', () => {
    const src = read('../src/services/letterCategoryCompletionService.js');
    const fn = src.slice(src.indexOf('async function getMasteredLetterPairs'));
    expect(fn).toMatch(/mastered_at: \{ \[Op\.ne\]: null \}/);
  });

  it('category completion filters on mastered_at', () => {
    const src = read('../src/services/letterCategoryCompletionService.js');
    const fn = src.slice(src.indexOf('async function isCategoryComplete'), src.indexOf('async function getAllCategory'));
    expect(fn).toMatch(/mastered_at: \{ \[Op\.ne\]: null \}/);
  });

  it('the periodic report counts and DATES mastery by mastered_at, not completed_at', () => {
    const src = read('../src/services/periodicReportService.js');
    const fn = src.slice(src.indexOf('async function buildLearningProgressSection'), src.indexOf('// C. Motor-performance'));
    expect(fn).toMatch(/mastered_at: \{ \[Op\.ne\]: null, \[Op\.lte\]: endAt \}/);
    expect(fn).toMatch(/new Date\(r\.mastered_at\)/);
  });

  it('both Feature 11B scripts consider only mastered reference letters', () => {
    for (const p of ['../scripts/auditLetterMotorBackfill.js', '../scripts/backfillLetterMotorEvidence.js']) {
      expect(read(p)).toMatch(/mastered_at: \{ \[Op\.ne\]: null \}/);
    }
  });

  it('queries that legitimately need blocked/in-progress rows are NOT filtered', () => {
    const src = read('../src/controllers/handwritingController.js');
    // The failure branch's own findOrCreate must still find a row regardless
    // of mastery, or blocked_attempts could never accumulate.
    const failBranch = src.slice(
      src.indexOf('if (masteryScore == null || masteryScore < threshold)'),
      // Endpoint marker, not the whole `message:` line — the message became
      // conditional when capture faults gained their own wording.
      src.indexOf("'Quality threshold not met'"),
    );
    expect(failBranch).toMatch(/LetterProgress\.findOrCreate/);
    expect(failBranch).not.toMatch(/mastered_at/);
  });
});

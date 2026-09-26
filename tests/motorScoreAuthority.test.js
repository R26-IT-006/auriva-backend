'use strict';

// Motor Score Unification — spec §10/§29/§30. Proves, end-to-end through
// the real recordLetterCompletion controller (with only the model layer
// and neighboring services mocked), that:
//   1. a client cannot FORCE a pass by sending inflated attempt_scores
//   2. a client cannot FORCE a failure by sending suppressed attempt_scores
//   3. the backend-computed motor score is what actually decides the outcome
//   4/5. threshold comparison and bestScore share the SAME authoritative
//        domain (computeMotorScore()) — never a client-supplied number
//   6/7. LetterProgress/blocked_attempts are driven only by the
//        authoritative comparison
//   11. the frontend's own local estimate cannot create mastery
//   30. a synthetic case where the OLD featuresToScore()-domain score and
//       the NEW computeMotorScore()-domain score would have diverged
//       produces the NEW (authoritative) outcome, consistently.
//
// computeMotorScore() itself is NOT mocked here — real features/strokes
// are supplied so the actual production formula decides the outcome,
// proving the full real pipeline, not just the wiring.

const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const mockResolveProgressionThreshold = jest.fn();
jest.mock('../src/services/progressionThresholdResolver', () => ({
  resolveProgressionThreshold: (...a) => mockResolveProgressionThreshold(...a),
}));

const mockProcessDynamicThresholdAfterLetterSession = jest.fn();
jest.mock('../src/services/dynamicThresholdService', () => ({
  processDynamicThresholdAfterLetterSession: (...a) => mockProcessDynamicThresholdAfterLetterSession(...a),
}));

const mockGetStudentThreshold = jest.fn();
jest.mock('../src/utils/thresholdUtils', () => ({
  getStudentThreshold: (...a) => mockGetStudentThreshold(...a),
}));

const mockOnLetterMastered = jest.fn();
jest.mock('../src/services/letterMotorMasteryService', () => ({
  onLetterMastered: (...a) => mockOnLetterMastered(...a),
}));
jest.mock('../src/services/letterCategoryCompletionService', () => ({}));
jest.mock('../src/services/explainabilityService', () => ({ analyzeMotorDifficulty: jest.fn() }));
jest.mock('../src/services/motorBaselineService', () => ({ createInitialMotorBaseline: jest.fn(), getStudentMotorBaseline: jest.fn() }));
jest.mock('../src/services/motorClusterService', () => ({ predictInitialMotorCluster: jest.fn() }));

const mockLetterProgressFindOrCreate = jest.fn();
const mockLetterProgressFindOne = jest.fn();
const mockLetterProgressFindAll = jest.fn();
const mockStudentFindByPk = jest.fn();
const mockLetterAttemptBulkCreate = jest.fn();

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

const { recordLetterCompletion } = require('../src/controllers/handwritingController');

const TEACHER_ID = 7;
const STUDENT_ID = 13;
const THRESHOLD = 55;

// Real stroke_points shape (see attemptCoverageValidity.js's own
// flattenStrokePoints): [{stroke_id, points:[{x,y,t,tAbs}, ...]}].
// Long, spread-out, timestamped path — passes the coverage/geometry gate
// AND has real trajectory data for computeMotorScore's speed/direction
// components, so the REAL formula (not a mock) produces a genuine score.
function realGoodStroke() {
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    pts.push({ x: 20 + i * 4, y: 20 + i * 3, t: i * 15, tAbs: 1700000000000 + i * 15 });
  }
  return [{ stroke_id: 0, points: pts }];
}

// A jittery, direction-reversing, slow path — produces a genuinely LOW
// computeMotorScore() (poor smoothness/direction/speed), independent of
// whatever the client claims.
function realPoorStroke() {
  const pts = [];
  let x = 20, y = 20;
  for (let i = 0; i <= 60; i++) {
    x += (i % 2 === 0) ? 15 : -13; // sharp back-and-forth reversals
    y += (i % 3 === 0) ? 10 : -9;
    pts.push({ x, y, t: i * 260, tAbs: 1700000000000 + i * 260 }); // slow (large t gaps)
  }
  return [{ stroke_id: 0, points: pts }];
}

function makeAttempt({ good, features = {} } = {}) {
  return {
    attempt_number: 1,
    strokes: good ? realGoodStroke() : realPoorStroke(),
    // features only supplies dtw_distance/smoothness raw deviation inputs
    // that aren't otherwise derivable from geometry alone in this test
    // harness — direction/speed/pause are still derived from the real
    // stroke geometry above by the real normalizeLetterFeatures() pipeline.
    features: good
      ? { smoothness: 0.05, dtw_distance: 3, ...features }
      : { smoothness: 1.8, dtw_distance: 40, ...features },
  };
}

function makeReq({ attemptQuality, attemptScores, letter = 'l' } = {}) {
  return {
    user: { id: TEACHER_ID },
    body: {
      student_id: STUDENT_ID, letter, case_type: 'lowercase', wrote_correctly: true,
      // The adversarial payload — a client claiming whatever score it wants.
      attempt_scores: attemptScores,
      // A FULL cycle. Mastery is decided on attempt 3 only (see
      // config/masteryPolicy.js), so a one-attempt payload could never
      // master regardless of quality — that would test the cycle-shape rule
      // rather than the property this suite is about, which is that the
      // CLIENT's claimed scores never affect the outcome. All three attempts
      // share the same quality so the only variable is the claim.
      attempts: [
        makeAttempt({ good: attemptQuality === 'good' }),
        makeAttempt({ good: attemptQuality === 'good' }),
        makeAttempt({ good: attemptQuality === 'good' }),
      ],
    },
  };
}

function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
function makeProgressRecord(overrides = {}) {
  return { id: 1, increment: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined), ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_ID, teacher_id: TEACHER_ID });
  mockResolveProgressionThreshold.mockResolvedValue({ status: 'resolved', threshold: THRESHOLD, source: 'global_default', family: null, historyId: null });
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue({ status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null });
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]);
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(THRESHOLD);
});

// ─── 1. client attempt_scores cannot force a pass ──────────────────────────
describe('A client cannot force mastery by inflating attempt_scores', () => {
  it('genuinely POOR handwriting (real jittery/reversing/slow strokes) is BLOCKED even when the client claims attempt_scores=[100]', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'poor', attemptScores: [100] }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.completed).toBe(false);
    expect(body.bestScore).toBeLessThan(THRESHOLD);
    expect(body.bestScore).not.toBe(100); // the claimed value never appears as the authoritative score
    // findOrCreate IS called on the blocked path too (to bump blocked_attempts),
    // but never with the mastery-only `progression_score_version` default —
    // that only appears on the genuine success path below.
    expect(mockLetterProgressFindOrCreate).toHaveBeenCalledTimes(1);
    expect(mockLetterProgressFindOrCreate.mock.calls[0][0].defaults).not.toHaveProperty('progression_score_version');
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
  });
});

// ─── 2. client attempt_scores cannot force a failure ───────────────────────
describe('A client cannot force a false block by suppressing attempt_scores', () => {
  it('genuinely GOOD handwriting (real smooth/fast/direct strokes) PASSES even when the client claims attempt_scores=[0]', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'good', attemptScores: [0] }), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(mockLetterProgressFindOrCreate).toHaveBeenCalledTimes(1);
    expect(mockOnLetterMastered).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. backend-computed score determines the outcome ──────────────────────
describe('The authoritative outcome depends only on the real captured data', () => {
  it('identical attempt_scores claims produce OPPOSITE outcomes depending only on real stroke/feature quality', async () => {
    const goodRes = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'good', attemptScores: [50] }), goodRes);
    const poorRes = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'poor', attemptScores: [50] }), poorRes);

    expect(goodRes.status).toHaveBeenCalledWith(201);       // passed
    expect(poorRes.json.mock.calls[0][0].completed).toBe(false); // blocked
  });
});

// ─── 11. missing attempt_scores entirely still gates correctly ────────────
describe('Gating does not depend on attempt_scores being present at all', () => {
  it('an omitted attempt_scores field still correctly blocks poor handwriting', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'poor', attemptScores: undefined }), res);
    expect(res.json.mock.calls[0][0].completed).toBe(false);
  });

  it('an omitted attempt_scores field still correctly passes good handwriting', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'good', attemptScores: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

// ─── 30. contradiction regression: a case where the OLD and NEW domains ───
// genuinely disagree, proving the controller now follows computeMotorScore()
// and not the retired featuresToScore()-mirror.
//
// Fixture rationale (values verified by direct pipeline execution, not
// hand math): smoothness=0.05/dtw_distance=3 alone make the OLD formula
// (0.7 dtw / 0.3 smoothness, see attemptPerformanceScore.js) score this
// attempt 94/100 — a clear, comfortable pass against any realistic
// threshold. The SAME attempt's real stroke geometry is extremely slow
// (avg_speed ~0.0048 px/ms, far under the 0.05 "too slow" floor) and
// reports pause_count=6 (over the 5-pause ceiling) — both invisible to the
// old smoothness/dtw-only formula, but scored by computeMotorScore()'s
// speed/pause components. Net effect: NEW = 57/100. A threshold of 65 sits
// strictly between the two, so the two domains give opposite verdicts.
describe('Contradiction regression: computeMotorScore() wins where the retired domain would have disagreed', () => {
  const { reconstructScoreFromFeatures } = require('../src/utils/attemptPerformanceScore');
  const DIVERGENT_THRESHOLD = 65;

  function divergentStrokes() {
    const pts = [];
    let x = 20, y = 20, t = 0;
    for (let i = 0; i < 40; i++) {
      x += (i % 2 === 0) ? 20 : -18; // sharp reversals -> direction_score = 0
      y += 5;
      t += 4000;                    // very slow -> speed_score near 0
      pts.push({ x, y, t, tAbs: 1700000000000 + t });
    }
    return [{ stroke_id: 0, points: pts }];
  }
  const divergentFeatures = { smoothness: 0.05, dtw_distance: 3, pause_count: 6 };

  it('sanity check: the retired old-domain formula WOULD have scored this a clear pass', () => {
    const old = reconstructScoreFromFeatures(divergentFeatures);
    expect(old.status).toBe('valid');
    expect(old.score).toBeGreaterThan(DIVERGENT_THRESHOLD);
  });

  it('the live controller BLOCKS this exact attempt, because computeMotorScore() — not the old formula — is authoritative', async () => {
    mockResolveProgressionThreshold.mockResolvedValueOnce({
      status: 'resolved', threshold: DIVERGENT_THRESHOLD, source: 'global_default', family: null, historyId: null,
    });
    const res = makeRes();
    await recordLetterCompletion({
      user: { id: TEACHER_ID },
      body: {
        student_id: STUDENT_ID, letter: 'l', case_type: 'lowercase', wrote_correctly: true,
        attempt_scores: [94], // client mirrors the old formula's number too — still overridden
        // Full three-attempt cycle — see makeReq above for why.
        attempts: [
          { attempt_number: 1, strokes: divergentStrokes(), features: divergentFeatures },
          { attempt_number: 2, strokes: divergentStrokes(), features: divergentFeatures },
          { attempt_number: 3, strokes: divergentStrokes(), features: divergentFeatures },
        ],
      },
    }, res);

    const body = res.json.mock.calls[0][0];
    expect(body.completed).toBe(false);
    expect(body.bestScore).toBeLessThan(DIVERGENT_THRESHOLD);
    expect(body.bestScore).toBeLessThan(94); // strictly below what the retired domain would have produced
  });
});

// ─── 6/7. LetterProgress/blocked_attempts driven only by the authoritative comparison ──
describe('Mastery/blocking bookkeeping is driven only by the authoritative score', () => {
  it('a blocked (poor) session goes through the blocked bookkeeping path, never the mastery path', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'poor', attemptScores: [99] }), res);
    expect(mockLetterProgressFindOrCreate.mock.calls[0][0].defaults).not.toHaveProperty('progression_score_version');
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
  });

  it('a passing (good) session creates LetterProgress exactly once', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq({ attemptQuality: 'good', attemptScores: [1] }), res);
    expect(mockLetterProgressFindOrCreate).toHaveBeenCalledTimes(1);
  });
});

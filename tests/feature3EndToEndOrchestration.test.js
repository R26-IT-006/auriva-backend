'use strict';

// Feature 3 Step 7 — Final Orchestration + End-to-End Validation.
//
// Integration-oriented tests exercising the COMPLETE backend chain for a
// support recommendation: getSupportRecommendation (controller) →
// evaluateSupportRecommendations (Step 5) → getSupportPerformanceByFamily
// (Step 4) + getCurrentFamilyThreshold (Feature 2, read-only reference) →
// resolveAttemptSupportLevel (Step 4) → deriveAttemptPerformanceScore
// (Feature 2). Only ../src/models is mocked (LetterAttempt + ThresholdHistory,
// plus write-method stand-ins for the read-only-guarantee assertions) —
// every other layer is the REAL, unmodified module, proving the actual
// composition this feature relies on rather than a stubbed approximation.
// Same convention as tests/adaptiveSupportServiceRecommendation.test.js and
// tests/getSupportRecommendationEndpoint.test.js, now driven through the
// controller (the real HTTP-facing entry point) for the full-loop tests.
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

const mockStudentFindByPk = jest.fn();
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
  Student: { findByPk: (...a) => mockStudentFindByPk(...a), update: mockStudentUpdate },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

// teacherService is mocked only for the CONTROLLER-level tests (ownership
// check) — the service-level tests call evaluateSupportRecommendations
// directly and never touch it.
const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const { evaluateSupportRecommendations } = require('../src/services/adaptiveSupportService');
const { getSupportRecommendation } = require('../src/controllers/handwritingController');

// ─── Shared fixtures ────────────────────────────────────────────────────────

// Same proven formula as tests/dynamicThresholdService.test.js /
// tests/adaptiveSupportService.test.js's own featuresForScore() — exact
// round-trip through the real deriveAttemptPerformanceScore for score >= 30.
function featuresForScore(score) {
  const dtw = (45 * (100 - score)) / 70;
  return { smoothness: 0, dtw_distance: dtw, pauseCount: 0, strokeCount: 1, completionTime: 1000 };
}

const LETTER_FOR_FAMILY = { straight: 'l', curved: 'o', complex: 'v' };
const ATTEMPT_NUMBER_FOR_LEVEL = { high: 1, medium: 2, low: 3 };

let idCounter;
beforeEach(() => { idCounter = 1; });
function nextId() { return idCounter++; }

function attemptRow(overrides = {}) {
  return {
    id: 1, student_id: 13, letter: 'o', case_type: 'lowercase',
    session_key: 'session-1', attempt_number: 3, support_level: null,
    collection_mode: false, capture_status: 'complete',
    features: featuresForScore(80),
    created_at: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

/** Builds `scores.length` rows for one (family, level) — attempt_number set
 * by level unless overridden; no explicit support_level (proxy-sourced)
 * unless `explicit: true`. */
function makeLevelAttempts(level, scores, { family = 'curved', explicit = false, attemptNumber } = {}) {
  const resolvedAttemptNumber = attemptNumber ?? ATTEMPT_NUMBER_FOR_LEVEL[level];
  return scores.map((score) => {
    const id = nextId();
    return attemptRow({
      id,
      letter: LETTER_FOR_FAMILY[family],
      case_type: 'lowercase',
      session_key: `s-${id}`,
      attempt_number: resolvedAttemptNumber,
      support_level: explicit ? level : null,
      features: featuresForScore(score),
      created_at: new Date(2026, 0, 1, 0, 0, id),
    });
  });
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

function setupRows(rows) {
  mockLaFindAll.mockResolvedValueOnce(rows);
}

function makeReq({ studentId = '13', letter = 'c', caseType = 'lowercase', userId = 14 } = {}) {
  return { params: { studentId, letter, caseType }, user: { id: userId } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaCount.mockResolvedValue(0);
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
  setupTargets({ straight: null, curved: makeThresholdRow(), complex: null });
});

// ─── §29 End-to-end tests 1-5 — decision outcomes through the full chain ──

describe('E2E Test 1 — insufficient data → null recommendation', () => {
  it('sparse curved evidence produces recommendedSupport=null through the whole chain', async () => {
    setupRows(makeLevelAttempts('medium', [90, 91]));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: null, decision: 'insufficient_data' }));
  });
});

describe('E2E Test 2 — medium successful → recommend_medium', () => {
  it('4/5 medium scores meeting target 80 produce recommendedSupport=medium end-to-end', async () => {
    setupRows(makeLevelAttempts('medium', [82, 81, 83, 79, 84]));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: 'medium', decision: 'recommend_medium' }));
  });
});

describe('E2E Test 3 — low successful → recommend_low', () => {
  it('4/5 low scores meeting target produce recommendedSupport=low end-to-end', async () => {
    setupRows(makeLevelAttempts('low', [82, 81, 80, 79, 84]));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: 'low', decision: 'recommend_low' }));
  });
});

describe('E2E Test 4 — high only successful → recommend_high', () => {
  it('low/medium unsuccessful, high 4/5 → recommendedSupport=high', async () => {
    setupRows([
      ...makeLevelAttempts('low', [60, 61, 62, 63, 64]),
      ...makeLevelAttempts('medium', [65, 66, 67, 68, 69]),
      ...makeLevelAttempts('high', [82, 81, 83, 79, 84]),
    ]);
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: 'high', decision: 'recommend_high' }));
  });
});

describe('E2E Test 5 — high unsuccessful → support_review', () => {
  it('all three complete but none meet target → support_review, recommendedSupport=high, requiresReview=true', async () => {
    setupRows([
      ...makeLevelAttempts('low', [70, 71, 72, 73, 74]),
      ...makeLevelAttempts('medium', [74, 75, 76, 77, 78]),
      ...makeLevelAttempts('high', [76, 77, 78, 79, 75]),
    ]);
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      recommendedSupport: 'high', decision: 'support_review', requiresReview: true,
    }));
  });
});

// ─── §29 Test 6/7 — the critical explicit-vs-proxy feedback loop ──────────

describe('E2E Test 6 — explicit adaptive rows used instead of proxy (§6/§7 critical feedback-loop test)', () => {
  it('rows shaped exactly like a persisted adaptive session (attempt_number=1,support_level=medium; 2,low; 3,low) are read back as medium/low/low, never high/medium/low', async () => {
    // Simulates exactly what Step 3's buildSessionAttemptRecord() would have
    // persisted for a recommend_medium session (medium → low → low).
    const persistedAdaptiveSession = [
      attemptRow({ id: 1, letter: 'o', session_key: 'adaptive-session', attempt_number: 1, support_level: 'medium', features: featuresForScore(82) }),
      attemptRow({ id: 2, letter: 'o', session_key: 'adaptive-session', attempt_number: 2, support_level: 'low',    features: featuresForScore(81) }),
      attemptRow({ id: 3, letter: 'o', session_key: 'adaptive-session', attempt_number: 3, support_level: 'low',    features: featuresForScore(83) }),
    ];
    setupRows(persistedAdaptiveSession);

    const result = await evaluateSupportRecommendations({ studentId: 13 });
    const curved = result.families.curved;

    // The medium-tier row is correctly bucketed as medium (attempt_number=1
    // would have proxy-suggested "high" — explicit support_level overrides it).
    expect(curved.supportResults.medium.count).toBe(1);
    expect(curved.supportResults.high.count).toBe(0); // never proxy-guessed from attempt_number=1

    // Both low-tier rows (attempt_number 2 AND 3) are correctly bucketed as
    // low — attempt_number=2 would have proxy-suggested "medium" for the
    // second row; explicit support_level overrides it too.
    expect(curved.supportResults.low.count).toBe(2);

    expect(curved.evidenceQuality).toEqual({ explicitCount: 3, historicalProxyCount: 0, containsHistoricalProxy: false });
    expect(curved.evidenceBasis).toBe('explicit_only');
  });
});

describe('E2E Test 7 — explicit support dominates forever, even for a lone future-shaped row', () => {
  it('attempt_number=1 + support_level=low resolves to low, never the attempt-number proxy (high)', async () => {
    setupRows([attemptRow({ id: 1, letter: 'o', attempt_number: 1, support_level: 'low', features: featuresForScore(90) })]);
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.supportResults.low.count).toBe(1);
    expect(result.families.curved.supportResults.high.count).toBe(0);
  });
});

// ─── §29 Test 7(mixed) — mixed historical + explicit evidence ─────────────

describe('E2E Test 8 — mixed historical + explicit evidence in one family window', () => {
  it('honors explicit values, still uses historical rows, evidenceBasis=mixed, no duplication/misclassification', async () => {
    setupRows([
      // 2 old historical rows (no explicit support_level) — proxy-resolved.
      attemptRow({ id: 1, letter: 'o', session_key: 'old-1', attempt_number: 2, support_level: null, features: featuresForScore(82) }),
      attemptRow({ id: 2, letter: 'o', session_key: 'old-2', attempt_number: 2, support_level: null, features: featuresForScore(83) }),
      // 3 new explicit rows from a post-Step-3 adaptive session.
      attemptRow({ id: 3, letter: 'o', session_key: 'new-1', attempt_number: 1, support_level: 'medium', features: featuresForScore(81) }),
      attemptRow({ id: 4, letter: 'o', session_key: 'new-2', attempt_number: 2, support_level: 'medium', features: featuresForScore(84) }),
      attemptRow({ id: 5, letter: 'o', session_key: 'new-3', attempt_number: 3, support_level: 'medium', features: featuresForScore(79) }),
    ]);
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    const curved = result.families.curved;

    expect(curved.supportResults.medium.count).toBe(5); // all 5 land in medium, no misclassification
    expect(curved.evidenceQuality).toEqual({ explicitCount: 3, historicalProxyCount: 2, containsHistoricalProxy: true });
    expect(curved.evidenceBasis).toBe('mixed');
    expect(curved.decision).toBe('recommend_medium'); // 5/5 all >= target 80
  });
});

// ─── §29 Test 8/9/10/11 — family isolation, ambiguous, no target, read failure ─

describe('E2E Test 9 — mapped family isolation', () => {
  it('straight/curved/complex evidence never bleeds across families end-to-end', async () => {
    setupTargets({
      straight: makeThresholdRow({ scope_key: 'straight', baseline_family: 'straight', new_threshold: 70 }),
      curved:   makeThresholdRow({ scope_key: 'curved',   baseline_family: 'curved',   new_threshold: 80 }),
      complex:  makeThresholdRow({ scope_key: 'complex',  baseline_family: 'complex',  new_threshold: 75 }),
    });
    setupRows([
      ...makeLevelAttempts('low', [90, 91, 92, 93, 94], { family: 'straight' }),
      ...makeLevelAttempts('low', [10, 11, 12, 13, 14], { family: 'complex' }),
    ]);
    const result = await evaluateSupportRecommendations({ studentId: 13 });

    expect(result.families.straight.decision).toBe('recommend_low');
    expect(result.families.complex.decision).not.toBe('recommend_low'); // poor scores, must not inherit straight's success
    expect(result.families.curved.supportResults.low.count).toBe(0); // zero evidence, untouched
  });
});

describe('E2E Test 10 — ambiguous letter → not_applicable, no family evaluated', () => {
  it('never calls evaluateSupportRecommendations at all for an unmapped letter', async () => {
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'a' }), res); // 'a' is ambiguous
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: null, decision: 'not_applicable', recommendedSupport: null }));
    expect(mockLaFindAll).not.toHaveBeenCalled(); // no evidence query ever issued
  });
});

describe('E2E Test 11 — no Feature 2 target → insufficient_target, never global 55', () => {
  it('a mapped family with no initialized target never fabricates a recommendation', async () => {
    setupTargets({ straight: null, curved: null, complex: null });
    setupRows(makeLevelAttempts('medium', [82, 81, 83, 79, 84]));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: null, decision: 'insufficient_target' }));
  });
});

describe('E2E Test 12 — target read failure → safe 500, never a fabricated recommendation', () => {
  it('a DB error reading the family target aborts safely through the controller', async () => {
    setupTargets({ straight: null, curved: READ_FAILED, complex: null });
    setupRows(makeLevelAttempts('medium', [82, 81, 83, 79, 84]));
    const res = makeRes();
    await expect(getSupportRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── §29 Test 12/13/14 — no writes, Feature 2 untouched, no support history ─

describe('E2E Test 13 — recommendation endpoint performs no writes, through the full controller chain', () => {
  it('never calls create/bulkCreate/update/destroy/save on LetterAttempt or ThresholdHistory, never opens a transaction', async () => {
    setupRows(makeLevelAttempts('medium', [82, 81, 83, 79, 84]));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);

    expect(mockLaCreate).not.toHaveBeenCalled();
    expect(mockLaBulkCreate).not.toHaveBeenCalled();
    expect(mockLaUpdate).not.toHaveBeenCalled();
    expect(mockLaDestroy).not.toHaveBeenCalled();
    expect(mockLaSave).not.toHaveBeenCalled();
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
    expect(mockThDestroy).not.toHaveBeenCalled();
    expect(mockStudentUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('E2E Test 14 — Feature 2 current family target is never modified by a recommendation call', () => {
  it('the target returned is exactly the mocked ThresholdHistory value, regardless of which support level gets recommended', async () => {
    setupTargets({ straight: null, curved: makeThresholdRow({ new_threshold: 80 }), complex: null });

    // Case A: recommend_low
    setupRows(makeLevelAttempts('low', [82, 81, 83, 79, 84]));
    let result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.currentTarget).toBe(80);

    // Case B: support_review (poor performance everywhere)
    setupRows([
      ...makeLevelAttempts('low', [70, 71, 72, 73, 74]),
      ...makeLevelAttempts('medium', [74, 75, 76, 77, 78]),
      ...makeLevelAttempts('high', [76, 77, 78, 79, 75]),
    ]);
    result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.currentTarget).toBe(80); // unchanged — a poor recommendation never lowers the target

    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
  });
});

describe('E2E Test 15 — no support-decision history is written anywhere in this chain', () => {
  it('the controller and service source never reference a support-history table/model', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['../src/controllers/handwritingController.js', '../src/services/adaptiveSupportService.js']) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(codeOnly).not.toMatch(/student_support_history|StudentSupportHistory|SupportHistory/);
    }
  });
});

// ─── §9/§10/§11 — recommendation evolution + escalation + support_review ──

describe('Evolution Test — Stage A: insufficient data (software-behavior validation only, not a claim of real learning)', () => {
  it('sparse evidence never recommends anything', async () => {
    setupRows(makeLevelAttempts('medium', [90]));
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.decision).toBe('insufficient_data');
  });
});

describe('Evolution Test — Stage B: enough medium evidence → recommend_medium', () => {
  it('once medium reaches a complete, successful window, medium is recommended', async () => {
    setupRows(makeLevelAttempts('medium', [82, 81, 83, 79, 84]));
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.decision).toBe('recommend_medium');
  });
});

describe('Evolution Test — Stage C: enough low-support success → recommend_low', () => {
  it('once low ALSO reaches a complete, successful window, low (the lowest qualifying) is recommended', async () => {
    setupRows([
      ...makeLevelAttempts('medium', [82, 81, 83, 79, 84]),
      ...makeLevelAttempts('low',    [80, 85, 90, 82, 88]),
    ]);
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.decision).toBe('recommend_low'); // lowest qualifying level wins, not medium
  });
});

describe('Escalation Test — low/medium unsuccessful, high successful → recommend_high (conservative maintenance of assistance)', () => {
  it('confirms the system does not force a lower support level onto evidence that does not support it', async () => {
    setupRows([
      ...makeLevelAttempts('low', [60, 61, 62, 63, 64]),
      ...makeLevelAttempts('medium', [65, 66, 67, 68, 69]),
      ...makeLevelAttempts('high', [82, 83, 81, 84, 79]),
    ]);
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.decision).toBe('recommend_high');
  });
});

describe('No-endless-escalation Test — support_review is the ceiling, never a fabricated 4th level', () => {
  it('all three levels complete and poor produces support_review, not an invented "very_high"', async () => {
    setupRows([
      ...makeLevelAttempts('low', [70, 71, 72, 73, 74]),
      ...makeLevelAttempts('medium', [74, 75, 76, 77, 78]),
      ...makeLevelAttempts('high', [76, 77, 78, 79, 75]),
    ]);
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.families.curved.decision).toBe('support_review');
    expect(result.families.curved.recommendedSupport).toBe('high'); // the real maximum, nothing beyond it
    expect(['high', 'medium', 'low']).toContain(result.families.curved.recommendedSupport);
  });
});

// ─── §31 — Full acceptance scenario ─────────────────────────────────────────

describe('§31 Full acceptance scenario — Student X, curved, target 80', () => {
  it('low poor + medium 4/5 → recommend_medium; the frontend sequence and persisted shape are proven in the frontend test suite (this test proves the backend half)', async () => {
    setupTargets({ straight: null, curved: makeThresholdRow({ new_threshold: 80 }), complex: null });
    setupRows([
      ...makeLevelAttempts('low', [60, 62, 58, 61, 59]),          // poor
      ...makeLevelAttempts('medium', [82, 81, 83, 79, 84]),        // 4/5 meet 80
    ]);

    const result = await evaluateSupportRecommendations({ studentId: 13 });
    const curved = result.families.curved;

    expect(curved.decision).toBe('recommend_medium');
    expect(curved.recommendedSupport).toBe('medium');
    expect(curved.currentTarget).toBe(80);
    expect(curved.supportResults.medium.metTargetCount).toBe(4);
    expect(curved.requiresReview).toBe(false);

    // Now simulate what Step 3 would persist for THIS recommendation
    // (frontend sequence: medium, low, low) and prove the NEXT
    // reconstruction reads it back correctly as explicit, not proxy —
    // closing the full feedback loop end-to-end.
    setupRows([
      attemptRow({ id: 101, letter: 'o', session_key: 'next-session', attempt_number: 1, support_level: 'medium', features: featuresForScore(83) }),
      attemptRow({ id: 102, letter: 'o', session_key: 'next-session', attempt_number: 2, support_level: 'low',    features: featuresForScore(85) }),
      attemptRow({ id: 103, letter: 'o', session_key: 'next-session', attempt_number: 3, support_level: 'low',    features: featuresForScore(81) }),
    ]);
    const nextResult = await evaluateSupportRecommendations({ studentId: 13 });
    const nextCurved = nextResult.families.curved;

    expect(nextCurved.supportResults.medium.count).toBe(1);
    expect(nextCurved.supportResults.low.count).toBe(2);
    expect(nextCurved.supportResults.high.count).toBe(0); // never proxy-guessed
    expect(nextCurved.evidenceBasis).toBe('explicit_only');

    // Feature 2's target is completely unaffected by any of this.
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
  });
});

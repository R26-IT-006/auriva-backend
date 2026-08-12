'use strict';

// Feature 3 Step 5 — evaluateSupportRecommendations() tests. Mocks only
// ../src/models (LetterAttempt's findAll/count + write stand-ins, and
// ThresholdHistory's findOne + write stand-ins) — getBaselineFamily,
// deriveAttemptPerformanceScore, resolveAttemptSupportLevel, AND Feature 2's
// real getCurrentFamilyThreshold() (via dynamicThresholdService.js) are all
// real/unmocked, proving the actual composition this service relies on —
// same convention tests/dynamicThresholdService.test.js and
// tests/adaptiveSupportService.test.js already established.
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

const mockTransaction = jest.fn();

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

const { evaluateSupportRecommendations, SUPPORT_SUCCESS_MET_COUNT } = require('../src/services/adaptiveSupportService');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function featuresForScore(score) {
  const dtw = (45 * (100 - score)) / 70;
  return { smoothness: 0, dtw_distance: dtw, pauseCount: 0, strokeCount: 1, completionTime: 1000 };
}

let idCounter;
beforeEach(() => { idCounter = 1; });
function nextId() { return idCounter++; }

const LETTER_FOR_FAMILY = { straight: 'l', curved: 'o', complex: 'v' };
const ATTEMPT_NUMBER_FOR_LEVEL = { high: 1, medium: 2, low: 3 };

function attemptRow(overrides = {}) {
  return {
    id: 1,
    student_id: 13,
    letter: 'o',
    case_type: 'lowercase',
    session_key: 'session-1',
    attempt_number: 3,
    support_level: null,
    collection_mode: false,
    capture_status: 'complete',
    features: featuresForScore(80),
    created_at: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Builds `scores.length` rows for one (family, supportLevel) — attempt
 * number set by level (high=1/medium=2/low=3), no explicit support_level
 * (historical-proxy sourced) unless `explicit: true` is passed.
 */
function makeLevelAttempts(level, scores, { family = 'curved', explicit = false } = {}) {
  const attemptNumber = ATTEMPT_NUMBER_FOR_LEVEL[level];
  return scores.map((score) => {
    const id = nextId();
    return attemptRow({
      id,
      letter: LETTER_FOR_FAMILY[family],
      case_type: 'lowercase',
      session_key: `s-${id}`,
      attempt_number: attemptNumber,
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

/** @param {{straight?: Object|null|symbol, curved?: Object|null|symbol, complex?: Object|null|symbol}} fixture */
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

beforeEach(() => {
  jest.clearAllMocks();
  mockLaCount.mockResolvedValue(0);
  setupTargets({ straight: null, curved: makeThresholdRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 80 }), complex: null });
});

async function evalCurved(rows) {
  setupRows(rows);
  const result = await evaluateSupportRecommendations({ studentId: 13 });
  return result.families.curved;
}

// ─── Decision-rule tests (1–13) ─────────────────────────────────────────────

describe('Decision Test 1 — low 4/5 → recommend_low', () => {
  it('recommends low when its complete window meets the 4/5 success bar', async () => {
    const rows = makeLevelAttempts('low', [82, 81, 80, 79, 84]); // target 80: 4/5 meet
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_low');
    expect(curved.recommendedSupport).toBe('low');
    expect(curved.requiresReview).toBe(false);
  });
});

describe('Decision Test 2 — low 5/5 → recommend_low', () => {
  it('recommends low with a perfect success rate', async () => {
    const rows = makeLevelAttempts('low', [80, 85, 90, 82, 88]); // all >= 80
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_low');
    expect(curved.supportResults.low.metTargetCount).toBe(5);
  });
});

describe('Decision Test 3 — low incomplete, medium 4/5 → recommend_medium', () => {
  it('skips the incomplete low window and recommends medium', async () => {
    const rows = [
      ...makeLevelAttempts('low', [90, 91]), // only 2 — incomplete
      ...makeLevelAttempts('medium', [82, 83, 81, 79, 84]), // 4/5 meet
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_medium');
    expect(curved.recommendedSupport).toBe('medium');
  });
});

describe('Decision Test 4 — low poor, medium 4/5 → recommend_medium', () => {
  it('a complete-but-failing low is skipped in favor of a qualifying medium', async () => {
    const rows = [
      ...makeLevelAttempts('low', [79, 76, 75, 82, 78]), // 1/5 meet 80
      ...makeLevelAttempts('medium', [82, 83, 81, 79, 84]), // 4/5 meet
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_medium');
  });
});

describe('Decision Test 5 — low/medium poor, high 4/5 → recommend_high', () => {
  it('recommends high when it is the first complete+qualifying level', async () => {
    const rows = [
      ...makeLevelAttempts('low', [70, 71, 72, 73, 74]),
      ...makeLevelAttempts('medium', [74, 75, 76, 77, 78]),
      ...makeLevelAttempts('high', [82, 83, 81, 79, 84]), // 4/5 meet
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_high');
    expect(curved.recommendedSupport).toBe('high');
  });
});

describe('Decision Test 6 — all complete but high < 4 → support_review', () => {
  it('flags support_review with recommendedSupport=high when even max support falls short', async () => {
    const rows = [
      ...makeLevelAttempts('low', [70, 71, 72, 73, 74]),    // 0/5
      ...makeLevelAttempts('medium', [74, 75, 76, 77, 78]), // 0/5
      ...makeLevelAttempts('high', [79, 78, 82, 77, 76]),   // 1/5 meet (only 82)
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('support_review');
    expect(curved.recommendedSupport).toBe('high');
    expect(curved.requiresReview).toBe(true);
  });
});

describe('Decision Test 7 — no complete windows → insufficient_data', () => {
  it('never recommends anything from sparse evidence', async () => {
    const rows = [
      ...makeLevelAttempts('low', [90, 91]),
      ...makeLevelAttempts('medium', [90]),
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('insufficient_data');
    expect(curved.recommendedSupport).toBeNull();
    expect(curved.requiresReview).toBe(false);
  });
});

describe('Decision Test 8 — low/medium incomplete, high complete 4/5 → recommend_high', () => {
  it('recommends high even though the lower levels never had a chance to fail — they were simply skipped', async () => {
    const rows = [
      ...makeLevelAttempts('low', [90]),
      ...makeLevelAttempts('medium', [90, 91]),
      ...makeLevelAttempts('high', [82, 83, 81, 79, 84]), // 4/5 meet
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_high');
    expect(curved.recommendedSupport).toBe('high');
  });
});

describe('Decision Test 9 — exact target equality counts as met', () => {
  it('a score exactly equal to the target counts toward metTargetCount', async () => {
    const rows = makeLevelAttempts('low', [80, 80, 80, 80, 70]); // target 80, four exact ties
    const curved = await evalCurved(rows);
    expect(curved.supportResults.low.metTargetCount).toBe(4);
    expect(curved.decision).toBe('recommend_low');
  });
});

describe('Decision Test 10 — target 100 works', () => {
  it('only a perfect score of exactly 100 meets a target of 100', async () => {
    setupTargets({ straight: null, curved: makeThresholdRow({ new_threshold: 100 }), complex: null });
    const rows = makeLevelAttempts('low', [100, 100, 100, 100, 99]); // 4/5 exactly 100
    const curved = await evalCurved(rows);
    expect(curved.currentTarget).toBe(100);
    expect(curved.supportResults.low.metTargetCount).toBe(4);
    expect(curved.decision).toBe('recommend_low');
  });
});

describe('Decision Test 11 — target 0 works', () => {
  it('every score trivially meets a target of 0, even poor ones', async () => {
    setupTargets({ straight: null, curved: makeThresholdRow({ new_threshold: 0 }), complex: null });
    const rows = makeLevelAttempts('low', [35, 40, 45, 38, 42]); // all >= 0
    const curved = await evalCurved(rows);
    expect(curved.currentTarget).toBe(0);
    expect(curved.supportResults.low.metTargetCount).toBe(5);
    expect(curved.decision).toBe('recommend_low');
  });
});

describe('Decision Test 12 — no target → insufficient_target', () => {
  it('never fabricates a target, including never falling back to the legacy global default 55', async () => {
    setupTargets({ straight: null, curved: null, complex: null });
    const rows = makeLevelAttempts('low', [82, 81, 80, 79, 84]);
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('insufficient_target');
    expect(curved.recommendedSupport).toBeNull();
    expect(curved.currentTarget).toBeNull();
    expect(curved.currentTarget).not.toBe(55);
  });
});

describe('Decision Test 13 — target read error → read_failed', () => {
  it('a DB error reading the family target aborts the whole evaluation, never silently proceeds', async () => {
    setupTargets({ straight: null, curved: READ_FAILED, complex: null });
    setupRows(makeLevelAttempts('low', [82, 81, 80, 79, 84]));
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expect(result.families).toBeNull();
  });
});

// ─── Lowest-successful-level tests (14–18) ─────────────────────────────────

describe('Lowest-Successful Test 14 — low qualifies even if medium/high averages are higher', () => {
  it('still recommends low, not the numerically better higher levels', async () => {
    const rows = [
      ...makeLevelAttempts('low', [82, 81, 80, 79, 84]),       // 4/5, avg 81.2
      ...makeLevelAttempts('medium', [95, 96, 97, 98, 99]),    // 5/5, avg much higher
      ...makeLevelAttempts('high', [99, 100, 98, 97, 100]),    // 5/5, highest
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_low');
    expect(curved.recommendedSupport).toBe('low');
  });
});

describe('Lowest-Successful Test 15 — medium qualifies even if high is perfect', () => {
  it('does not prefer a perfect high score over an already-qualifying medium', async () => {
    const rows = [
      ...makeLevelAttempts('low', [60, 61, 62, 63, 64]),        // 0/5
      ...makeLevelAttempts('medium', [82, 83, 81, 79, 84]),     // 4/5
      ...makeLevelAttempts('high', [100, 100, 100, 100, 100]),  // 5/5 perfect
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_medium');
  });
});

describe('Lowest-Successful Test 16 — high only chosen when lower levels fail qualification', () => {
  it('recommends high only after both low and medium fail their own qualification checks', async () => {
    const rows = [
      ...makeLevelAttempts('low', [60, 61, 62, 63, 64]),
      ...makeLevelAttempts('medium', [65, 66, 67, 68, 69]),
      ...makeLevelAttempts('high', [82, 83, 81, 79, 84]),
    ];
    const curved = await evalCurved(rows);
    expect(curved.decision).toBe('recommend_high');
  });
});

describe('Lowest-Successful Test 17 — incomplete low never qualifies, regardless of its own success rate', () => {
  it('a 4-observation low window with 100% success is still skipped for incompleteness', async () => {
    const rows = [
      ...makeLevelAttempts('low', [90, 91, 92, 93]), // 4 observations, all would meet target, but incomplete (needs 5)
      ...makeLevelAttempts('medium', [82, 83, 81, 79, 84]), // 4/5, complete
    ];
    const curved = await evalCurved(rows);
    expect(curved.supportResults.low.windowComplete).toBe(false);
    expect(curved.decision).toBe('recommend_medium'); // never recommend_low
  });
});

describe('Lowest-Successful Test 18 — complete low with only 3/5 meeting target does not qualify', () => {
  it('3 of 5 falls below the 4-of-5 pilot bar and is skipped, even though the window itself is complete', async () => {
    const rows = [
      ...makeLevelAttempts('low', [82, 81, 80, 79, 78]), // complete, 3/5 meet 80 (78,79 miss)
      ...makeLevelAttempts('medium', [82, 83, 81, 79, 84]), // 4/5
    ];
    const curved = await evalCurved(rows);
    expect(curved.supportResults.low.windowComplete).toBe(true);
    expect(curved.supportResults.low.metTargetCount).toBe(3);
    expect(curved.decision).toBe('recommend_medium');
  });
});

// ─── Evidence provenance tests (19–23) ──────────────────────────────────────

describe('Provenance Test 19 — explicit-only → evidenceBasis explicit_only', () => {
  it('every contributing attempt has an explicit support_level', async () => {
    const rows = makeLevelAttempts('low', [82, 81, 80, 79, 84], { explicit: true });
    const curved = await evalCurved(rows);
    expect(curved.evidenceBasis).toBe('explicit_only');
    expect(curved.evidenceQuality).toEqual({ explicitCount: 5, historicalProxyCount: 0, containsHistoricalProxy: false });
  });
});

describe('Provenance Test 20 — proxy-only → historical_proxy_only', () => {
  it('every contributing attempt is historical-proxy sourced', async () => {
    const rows = makeLevelAttempts('low', [82, 81, 80, 79, 84], { explicit: false });
    const curved = await evalCurved(rows);
    expect(curved.evidenceBasis).toBe('historical_proxy_only');
    expect(curved.evidenceQuality).toEqual({ explicitCount: 0, historicalProxyCount: 5, containsHistoricalProxy: true });
  });
});

describe('Provenance Test 21 — mixed → mixed', () => {
  it('a family with both explicit and proxy attempts across its windows reports mixed', async () => {
    const rows = [
      ...makeLevelAttempts('low', [82, 81, 80, 79, 84], { explicit: true }),
      ...makeLevelAttempts('medium', [70, 71, 72, 73, 74], { explicit: false }),
    ];
    const curved = await evalCurved(rows);
    expect(curved.evidenceBasis).toBe('mixed');
    expect(curved.evidenceQuality.explicitCount).toBe(5);
    expect(curved.evidenceQuality.historicalProxyCount).toBe(5);
  });
});

describe('Provenance Test 22 — evidence counts are exactly correct', () => {
  it('tallies explicit/proxy counts across all three levels, not just the deciding one', async () => {
    const rows = [
      ...makeLevelAttempts('low', [90, 91], { explicit: true }),           // 2 explicit
      ...makeLevelAttempts('medium', [82, 83, 81, 79, 84], { explicit: false }), // 5 proxy
      ...makeLevelAttempts('high', [95], { explicit: true }),              // 1 explicit
    ];
    const curved = await evalCurved(rows);
    expect(curved.evidenceQuality).toEqual({ explicitCount: 3, historicalProxyCount: 5, containsHistoricalProxy: true });
  });
});

describe('Provenance Test 23 — provenance never alters the recommendation numerically', () => {
  it('identical scores produce the identical decision regardless of explicit vs proxy sourcing', async () => {
    const explicitRows = makeLevelAttempts('low', [82, 81, 80, 79, 84], { explicit: true });
    const proxyRows    = makeLevelAttempts('low', [82, 81, 80, 79, 84], { explicit: false });

    const explicitResult = await evalCurved(explicitRows);
    const proxyResult    = await evalCurved(proxyRows);

    expect(explicitResult.decision).toBe(proxyResult.decision);
    expect(explicitResult.recommendedSupport).toBe(proxyResult.recommendedSupport);
    expect(explicitResult.supportResults).toEqual(proxyResult.supportResults);
    // Only provenance-specific fields differ:
    expect(explicitResult.evidenceBasis).not.toBe(proxyResult.evidenceBasis);
  });
});

// ─── Pilot-rule documentation sanity ────────────────────────────────────────

describe('Pilot rule constant', () => {
  it('SUPPORT_SUCCESS_MET_COUNT is exactly 4, matching Feature 2\'s own 4-of-5 pattern', () => {
    expect(SUPPORT_SUCCESS_MET_COUNT).toBe(4);
  });
});

// ─── Input validation ───────────────────────────────────────────────────────

describe('Input validation', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 'abc', null, undefined])(
    'rejects invalid studentId %j',
    async (badId) => {
      const result = await evaluateSupportRecommendations({ studentId: badId });
      expect(result.status).toBe('invalid_input');
      expect(mockLaFindAll).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 1.5, NaN, Infinity, 'abc'])(
    'rejects invalid windowSize %j',
    async (badSize) => {
      const result = await evaluateSupportRecommendations({ studentId: 13, windowSize: badSize });
      expect(result.status).toBe('invalid_window_size');
      expect(mockLaFindAll).not.toHaveBeenCalled();
    }
  );

  it('propagates read_failed from the underlying performance query', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('down'));
    const result = await evaluateSupportRecommendations({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expect(result.families).toBeNull();
  });
});

// ─── Read-only guarantee (§41) ──────────────────────────────────────────────

describe('evaluateSupportRecommendations — read-only guarantee', () => {
  it('never calls create/bulkCreate/update/destroy/save on LetterAttempt, never on ThresholdHistory, never opens a transaction', async () => {
    const rows = [
      ...makeLevelAttempts('low', [82, 81, 80, 79, 84]),
      ...makeLevelAttempts('medium', [70, 71, 72, 73, 74], { explicit: true }),
      ...makeLevelAttempts('high', [60, 61, 62, 63, 64]),
    ];
    setupTargets({
      straight: makeThresholdRow({ scope_key: 'straight', baseline_family: 'straight', new_threshold: 67 }),
      curved: makeThresholdRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 80 }),
      complex: null,
    });

    await evalCurved(rows);

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

  it('the module source (excluding comments) never references bulkCreate/personal_thresholds/student_support_history', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/adaptiveSupportService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // NOTE: 'support_review' itself is NOT banned here — it is Step 5's OWN
    // decision vocabulary value (DECISION_SUPPORT_REVIEW, spec §18), a
    // completely different thing from Feature 2's ephemeral
    // dynamicThresholdStatus='support_review' response field. What must
    // never appear in real code is Feature 2's own support_review-producing
    // machinery being consumed — checked directly below.
    expect(codeOnly).not.toMatch(/bulkCreate|personal_thresholds|student_support_history/);
  });

  it('never reads Feature 2\'s ephemeral dynamicThresholdStatus or calls its orchestration/evaluation functions — Step 5 derives its own decision independently (spec §19)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/adaptiveSupportService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/dynamicThresholdStatus|processDynamicThresholdAfterLetterSession|evaluateDynamicThresholds/);
  });
});

'use strict';

// Verifies dynamicThresholdService in isolation. Mocks only ../src/models
// (StudentMotorBaseline's findOne/create/update/destroy, ThresholdHistory's
// findAll/bulkCreate/create/update/destroy, and sequelize.transaction) — the
// REAL motorBaselineService.getStudentMotorBaseline() is used unmocked,
// proving the actual composition this service relies on, not a stand-in.
const mockFindOne   = jest.fn(); // StudentMotorBaseline.findOne
const mockCreate    = jest.fn(); // StudentMotorBaseline.create
const mockUpdate    = jest.fn(); // StudentMotorBaseline.update
const mockDestroy   = jest.fn(); // StudentMotorBaseline.destroy

const mockThFindAll    = jest.fn(); // ThresholdHistory.findAll
const mockThFindOne    = jest.fn(); // ThresholdHistory.findOne — Feature 2 Step 5: getCurrentFamilyThreshold
const mockThBulkCreate = jest.fn(); // ThresholdHistory.bulkCreate
const mockThCreate     = jest.fn(); // ThresholdHistory.create — Feature 2 Step 6A: setTeacherFamilyThreshold's single append-only insert (unused/must-never-be-called by every OTHER function in this file — each such test scopes that assertion to its own call, not this whole suite)
const mockThUpdate     = jest.fn();
const mockThDestroy    = jest.fn();
const mockTransaction  = jest.fn(); // sequelize.transaction

// Feature 2 Step 4 — LetterAttempt mocks for getRecentFamilyPerformance().
// create/bulkCreate/update/destroy exist ONLY so the read-only-guarantee
// test can assert they are never called — the service under test never
// references them.
const mockLaFindAll    = jest.fn(); // LetterAttempt.findAll
const mockLaCount      = jest.fn(); // LetterAttempt.count
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();

// Feature 2 Step 6A — Student.findOne for setTeacherFamilyThreshold's
// ownership check. create/update/destroy exist only for negative assertions
// (a teacher override must never write/modify a Student row).
const mockStudentFindOne = jest.fn();
const mockStudentCreate  = jest.fn();
const mockStudentUpdate  = jest.fn();
const mockStudentDestroy = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingAssessment: { findByPk: jest.fn(), findOne: jest.fn() }, // unused by getStudentMotorBaseline, present for shape only
  StudentMotorBaseline:  { findOne: mockFindOne, create: mockCreate, update: mockUpdate, destroy: mockDestroy },
  ThresholdHistory:      { findAll: mockThFindAll, findOne: (...a) => mockThFindOne(...a), bulkCreate: mockThBulkCreate, create: (...a) => mockThCreate(...a), update: mockThUpdate, destroy: mockThDestroy },
  LetterAttempt:         { findAll: (...a) => mockLaFindAll(...a), count: (...a) => mockLaCount(...a), create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate, destroy: mockLaDestroy },
  Student:               { findOne: (...a) => mockStudentFindOne(...a), create: mockStudentCreate, update: mockStudentUpdate, destroy: mockStudentDestroy },
  sequelize:             { transaction: (...args) => mockTransaction(...args) },
}));

const { Op } = require('sequelize'); // real — only ../src/models is mocked above

const {
  deriveInitialFamilyThresholds, createInitialFamilyThresholds, classifyFamilyInitialization,
  getRecentFamilyPerformance, RECENT_FAMILY_WINDOW_SIZE,
  getCurrentFamilyThreshold, getCurrentFamilyThresholdsForStudent, evaluateDynamicThresholds, THRESHOLD_INCREASE_STEP,
  setTeacherFamilyThreshold, getFamilyThresholdProtection,
  computeEvidenceFingerprint, classifyAutomaticThresholdPersistence, persistAutomaticThresholdDecisions,
  processDynamicThresholdAfterLetterSession,
  INITIAL_THRESHOLD_MARGIN,
} = require('../src/services/dynamicThresholdService');
const { MAPPING_VERSION, getBaselineFamily } = require('../src/config/letterBaselineFamilies');

// sequelize.transaction(cb) in real Sequelize invokes cb with a transaction
// object and commits/rolls back around it. The default mock simply invokes
// the callback with a stub transaction object — success path. Individual
// tests override this with mockRejectedValueOnce to simulate a failure.
function defaultTransactionImpl(cb) {
  return cb({ /* stub transaction object */ });
}

function makeBaselineRow(overrides = {}) {
  return {
    id: 1, student_id: 13, source_assessment_id: 202,
    straight_score: 62, curved_score: 83, complex_score: 68, overall_motor_score: 55,
    baseline_version: 'baseline-v1', taxonomy_version: 'assessment-motor-v1',
    source_type: 'initial_assessment', is_backfilled: true, backfilled_at: new Date(),
    created_at: new Date('2026-08-07T17:32:47.847Z'),
    ...overrides,
  };
}

function makeHistoryRow(overrides = {}) {
  return {
    id: 1, student_id: 13, scope_type: 'family', scope_key: 'straight', baseline_family: 'straight',
    old_threshold: null, new_threshold: 67, source: 'initial_from_baseline', reason: 'baseline_plus_margin',
    baseline_id: 1, baseline_version: 'baseline-v1', mapping_version: 'letter-baseline-family-v1',
    recent_window_snapshot: null, created_at: new Date(),
    ...overrides,
  };
}

// Feature 2 Step 4 — LetterAttempt.findAll router. getRecentFamilyPerformance
// issues one findAll per family (straight/curved/complex), distinguished by
// the mapped (letter, case_type) pairs in each call's where[Op.or]. Routing
// by the REAL (unmocked) getBaselineFamily rather than hardcoding letters
// here keeps this test file correct even if the mapping config changes.
let familyRowsFixture;

function routeLaFindAll({ where }) {
  const pairs = where[Op.or];
  if (!pairs || pairs.length === 0) return Promise.resolve([]);
  // The real where-clause pairs use case_type (snake_case, the DB column
  // name — see buildFamilyLetterClause in dynamicThresholdService.js), not
  // caseType.
  const family = getBaselineFamily(pairs[0].letter, pairs[0].case_type);
  return Promise.resolve(familyRowsFixture?.[family] ?? []);
}

function makeAttemptRow(overrides = {}) {
  return {
    id: 1,
    student_id: 13,
    letter: 'o',
    case_type: 'lowercase',
    session_key: 'session-1',
    attempt_number: 3,
    collection_mode: false,
    capture_status: 'complete',
    features: { smoothness: 0.1, dtw_distance: 15, pauseCount: 0, strokeCount: 1, completionTime: 1000 },
    threshold_passed: true,
    created_at: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

// Feature 2 Step 5 — builds a `features` object whose reconstructed
// performanceScore is EXACTLY `score` (verified by round-trip check through
// the real deriveAttemptPerformanceScore before these tests were written —
// smoothness fixed at 0, dtw_distance solved from the inverse of the
// formula; exact for score >= 30, which covers every fixture used below).
function featuresForScore(score) {
  const dtw = (45 * (100 - score)) / 70;
  return { smoothness: 0, dtw_distance: dtw, pauseCount: 0, strokeCount: 1, completionTime: 1000 };
}

function makeScoredAttempts(scores, { letter = 'o', caseType = 'lowercase' } = {}) {
  return scores.map((score, i) => makeAttemptRow({
    id: 100 + i,
    letter, case_type: caseType,
    session_key: `session-${i}`,
    features: featuresForScore(score),
    created_at: new Date(2026, 0, 10 - i),
  }));
}

// Feature 2 Step 5 — ThresholdHistory.findOne router for
// getCurrentFamilyThreshold(). Value per family is either:
//   - undefined/null -> no target (findOne resolves null)
//   - a number        -> a full makeHistoryRow() with that new_threshold
//   - a full row object -> used as-is (for multi-event ordering tests)
let familyTargetsFixture;

// Feature 2 Step 6B — a SEPARATE fixture keyed by evidence_fingerprint,
// simulating "has this exact automatic evidence already been persisted?".
// Distinguished from the current-target lookup above purely by query
// shape: the evidence-idempotency query is the only ThresholdHistory.findOne
// caller that filters on `evidence_fingerprint` at all.
let evidenceFixture;

function routeThFindOne({ where }) {
  if (where.evidence_fingerprint !== undefined) {
    return Promise.resolve(evidenceFixture?.[where.evidence_fingerprint] ?? null);
  }
  const family = where.scope_key;
  const val = familyTargetsFixture?.[family];
  if (val == null) return Promise.resolve(null);
  if (typeof val === 'object') return Promise.resolve(val);
  return Promise.resolve(makeHistoryRow({ scope_key: family, baseline_family: family, new_threshold: val }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation(defaultTransactionImpl);

  familyRowsFixture = { straight: [], curved: [], complex: [] };
  mockLaFindAll.mockImplementation(routeLaFindAll);
  mockLaCount.mockResolvedValue(0); // default: no exclusions, tests override per-case

  familyTargetsFixture = { straight: null, curved: null, complex: null };
  evidenceFixture = {};
  mockThFindOne.mockImplementation(routeThFindOne);

  // Feature 2 Step 6A default: student IS owned by the calling teacher.
  // Tests exercising the "unowned/not found" path override with
  // mockResolvedValueOnce(null) before calling the service.
  mockStudentFindOne.mockResolvedValue({ sid: 13 });
});

// ─── Test 1 — Normal derivation ────────────────────────────────────────────

describe('Test 1 — normal derivation', () => {
  it('derives straight=67, curved=88, complex=73 from the known student 13 baseline shape', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());

    const result = await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(result.status).toBe('derived');
    expect(result.thresholds.straight).toEqual({ baselineScore: 62, margin: 5, rawTarget: 67, status: 'ready', reason: null });
    expect(result.thresholds.curved).toEqual({ baselineScore: 83, margin: 5, rawTarget: 88, status: 'ready', reason: null });
    expect(result.thresholds.complex).toEqual({ baselineScore: 68, margin: 5, rawTarget: 73, status: 'ready', reason: null });
  });

  it('defaults margin to INITIAL_THRESHOLD_MARGIN (5) when not supplied', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    const result = await deriveInitialFamilyThresholds({ studentId: 13 });
    expect(result.margin).toBe(INITIAL_THRESHOLD_MARGIN);
    expect(INITIAL_THRESHOLD_MARGIN).toBe(5);
  });
});

// ─── Test 2 — Baseline not found ───────────────────────────────────────────

describe('Test 2 — baseline not found', () => {
  it('reports baseline_not_found with no fallback', async () => {
    mockFindOne.mockResolvedValueOnce(null);

    const result = await deriveInitialFamilyThresholds({ studentId: 999 });

    expect(result.status).toBe('baseline_not_found');
    expect(result.thresholds).toBeNull();
    expect(result.baselineId).toBeNull();
  });
});

// ─── Test 3 — Custom valid margin ──────────────────────────────────────────

describe('Test 3 — custom valid margin', () => {
  it('margin=3 derives 65/86/71', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());

    const result = await deriveInitialFamilyThresholds({ studentId: 13, margin: 3 });

    expect(result.thresholds.straight.rawTarget).toBe(65);
    expect(result.thresholds.curved.rawTarget).toBe(86);
    expect(result.thresholds.complex.rawTarget).toBe(71);
  });
});

// ─── Test 4 — Negative margin ──────────────────────────────────────────────

describe('Test 4 — negative margin', () => {
  it('rejects without querying the baseline', async () => {
    const result = await deriveInitialFamilyThresholds({ studentId: 13, margin: -1 });
    expect(result.status).toBe('invalid_margin');
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

// ─── Test 5 — NaN/Infinite margin ──────────────────────────────────────────

describe('Test 5 — NaN/infinite margin', () => {
  it.each([NaN, Infinity, -Infinity])('rejects margin=%p', async (margin) => {
    const result = await deriveInitialFamilyThresholds({ studentId: 13, margin });
    expect(result.status).toBe('invalid_margin');
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

// ─── Test 6 — String margin ────────────────────────────────────────────────

describe('Test 6 — string margin', () => {
  it.each(['5', 'five', ''])('rejects margin=%p', async (margin) => {
    const result = await deriveInitialFamilyThresholds({ studentId: 13, margin });
    expect(result.status).toBe('invalid_margin');
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

// ─── Test 7 — Zero margin ───────────────────────────────────────────────────

describe('Test 7 — zero margin is allowed', () => {
  // Decision: margin=0 is a legitimate pilot configuration ("target =
  // baseline" — useful for comparison even though +5 is the real default),
  // so it is explicitly ALLOWED, not rejected.
  it('produces rawTarget === baselineScore for every family, status ready', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());

    const result = await deriveInitialFamilyThresholds({ studentId: 13, margin: 0 });

    expect(result.status).toBe('derived');
    expect(result.thresholds.straight).toEqual({ baselineScore: 62, margin: 0, rawTarget: 62, status: 'ready', reason: null });
    expect(result.thresholds.curved.rawTarget).toBe(83);
    expect(result.thresholds.complex.rawTarget).toBe(68);
  });
});

// ─── Test 8 — Target > 100 ──────────────────────────────────────────────────

describe('Test 8 — target exceeds 100', () => {
  it('baseline=98, margin=5 -> rawTarget=103, requires_review, no clamping', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ complex_score: 98 }));

    const result = await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(result.thresholds.complex).toEqual({
      baselineScore: 98, margin: 5, rawTarget: 103, status: 'requires_review', reason: 'target_exceeds_score_range',
    });
    // Other families are unaffected — independence, not an all-or-nothing failure.
    expect(result.thresholds.straight.status).toBe('ready');
    expect(result.status).toBe('derived'); // top-level status still 'derived' — per-family granularity
  });
});

// ─── Test 9 — Exactly 100 ───────────────────────────────────────────────────

describe('Test 9 — exactly 100', () => {
  it('baseline=95, margin=5 -> rawTarget=100, status ready (not requires_review)', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ straight_score: 95 }));

    const result = await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(result.thresholds.straight).toEqual({ baselineScore: 95, margin: 5, rawTarget: 100, status: 'ready', reason: null });
  });
});

// ─── Test 10 — Malformed baseline value ────────────────────────────────────

describe('Test 10 — baseline value malformed', () => {
  it.each([
    [null], ['seventy'], [-5], [150], [NaN], [Infinity],
  ])('curved_score=%p is a safe failure for that family only, no derivation', async (badValue) => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ curved_score: badValue }));

    const result = await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(result.thresholds.curved.status).toBe('invalid_baseline_score');
    expect(result.thresholds.curved.rawTarget).toBeNull();
    // Sibling families remain independently derivable.
    expect(result.thresholds.straight.status).toBe('ready');
    expect(result.thresholds.complex.status).toBe('ready');
  });
});

// ─── Test 11 — Baseline immutability ───────────────────────────────────────

describe('Test 11 — baseline immutability', () => {
  it('performs no create/update/destroy on StudentMotorBaseline, only a read', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());

    await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    // ThresholdHistory is not even imported by dynamicThresholdService.js —
    // there is nothing capable of writing threshold history in this module.
  });
});

// ─── Test 12 — Mapping version propagated ──────────────────────────────────

describe('Test 12 — mapping version propagated', () => {
  it('result.mappingVersion equals the real, imported MAPPING_VERSION', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    const result = await deriveInitialFamilyThresholds({ studentId: 13 });
    expect(result.mappingVersion).toBe('letter-baseline-family-v1');
    expect(result.mappingVersion).toBe(MAPPING_VERSION); // never a duplicated literal
  });

  it('is also present when the baseline is not found', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    const result = await deriveInitialFamilyThresholds({ studentId: 13 });
    expect(result.mappingVersion).toBe(MAPPING_VERSION);
  });
});

// ─── Test 13 — Actual baseline version propagated ──────────────────────────

describe('Test 13 — actual baseline version propagated', () => {
  it('returns the real stored baseline_version, not a hardcoded literal', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ baseline_version: 'baseline-v2' }));

    const result = await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(result.baselineVersion).toBe('baseline-v2');
    expect(result.baselineVersion).not.toBe('baseline-v1');
  });
});

// ─── Bonus — read_failed is distinct from baseline_not_found ──────────────

describe('read_failed is reported distinctly, never hidden as baseline_not_found', () => {
  it('an unexpected DB error surfaces as read_failed', async () => {
    mockFindOne.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await deriveInitialFamilyThresholds({ studentId: 13 });

    expect(result.status).toBe('read_failed');
    expect(result.thresholds).toBeNull();
  });
});

// ─── Bonus — invalid studentId ─────────────────────────────────────────────

describe('invalid studentId is rejected before any DB access', () => {
  it.each([null, undefined, 0, -1, 'abc', NaN])('rejects studentId=%p', async (studentId) => {
    const result = await deriveInitialFamilyThresholds({ studentId });
    expect(result.status).toBe('invalid_input');
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// createInitialFamilyThresholds() — Step 3 persistence
// ═════════════════════════════════════════════════════════════════════════

// Echoes each row back with a synthetic id — matches real Sequelize
// bulkCreate's behavior of returning instances in input order.
function echoBulkCreate() {
  return async (rows) => rows.map((r, i) => ({ id: i + 1, ...r }));
}

// Feature 2 Step 6A — same idea for the single-row ThresholdHistory.create()
// used by setTeacherFamilyThreshold.
function echoCreate(id = 4) {
  return async (row) => ({ id, ...row });
}

// ─── Persistence Test 1 — 3-family creation ────────────────────────────────

describe('Persistence Test 1 — 3-family creation', () => {
  it('creates 3 history rows for a fully valid baseline', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.status).toBe('created');
    expect(result.created.straight).toMatchObject({ status: 'created', newThreshold: 67 });
    expect(result.created.curved).toMatchObject({ status: 'created', newThreshold: 88 });
    expect(result.created.complex).toMatchObject({ status: 'created', newThreshold: 73 });
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockThBulkCreate.mock.calls[0][0]).toHaveLength(3);
  });
});

// ─── Persistence Test 2 — exact row metadata ───────────────────────────────

describe('Persistence Test 2 — exact row metadata', () => {
  it('each inserted row has the correct source/reason/baseline/mapping fields', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await createInitialFamilyThresholds({ studentId: 13 });

    const insertedRows = mockThBulkCreate.mock.calls[0][0];
    const straightRow = insertedRows.find(r => r.scope_key === 'straight');
    expect(straightRow).toMatchObject({
      student_id: 13, scope_type: 'family', scope_key: 'straight', baseline_family: 'straight',
      old_threshold: null, new_threshold: 67,
      source: 'initial_from_baseline', reason: 'baseline_plus_margin',
      baseline_id: 1, baseline_version: 'baseline-v1', mapping_version: 'letter-baseline-family-v1',
      recent_window_snapshot: null,
    });
    expect(straightRow).not.toHaveProperty('created_at'); // DB/model default, never set here
  });
});

// ─── Persistence Test 3 — idempotent second call ───────────────────────────

describe('Persistence Test 3 — idempotent second call', () => {
  it('reports already_initialized with no duplicate inserts', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([
      makeHistoryRow({ id: 1, scope_key: 'straight', new_threshold: 67 }),
      makeHistoryRow({ id: 2, scope_key: 'curved',   new_threshold: 88 }),
      makeHistoryRow({ id: 3, scope_key: 'complex',  new_threshold: 73 }),
    ]);

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.status).toBe('already_initialized');
    expect(result.created.straight).toEqual({ status: 'already_initialized', historyId: 1, newThreshold: 67 });
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

// ─── Persistence Test 4 — different margin after initialization ───────────

describe('Persistence Test 4 — different margin after initialization', () => {
  it('does not reinitialize — reports already_initialized with the ORIGINAL stored values', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([
      makeHistoryRow({ id: 1, scope_key: 'straight', new_threshold: 67 }), // from the original margin=5 call
      makeHistoryRow({ id: 2, scope_key: 'curved',   new_threshold: 88 }),
      makeHistoryRow({ id: 3, scope_key: 'complex',  new_threshold: 73 }),
    ]);

    const result = await createInitialFamilyThresholds({ studentId: 13, margin: 3 }); // different margin

    expect(result.status).toBe('already_initialized');
    // Values are the ORIGINAL 67/88/73, not what margin=3 would compute (65/86/71).
    expect(result.created.straight.newThreshold).toBe(67);
    expect(result.created.curved.newThreshold).toBe(88);
    expect(result.created.complex.newThreshold).toBe(73);
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

// ─── Persistence Test 5 — missing baseline ─────────────────────────────────

describe('Persistence Test 5 — missing baseline', () => {
  it('reports baseline_not_found, zero writes attempted', async () => {
    mockFindOne.mockResolvedValueOnce(null);

    const result = await createInitialFamilyThresholds({ studentId: 999 });

    expect(result.status).toBe('baseline_not_found');
    expect(result.created).toBeNull();
    expect(mockThFindAll).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

// ─── Persistence Test 6 — requires_review family skipped ──────────────────

describe('Persistence Test 6 — requires_review family skipped', () => {
  it('a family with rawTarget>100 is skipped, never persisted', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ complex_score: 98 }));
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.created.complex).toEqual({ status: 'skipped_requires_review', reason: 'target_exceeds_score_range' });
    const insertedKeys = mockThBulkCreate.mock.calls[0][0].map(r => r.scope_key);
    expect(insertedKeys).not.toContain('complex');
  });
});

// ─── Persistence Test 7 — other valid families still created ──────────────

describe('Persistence Test 7 — other valid families still created', () => {
  it('straight/curved are still created even though complex requires review', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ complex_score: 98 }));
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.created.straight.status).toBe('created');
    expect(result.created.curved.status).toBe('created');
    expect(result.status).toBe('created'); // top-level reflects "at least one created"
  });
});

// ─── Persistence Test 8 — invalid baseline family skipped ─────────────────

describe('Persistence Test 8 — invalid baseline family skipped', () => {
  it('a malformed family score is skipped safely; sibling families unaffected', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ curved_score: null }));
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.created.curved).toEqual({ status: 'skipped_invalid_baseline', reason: 'baseline_score_invalid' });
    expect(result.created.straight.status).toBe('created');
    expect(result.created.complex.status).toBe('created');
  });
});

// ─── Persistence Test 9 — transaction failure ──────────────────────────────

describe('Persistence Test 9 — transaction failure leaves no partial commit', () => {
  it('when the transaction rejects, no family is reported as created', async () => {
    // True atomicity (all-or-nothing) is a Postgres/Sequelize transaction
    // guarantee, not something a mocked unit test can verify directly. What
    // this DOES verify is this service's own behavior when
    // sequelize.transaction(...) rejects: it must never report a family as
    // 'created' that wasn't actually committed.
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);
    mockTransaction.mockRejectedValueOnce(new Error('connection terminated mid-transaction'));

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(Object.values(result.created).some(c => c.status === 'created')).toBe(false);
    expect(result.created.straight.status).toBe('save_failed');
    expect(result.created.curved.status).toBe('save_failed');
    expect(result.created.complex.status).toBe('save_failed');
    expect(result.status).toBe('save_failed');
  });
});

// ─── Persistence Test 10 — race condition ──────────────────────────────────

describe('Persistence Test 10 — race/unique violation resolved to already_initialized', () => {
  it('a SequelizeUniqueConstraintError during insert never throws/rejects the outer call', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll
      .mockResolvedValueOnce([]) // initial check: nothing exists yet
      .mockResolvedValueOnce([   // re-check after the race: another call won
        makeHistoryRow({ id: 1, scope_key: 'straight', new_threshold: 67 }),
        makeHistoryRow({ id: 2, scope_key: 'curved',   new_threshold: 88 }),
        makeHistoryRow({ id: 3, scope_key: 'complex',  new_threshold: 73 }),
      ]);
    const uniqueErr = new Error('duplicate key value violates unique constraint');
    uniqueErr.name = 'SequelizeUniqueConstraintError';
    mockTransaction.mockRejectedValueOnce(uniqueErr);

    await expect(createInitialFamilyThresholds({ studentId: 13 })).resolves.toBeDefined();
  });

  it('resolves each raced family to already_initialized with the winning values', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeHistoryRow({ id: 1, scope_key: 'straight', new_threshold: 67 }),
        makeHistoryRow({ id: 2, scope_key: 'curved',   new_threshold: 88 }),
        makeHistoryRow({ id: 3, scope_key: 'complex',  new_threshold: 73 }),
      ]);
    const uniqueErr = new Error('duplicate key value violates unique constraint');
    uniqueErr.name = 'SequelizeUniqueConstraintError';
    mockTransaction.mockRejectedValueOnce(uniqueErr);

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.created.straight).toEqual({ status: 'already_initialized', historyId: 1, newThreshold: 67 });
    expect(result.status).toBe('already_initialized');
  });
});

// ─── Persistence Test 11 — personal_thresholds never touched ──────────────

describe('Persistence Test 11 — personal_thresholds never touched', () => {
  it('the service code (excluding documentation comments) never references personal_thresholds', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/dynamicThresholdService.js'), 'utf8');

    // The module's own header comments deliberately DOCUMENT the
    // personal_thresholds guarantee in prose — strip comments first so only
    // real code is checked here, not that documentation.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(codeOnly).not.toMatch(/personal_thresholds/);
    // NOTE (Feature 2 Step 6A): Student IS now legitimately imported —
    // setTeacherFamilyThreshold() needs Student.findOne for the ownership
    // check (the same pattern teacherService.js's own functions each
    // already repeat inline). The earlier, stronger "Student is never even
    // imported" assertion this test used to make is intentionally retired;
    // the real guarantee — Student.update/create/destroy are never called by
    // this module — is covered by the Step 6A "no writes" tests below
    // (Section 29 Tests 19-20), which assert on the mocked call list
    // directly rather than grepping source text.
  });
});

// ─── Persistence Test 12 — baseline never updated ──────────────────────────

describe('Persistence Test 12 — baseline never updated', () => {
  it('StudentMotorBaseline.create/update/destroy are never called — read-only', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await createInitialFamilyThresholds({ studentId: 13 });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });
});

// ─── Persistence Test 13 — ThresholdHistory is the only write target ──────

describe('Persistence Test 13 — ThresholdHistory is the only write target', () => {
  it('only bulkCreate is used to write; ThresholdHistory.create/update/destroy are unused', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await createInitialFamilyThresholds({ studentId: 13 });

    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
    expect(mockThDestroy).not.toHaveBeenCalled();
  });
});

// ─── Persistence Test 14 — mappingVersion exact ────────────────────────────

describe('Persistence Test 14 — mappingVersion exact', () => {
  it('result.mappingVersion equals the real MAPPING_VERSION', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.mappingVersion).toBe(MAPPING_VERSION);
    expect(result.mappingVersion).toBe('letter-baseline-family-v1');
  });
});

// ─── Persistence Test 15 — actual baselineVersion propagated ──────────────

describe('Persistence Test 15 — actual baselineVersion propagated', () => {
  it('uses the real stored baseline_version (e.g. baseline-v2), not a hardcoded literal', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ baseline_version: 'baseline-v2' }));
    mockThFindAll.mockResolvedValueOnce([]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await createInitialFamilyThresholds({ studentId: 13 });

    expect(result.baselineVersion).toBe('baseline-v2');
    const insertedRows = mockThBulkCreate.mock.calls[0][0];
    expect(insertedRows.every(r => r.baseline_version === 'baseline-v2')).toBe(true);
  });
});

// ─── Bonus — classifyFamilyInitialization is read-only (dry-run safety) ───

describe('classifyFamilyInitialization — read-only guarantee for dry-run', () => {
  it('never calls any write method, regardless of outcome', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([]);

    const { classification } = await classifyFamilyInitialization({ studentId: 13 });

    expect(classification.straight.action).toBe('would_create');
    expect(classification.curved.action).toBe('would_create');
    expect(classification.complex.action).toBe('would_create');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('classifies an already-initialized family correctly for dry-run reporting', async () => {
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    mockThFindAll.mockResolvedValueOnce([makeHistoryRow({ scope_key: 'straight', new_threshold: 67 })]);

    const { classification } = await classifyFamilyInitialization({ studentId: 13 });

    expect(classification.straight).toEqual({ action: 'already_initialized', historyId: 1, newThreshold: 67 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// getRecentFamilyPerformance() — Step 4 read-only recent independent window
// ═════════════════════════════════════════════════════════════════════════

// ─── Test 7-17 — valid-attempt filter ──────────────────────────────────────

describe('Test 7 — attempt_number=3, mapped letter -> included in the correct family window', () => {
  it('a valid straight-family attempt-3 row appears in the straight window', async () => {
    familyRowsFixture.straight = [makeAttemptRow({ id: 10, letter: 'l', case_type: 'lowercase', session_key: 's1' })];

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.status).toBe('found');
    expect(result.families.straight.count).toBe(1);
    expect(result.families.straight.attempts[0]).toMatchObject({ attemptId: 10, letter: 'l', family: 'straight', performanceScore: 74 });
  });
});

describe('Test 8/9 — attempt_number 1/2 are excluded at the query level, never counted', () => {
  it('the findAll where clause filters attempt_number to exactly 3 for every family', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    expect(mockLaFindAll).toHaveBeenCalledTimes(3); // straight, curved, complex
    for (const call of mockLaFindAll.mock.calls) {
      expect(call[0].where.attempt_number).toBe(3);
    }
  });
});

describe('Test 10 — collection_mode=true is excluded at the query level', () => {
  it('the findAll where clause filters collection_mode to exactly false for every family', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    for (const call of mockLaFindAll.mock.calls) {
      expect(call[0].where.collection_mode).toBe(false);
    }
  });
});

describe('Test 11/12/13 — capture_status must be exactly "complete"; incomplete/abandoned/network_failed excluded at the query level', () => {
  it('the findAll where clause filters capture_status to exactly "complete" for every family', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    for (const call of mockLaFindAll.mock.calls) {
      expect(call[0].where.capture_status).toBe('complete');
    }
  });

  // The live table currently contains ONLY capture_status='complete' rows
  // (confirmed in the Step 4 live data audit), so this is proven at the
  // query-construction level rather than via a live incomplete/abandoned/
  // network_failed fixture row — the WHERE clause itself is what guarantees
  // exclusion regardless of what capture_status values exist in the future.
});

describe('Test 14 — a failed-but-complete attempt is STILL included (not filtered on passed/threshold_passed)', () => {
  it('threshold_passed=false does not exclude an otherwise-valid attempt', async () => {
    familyRowsFixture.curved = [makeAttemptRow({ id: 20, letter: 'o', threshold_passed: false, session_key: 's2' })];

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.families.curved.count).toBe(1);
    expect(result.families.curved.attempts[0].thresholdPassed).toBe(false);
  });

  it('the where clause never references passed/threshold_passed at all', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });
    for (const call of mockLaFindAll.mock.calls) {
      expect(call[0].where).not.toHaveProperty('passed');
      expect(call[0].where).not.toHaveProperty('threshold_passed');
    }
  });
});

describe('Test 15 — ambiguous letters never appear in any family query', () => {
  it('none of the three findAll where[Op.or] clauses reference a known-ambiguous letter (e.g. "a", "k")', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    const allQueriedLetters = mockLaFindAll.mock.calls.flatMap(call => call[0].where[Op.or].map(p => p.letter));
    expect(allQueriedLetters).not.toContain('a');
    expect(allQueriedLetters).not.toContain('k');
    expect(allQueriedLetters).not.toContain('A');
  });
});

describe('Test 16 — lowercase/uppercase independence: y (complex, reviewed) vs Y (ambiguous)', () => {
  it('the complex-family query includes lowercase y but never uppercase Y', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    const complexCall = mockLaFindAll.mock.calls.find(call =>
      getBaselineFamily(call[0].where[Op.or][0].letter, call[0].where[Op.or][0].case_type) === 'complex'
    );
    const complexLetters = complexCall[0].where[Op.or];
    expect(complexLetters).toContainEqual({ letter: 'y', case_type: 'lowercase' });
    expect(complexLetters).not.toContainEqual({ letter: 'Y', case_type: 'uppercase' });
  });
});

describe('Test 17 — s/S and u/U are queried under complex, never under curved (not the frontend teaching taxonomy)', () => {
  it('the curved-family query never includes s/S/u/U', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    const curvedCall = mockLaFindAll.mock.calls.find(call =>
      getBaselineFamily(call[0].where[Op.or][0].letter, call[0].where[Op.or][0].case_type) === 'curved'
    );
    const curvedLetters = curvedCall[0].where[Op.or].map(p => p.letter);
    expect(curvedLetters).not.toEqual(expect.arrayContaining(['s', 'S', 'u', 'U']));
  });
});

// ─── Test 18-28 — family windows ───────────────────────────────────────────

describe('Test 18 — exactly 5 valid candidates -> windowComplete=true', () => {
  it('count=5, windowComplete=true', async () => {
    familyRowsFixture.straight = Array.from({ length: 5 }, (_, i) =>
      makeAttemptRow({ id: 100 + i, letter: 'l', session_key: `s${i}`, created_at: new Date(2026, 0, 10 - i) }));

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.families.straight.count).toBe(5);
    expect(result.families.straight.windowComplete).toBe(true);
  });
});

describe('Test 19 — fewer than 5 candidates -> windowComplete=false', () => {
  it('count=2, windowComplete=false', async () => {
    familyRowsFixture.curved = [
      makeAttemptRow({ id: 1, letter: 'o', session_key: 's1' }),
      makeAttemptRow({ id: 2, letter: 'c', session_key: 's2' }),
    ];

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.families.curved.count).toBe(2);
    expect(result.families.curved.windowComplete).toBe(false);
  });
});

describe('Test 20 — more than 5 candidates -> truncated to the newest 5', () => {
  it('7 candidates (already DESC-ordered) yield only the first 5', async () => {
    familyRowsFixture.complex = Array.from({ length: 7 }, (_, i) =>
      makeAttemptRow({ id: 200 + i, letter: 'v', session_key: `s${i}`, created_at: new Date(2026, 0, 20 - i) }));

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.families.complex.count).toBe(5);
    expect(result.families.complex.windowComplete).toBe(true);
    expect(result.families.complex.attempts.map(a => a.attemptId)).toEqual([200, 201, 202, 203, 204]);
  });
});

describe('Test 21 — ordering is delegated to the DB query (created_at DESC, id DESC)', () => {
  it('every family findAll call requests order: [[created_at, DESC], [id, DESC]]', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    for (const call of mockLaFindAll.mock.calls) {
      expect(call[0].order).toEqual([['created_at', 'DESC'], ['id', 'DESC']]);
    }
  });
});

describe('Test 22 — family isolation: one family\'s data/count never affects another\'s', () => {
  it('a full straight window and an empty curved window coexist correctly', async () => {
    familyRowsFixture.straight = Array.from({ length: 5 }, (_, i) =>
      makeAttemptRow({ id: 300 + i, letter: 'l', session_key: `s${i}` }));
    familyRowsFixture.curved = [];
    familyRowsFixture.complex = [makeAttemptRow({ id: 400, letter: 'v', session_key: 'sX' })];

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.families.straight.count).toBe(5);
    expect(result.families.curved.count).toBe(0);
    expect(result.families.complex.count).toBe(1);
  });
});

describe('Test 23 — exclusion filters are structural (query-level), so excluded rows can never consume window capacity', () => {
  it('the where clause combines attempt_number/collection_mode/capture_status/letter-mapping in one query, not post-filtered in memory', async () => {
    await getRecentFamilyPerformance({ studentId: 13 });

    for (const call of mockLaFindAll.mock.calls) {
      expect(call[0].where).toMatchObject({ attempt_number: 3, collection_mode: false, capture_status: 'complete' });
      expect(call[0].where[Op.or].length).toBeGreaterThan(0);
    }
  });
});

describe('Test 24 — duplicate session_key rows are deduped, not double-counted', () => {
  it('two rows sharing a session_key count as one attempt; the newer (first-seen) one wins', async () => {
    familyRowsFixture.curved = [
      makeAttemptRow({ id: 51, letter: 'o', session_key: 'dup-session', created_at: new Date('2026-08-05T10:00:01Z') }),
      makeAttemptRow({ id: 50, letter: 'o', session_key: 'dup-session', created_at: new Date('2026-08-05T10:00:00Z') }),
    ];

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.families.curved.count).toBe(1);
    expect(result.families.curved.attempts[0].attemptId).toBe(51); // first in DESC order wins
    expect(result.exclusions.duplicateSession).toBe(1);
  });

  it('live-verified pattern: 4 identical attempt_number=3 rows in one session collapse to 1', async () => {
    // Mirrors the real live finding on student 10 / letter O (uppercase) —
    // see Step 4 report Section 6 — where a single bulkCreate() call
    // produced FOUR byte-identical attempt_number=3 rows sharing one
    // session_key.
    familyRowsFixture.curved = [
      makeAttemptRow({ id: 121, letter: 'O', case_type: 'uppercase', session_key: 'dup-4x' }),
      makeAttemptRow({ id: 120, letter: 'O', case_type: 'uppercase', session_key: 'dup-4x' }),
      makeAttemptRow({ id: 119, letter: 'O', case_type: 'uppercase', session_key: 'dup-4x' }),
      makeAttemptRow({ id: 118, letter: 'O', case_type: 'uppercase', session_key: 'dup-4x' }),
    ];

    const result = await getRecentFamilyPerformance({ studentId: 10 });

    expect(result.families.curved.count).toBe(1);
    expect(result.exclusions.duplicateSession).toBe(3);
  });
});

describe('Test 25 — an entirely empty window is a normal result, not an error', () => {
  it('all three families empty -> status "found", not "read_failed"', async () => {
    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.status).toBe('found');
    expect(result.families.straight).toEqual({ count: 0, windowComplete: false, attempts: [] });
    expect(result.families.curved).toEqual({ count: 0, windowComplete: false, attempts: [] });
    expect(result.families.complex).toEqual({ count: 0, windowComplete: false, attempts: [] });
  });
});

describe('Test 26 — invalid studentId is rejected before any DB query', () => {
  it.each([null, undefined, 0, -1, 'abc', NaN, 1.5])('rejects studentId=%p', async (studentId) => {
    const result = await getRecentFamilyPerformance({ studentId });
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockLaCount).not.toHaveBeenCalled();
  });
});

describe('Test 27 — invalid windowSize is rejected before any DB query', () => {
  it.each([0, -1, 1.5, 'five', NaN, null])('rejects windowSize=%p', async (windowSize) => {
    const result = await getRecentFamilyPerformance({ studentId: 13, windowSize });
    expect(result.status).toBe('invalid_window_size');
    expect(mockLaFindAll).not.toHaveBeenCalled();
  });

  it('undefined windowSize falls back to the RECENT_FAMILY_WINDOW_SIZE default rather than being rejected', async () => {
    const result = await getRecentFamilyPerformance({ studentId: 13, windowSize: undefined });
    expect(result.status).toBe('found');
    expect(result.windowSize).toBe(RECENT_FAMILY_WINDOW_SIZE);
    expect(RECENT_FAMILY_WINDOW_SIZE).toBe(5);
  });
});

describe('Test 28 — custom windowSize is honored end-to-end', () => {
  it('windowSize=3 completes the window at 3 candidates, not 5', async () => {
    familyRowsFixture.straight = [
      makeAttemptRow({ id: 1, letter: 'l', session_key: 's1' }),
      makeAttemptRow({ id: 2, letter: 'l', session_key: 's2' }),
      makeAttemptRow({ id: 3, letter: 'l', session_key: 's3' }),
      makeAttemptRow({ id: 4, letter: 'l', session_key: 's4' }), // never reached — window already full
    ];

    const result = await getRecentFamilyPerformance({ studentId: 13, windowSize: 3 });

    expect(result.families.straight.count).toBe(3);
    expect(result.families.straight.windowComplete).toBe(true);
    expect(result.families.straight.attempts.map(a => a.attemptId)).toEqual([1, 2, 3]);
  });

  it('a malformed row mid-list is skipped and counted, without shrinking the eventual window below capacity', async () => {
    familyRowsFixture.curved = [
      makeAttemptRow({ id: 1, letter: 'o', session_key: 's1' }),
      makeAttemptRow({ id: 2, letter: 'o', session_key: 's2', features: { smoothness: 'bad', dtw_distance: 10 } }),
      makeAttemptRow({ id: 3, letter: 'o', session_key: 's3' }),
    ];

    const result = await getRecentFamilyPerformance({ studentId: 13, windowSize: 2 });

    expect(result.families.curved.count).toBe(2);
    expect(result.families.curved.attempts.map(a => a.attemptId)).toEqual([1, 3]);
    expect(result.exclusions.malformedFeatures).toBe(1);
  });
});

// ─── Exclusion-count accounting (student-wide, family-independent) ────────

describe('Exclusion counts — global, family-independent stats', () => {
  it('collectionMode/nonThirdAttempt/invalidCaptureStatus/unmappedLetter are read via dedicated count() queries', async () => {
    // Promise.all evaluates its array elements synchronously left-to-right,
    // so the 5 LetterAttempt.count() invocations happen in this exact,
    // deterministic order: collectionMode, nonThirdAttempt,
    // invalidCaptureStatus, then countUnmappedLetterAttempts's own two
    // sequential counts (totalCandidates, mappedCandidates).
    mockLaCount
      .mockResolvedValueOnce(3)  // collectionMode
      .mockResolvedValueOnce(7)  // nonThirdAttempt
      .mockResolvedValueOnce(1)  // invalidCaptureStatus
      .mockResolvedValueOnce(20) // totalCandidates (inside countUnmappedLetterAttempts)
      .mockResolvedValueOnce(15); // mappedCandidates

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.exclusions.collectionMode).toBe(3);
    expect(result.exclusions.nonThirdAttempt).toBe(7);
    expect(result.exclusions.invalidCaptureStatus).toBe(1);
    expect(result.exclusions.unmappedLetter).toBe(5); // 20 - 15
  });

  it('a count-query failure degrades exclusions to null rather than failing the whole read', async () => {
    mockLaCount.mockRejectedValue(new Error('connection terminated'));

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.status).toBe('found'); // windows already computed successfully
    expect(result.exclusions.collectionMode).toBeNull();
    expect(result.exclusions.unmappedLetter).toBeNull();
  });
});

// ─── read_failed on window-query failure ───────────────────────────────────

describe('getRecentFamilyPerformance — read_failed on a genuine query error', () => {
  it('a findAll rejection surfaces as read_failed, not a thrown error', async () => {
    mockLaFindAll.mockRejectedValue(new Error('connection terminated'));

    const result = await getRecentFamilyPerformance({ studentId: 13 });

    expect(result.status).toBe('read_failed');
    expect(result.families).toBeNull();
  });
});

// ─── Read-only guarantee ────────────────────────────────────────────────────

describe('getRecentFamilyPerformance — read-only guarantee', () => {
  it('never calls create/bulkCreate/update/destroy on LetterAttempt or ThresholdHistory, and never opens a transaction', async () => {
    familyRowsFixture.straight = [makeAttemptRow({ id: 1, letter: 'l', session_key: 's1' })];
    familyRowsFixture.curved   = [makeAttemptRow({ id: 2, letter: 'o', session_key: 's2', threshold_passed: false })];
    familyRowsFixture.complex  = [makeAttemptRow({ id: 3, letter: 'v', session_key: 's3', features: { smoothness: 'bad', dtw_distance: 10 } })];

    await getRecentFamilyPerformance({ studentId: 13 });

    expect(mockLaCreate).not.toHaveBeenCalled();
    expect(mockLaBulkCreate).not.toHaveBeenCalled();
    expect(mockLaUpdate).not.toHaveBeenCalled();
    expect(mockLaDestroy).not.toHaveBeenCalled();
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
    expect(mockThDestroy).not.toHaveBeenCalled();
    expect(mockThFindAll).not.toHaveBeenCalled(); // this service never even reads ThresholdHistory
    expect(mockCreate).not.toHaveBeenCalled();    // StudentMotorBaseline
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('the module source (excluding comments) never references personal_thresholds', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/dynamicThresholdService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/personal_thresholds/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Feature 2 Step 5 — getCurrentFamilyThreshold() / evaluateDynamicThresholds()
// ═════════════════════════════════════════════════════════════════════════

// ─── Section 31 — current-target lookup (8 tests) ──────────────────────────

describe('getCurrentFamilyThreshold — Section 31', () => {
  it('Test 1: only an initial_from_baseline event -> that value is used', async () => {
    mockThFindOne.mockResolvedValueOnce(makeHistoryRow({ scope_key: 'straight', baseline_family: 'straight', source: 'initial_from_baseline', new_threshold: 67 }));

    const result = await getCurrentFamilyThreshold({ studentId: 13, family: 'straight' });

    expect(result.status).toBe('found');
    expect(result.currentThreshold).toBe(67);
    expect(result.sourceEvent.source).toBe('initial_from_baseline');
  });

  it('Test 2: initial + automatic -> the latest automatic event is used (mock returns the newest row directly, mirroring ORDER BY)', async () => {
    // findOne with ORDER BY created_at DESC, id DESC always returns the
    // single newest matching row — the mock returns that row directly,
    // proving the SERVICE asks for the right thing (see Test 4 below for the
    // explicit ORDER BY assertion).
    mockThFindOne.mockResolvedValueOnce(makeHistoryRow({ id: 5, scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93, reason: 'four_or_five_met_target' }));

    const result = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });

    expect(result.currentThreshold).toBe(93);
    expect(result.sourceEvent.source).toBe('automatic');
  });

  it('Test 3: initial + automatic + teacher_override -> the latest teacher_override event is used, even though it is numerically LOWER', async () => {
    mockThFindOne.mockResolvedValueOnce(makeHistoryRow({ id: 9, scope_key: 'curved', baseline_family: 'curved', source: 'teacher_override', new_threshold: 70 }));

    const result = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });

    // Proves "current = latest event", never "current = maximum value" —
    // 70 < 93 (the prior automatic value) but is still correctly current.
    expect(result.currentThreshold).toBe(70);
    expect(result.sourceEvent.source).toBe('teacher_override');
  });

  it('Test 4: queries ORDER BY created_at DESC, id DESC and filters to valid target sources only', async () => {
    mockThFindOne.mockResolvedValueOnce(makeHistoryRow());

    await getCurrentFamilyThreshold({ studentId: 13, family: 'straight' });

    expect(mockThFindOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        student_id: 13, scope_type: 'family', scope_key: 'straight', baseline_family: 'straight',
        source: { [Op.in]: ['initial_from_baseline', 'automatic', 'teacher_override'] },
      }),
      order: [['created_at', 'DESC'], ['id', 'DESC']],
    }));
  });

  it('Test 5: no event at all -> status no_target, currentThreshold null', async () => {
    mockThFindOne.mockResolvedValueOnce(null);

    const result = await getCurrentFamilyThreshold({ studentId: 13, family: 'complex' });

    expect(result.status).toBe('no_target');
    expect(result.currentThreshold).toBeNull();
  });

  it('Test 6: an irrelevant letter-scoped history row is ignored (query never matches scope_type=letter)', async () => {
    await getCurrentFamilyThreshold({ studentId: 13, family: 'straight' });
    const where = mockThFindOne.mock.calls[0][0].where;
    expect(where.scope_type).toBe('family');
    // A letter-scoped row (scope_type='letter') could never satisfy this
    // where clause — proven structurally, not by trusting a fixture.
  });

  it('Test 7: an irrelevant family is ignored — the query is scoped to exactly one family at a time', async () => {
    await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });
    const where = mockThFindOne.mock.calls[0][0].where;
    expect(where.scope_key).toBe('curved');
    expect(where.baseline_family).toBe('curved');
  });

  it('Test 8: an unsupported source (legacy) is excluded from the valid-source list', async () => {
    await getCurrentFamilyThreshold({ studentId: 13, family: 'straight' });
    const where = mockThFindOne.mock.calls[0][0].where;
    expect(where.source[Op.in]).not.toContain('legacy');
    expect(where.source[Op.in]).toEqual(['initial_from_baseline', 'automatic', 'teacher_override']);
  });

  it('invalid studentId is rejected before any query', async () => {
    const result = await getCurrentFamilyThreshold({ studentId: -1, family: 'straight' });
    expect(result.status).toBe('invalid_input');
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  it('invalid family is rejected before any query', async () => {
    const result = await getCurrentFamilyThreshold({ studentId: 13, family: 'mixed' });
    expect(result.status).toBe('invalid_family');
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  it('a DB error surfaces as read_failed, never silently treated as no_target', async () => {
    mockThFindOne.mockRejectedValueOnce(new Error('connection terminated'));
    const result = await getCurrentFamilyThreshold({ studentId: 13, family: 'straight' });
    expect(result.status).toBe('read_failed');
  });
});

// ─── Teacher Dashboard integration fix — getCurrentFamilyThresholdsForStudent ─
//
// Reuses this file's existing getCurrentFamilyThreshold mocks (mockThFindOne)
// and createInitialFamilyThresholds mocks (mockFindOne for
// StudentMotorBaseline, mockThFindAll/mockThBulkCreate for ThresholdHistory)
// exactly as Section 31/Persistence Test 1 already do — this function is a
// pure aggregation over those two, never a reimplementation.

describe('getCurrentFamilyThresholdsForStudent — Teacher Dashboard integration fix', () => {
  it('all three families already resolved: returns them as-is, never triggers repair', async () => {
    mockThFindOne
      .mockResolvedValueOnce(makeHistoryRow({ scope_key: 'straight', baseline_family: 'straight', source: 'initial_from_baseline', new_threshold: 89 }))
      .mockResolvedValueOnce(makeHistoryRow({ scope_key: 'curved',   baseline_family: 'curved',   source: 'automatic',           new_threshold: 84 }))
      .mockResolvedValueOnce(makeHistoryRow({ scope_key: 'complex',  baseline_family: 'complex',  source: 'teacher_override',    new_threshold: 96 }));

    const result = await getCurrentFamilyThresholdsForStudent({ studentId: 31 });

    expect(result).toEqual({
      status: 'resolved',
      families: {
        straight: { status: 'available', threshold: 89, source: 'initial_from_baseline' },
        curved:   { status: 'available', threshold: 84, source: 'automatic' },
        complex:  { status: 'available', threshold: 96, source: 'teacher_override' },
      },
    });
    expect(mockFindOne).not.toHaveBeenCalled(); // StudentMotorBaseline never read — no repair needed
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('no target for any family, but a baseline exists: lazily repairs exactly once via createInitialFamilyThresholds, then returns the newly created values', async () => {
    mockThFindOne.mockResolvedValue(null); // no_target for all three families
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ student_id: 35, straight_score: 9, curved_score: 95, complex_score: 94 }));
    mockThFindAll.mockResolvedValueOnce([]); // createInitialFamilyThresholds' own pre-insert check
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await getCurrentFamilyThresholdsForStudent({ studentId: 35 });

    expect(result.status).toBe('resolved');
    expect(result.families.straight).toEqual({ status: 'available', threshold: 14, source: 'initial_from_baseline' });
    expect(result.families.curved).toEqual({ status: 'available', threshold: 100, source: 'initial_from_baseline' });
    expect(result.families.complex).toEqual({ status: 'available', threshold: 99, source: 'initial_from_baseline' });
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1); // exactly one repair attempt, not one per family
  });

  it('no target for any family, and no baseline exists either: reports unavailable, never fabricates a value, and does not throw', async () => {
    mockThFindOne.mockResolvedValue(null);
    mockFindOne.mockResolvedValueOnce(null); // StudentMotorBaseline.findOne finds nothing

    const result = await getCurrentFamilyThresholdsForStudent({ studentId: 9 });

    expect(result).toEqual({
      status: 'resolved',
      families: {
        straight: { status: 'unavailable', threshold: null, source: null },
        curved:   { status: 'unavailable', threshold: null, source: null },
        complex:  { status: 'unavailable', threshold: null, source: null },
      },
    });
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('a mix of available and no_target families: only the no_target ones are sent through repair, available ones are left untouched', async () => {
    mockThFindOne
      .mockResolvedValueOnce(makeHistoryRow({ scope_key: 'straight', baseline_family: 'straight', source: 'automatic', new_threshold: 70 })) // straight: found
      .mockResolvedValueOnce(null) // curved: no_target
      .mockResolvedValueOnce(null); // complex: no_target
    mockFindOne.mockResolvedValueOnce(makeBaselineRow({ straight_score: 62, curved_score: 83, complex_score: 68 }));
    // createInitialFamilyThresholds performs its OWN independent existence
    // check (ThresholdHistory.findAll) — consistent with the mockThFindOne
    // sequence above, straight already has a row (an 'automatic' one, not
    // 'initial_from_baseline', but still enough to make the initial-family
    // insert skip it); curved/complex do not.
    mockThFindAll.mockResolvedValueOnce([
      makeHistoryRow({ id: 1, scope_key: 'straight', baseline_family: 'straight', source: 'automatic', new_threshold: 70 }),
    ]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await getCurrentFamilyThresholdsForStudent({ studentId: 13 });

    expect(result.families.straight).toEqual({ status: 'available', threshold: 70, source: 'automatic' });
    expect(result.families.curved.status).toBe('available');
    expect(result.families.complex.status).toBe('available');
    // Repair only ever writes the two genuinely-missing families, never re-derives straight's real (non-lazy) value.
    const insertedRows = mockThBulkCreate.mock.calls[0][0];
    expect(insertedRows.map(r => r.scope_key).sort()).toEqual(['complex', 'curved']);
  });

  it('lazy repair itself throws: the thrown error is caught, and every pending family stays unavailable rather than crashing the endpoint', async () => {
    mockThFindOne.mockResolvedValue(null);
    mockFindOne.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await getCurrentFamilyThresholdsForStudent({ studentId: 13 });

    expect(result.status).toBe('resolved');
    expect(result.families.straight).toEqual({ status: 'unavailable', threshold: null, source: null });
    expect(result.families.curved).toEqual({ status: 'unavailable', threshold: null, source: null });
    expect(result.families.complex).toEqual({ status: 'unavailable', threshold: null, source: null });
  });

  it('a family already-initialized by a concurrent request during the repair race resolves as available too (already_initialized counts, not just created)', async () => {
    mockThFindOne.mockResolvedValue(null); // this request's own initial read still sees nothing yet
    mockFindOne.mockResolvedValueOnce(makeBaselineRow());
    // createInitialFamilyThresholds' own pre-check now finds all 3 rows already inserted by a racing request.
    mockThFindAll.mockResolvedValueOnce([
      makeHistoryRow({ id: 1, scope_key: 'straight', new_threshold: 67 }),
      makeHistoryRow({ id: 2, scope_key: 'curved',   new_threshold: 88 }),
      makeHistoryRow({ id: 3, scope_key: 'complex',  new_threshold: 73 }),
    ]);

    const result = await getCurrentFamilyThresholdsForStudent({ studentId: 13 });

    expect(result.families.straight).toEqual({ status: 'available', threshold: 67, source: 'initial_from_baseline' });
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('invalid studentId is rejected before any query', async () => {
    const result = await getCurrentFamilyThresholdsForStudent({ studentId: -1 });
    expect(result).toEqual({ status: 'invalid_input', families: null });
    expect(mockThFindOne).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});

// ─── Section 32 — evaluateDynamicThresholds decision tests (18 tests) ─────

describe('evaluateDynamicThresholds — Section 32', () => {
  it('Test 1: incomplete window, 0 attempts -> insufficient_data', async () => {
    familyTargetsFixture.curved = 88;
    familyRowsFixture.curved = [];

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.curved.decision).toBe('insufficient_data');
    expect(result.families.curved.reason).toBe('insufficient_window');
    expect(result.families.curved.recommendedThreshold).toBe(88);
    expect(result.families.curved.metTargetCount).toBeNull();
  });

  it('Test 2: incomplete window, 2 attempts (student 13\'s real live curved shape) -> insufficient_data, not support_review', async () => {
    familyTargetsFixture.curved = 88;
    familyRowsFixture.curved = makeScoredAttempts([79, 77]);

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.curved.window).toEqual({ count: 2, complete: false });
    expect(result.families.curved.scores).toEqual([79, 77]);
    expect(result.families.curved.decision).toBe('insufficient_data');
    expect(result.families.curved.metTargetCount).toBeNull(); // must not drive any decision
    expect(result.families.curved.diagnosticMetTargetCount).toBe(0); // diagnostic only
  });

  it('Test 3: complete window 5/5 meet -> raise', async () => {
    familyTargetsFixture.curved = 88;
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.curved.window).toEqual({ count: 5, complete: true });
    expect(result.families.curved.metTargetCount).toBe(5);
    expect(result.families.curved.decision).toBe('raise');
    expect(result.families.curved.reason).toBe('4_or_5_met_target');
    expect(result.families.curved.rawRecommendedThreshold).toBe(93);
    expect(result.families.curved.recommendedThreshold).toBe(93);
  });

  it('Test 4: complete window 4/5 meet -> raise', async () => {
    familyTargetsFixture.curved = 88;
    familyRowsFixture.curved = makeScoredAttempts([90, 89, 88, 87, 91]);

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.curved.metTargetCount).toBe(4);
    expect(result.families.curved.decision).toBe('raise');
    expect(result.families.curved.recommendedThreshold).toBe(93);
  });

  it('Test 5: complete window 3/5 meet -> hold', async () => {
    familyTargetsFixture.straight = 80;
    familyRowsFixture.straight = makeScoredAttempts([85, 86, 79, 78, 88], { letter: 'l' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.straight.metTargetCount).toBe(3);
    expect(result.families.straight.decision).toBe('hold');
    expect(result.families.straight.reason).toBe('2_or_3_met_target');
    expect(result.families.straight.recommendedThreshold).toBe(80);
  });

  it('Test 6: complete window 2/5 meet -> hold', async () => {
    familyTargetsFixture.straight = 80;
    familyRowsFixture.straight = makeScoredAttempts([85, 79, 78, 77, 88], { letter: 'l' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.straight.metTargetCount).toBe(2);
    expect(result.families.straight.decision).toBe('hold');
  });

  it('Test 7: complete window 1/5 meet -> support_review', async () => {
    familyTargetsFixture.complex = 80;
    familyRowsFixture.complex = makeScoredAttempts([85, 79, 78, 77, 76], { letter: 'v' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.complex.metTargetCount).toBe(1);
    expect(result.families.complex.decision).toBe('support_review');
    expect(result.families.complex.reason).toBe('0_or_1_met_target');
    expect(result.families.complex.recommendedThreshold).toBe(80); // NEVER lowered
  });

  it('Test 8: complete window 0/5 meet -> support_review, current threshold untouched', async () => {
    familyTargetsFixture.complex = 80;
    familyRowsFixture.complex = makeScoredAttempts([79, 78, 77, 76, 75], { letter: 'v' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.complex.metTargetCount).toBe(0);
    expect(result.families.complex.decision).toBe('support_review');
    expect(result.families.complex.recommendedThreshold).toBe(80);
  });

  it('Test 9: a score exactly equal to the target counts as met (>=, not >)', async () => {
    familyTargetsFixture.curved = 88;
    // 4 attempts exactly at 88, 1 below -> 4/5 met -> raise (proves >= via
    // the raise outcome, and directly checks metTarget on the boundary row).
    familyRowsFixture.curved = makeScoredAttempts([88, 88, 88, 88, 80]);

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.curved.metTargetCount).toBe(4);
    expect(result.families.curved.decision).toBe('raise');
    const boundaryAttempt = result.families.curved.attemptEvaluations.find(a => a.performanceScore === 88);
    expect(boundaryAttempt.metTarget).toBe(true);
  });

  it('Test 10: proposed raise exceeds 100 -> raise_requires_review, not silently clamped', async () => {
    familyTargetsFixture.complex = 98;
    familyRowsFixture.complex = makeScoredAttempts([99, 100, 99, 100, 99], { letter: 'v' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.complex.metTargetCount).toBe(5);
    expect(result.families.complex.decision).toBe('raise_requires_review');
    expect(result.families.complex.rawRecommendedThreshold).toBe(103);
    expect(result.families.complex.recommendedThreshold).toBeNull();
    expect(result.families.complex.requiresReview).toBe(true);
    expect(result.families.complex.reason).toBe('proposed_target_exceeds_score_range');
  });

  it('Test 11: exactly 100 is a valid raise (95 + 5), not flagged for review', async () => {
    familyTargetsFixture.straight = 95;
    familyRowsFixture.straight = makeScoredAttempts([96, 97, 98, 99, 100], { letter: 'l' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.straight.decision).toBe('raise');
    expect(result.families.straight.rawRecommendedThreshold).toBe(100);
    expect(result.families.straight.recommendedThreshold).toBe(100);
    expect(result.families.straight.requiresReview).toBe(false);
  });

  it('Test 12: family independence — one family raising does not affect a sibling with insufficient data', async () => {
    familyTargetsFixture.straight = 80;
    familyTargetsFixture.curved = 88;
    familyRowsFixture.straight = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'l' });
    familyRowsFixture.curved = [];

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.straight.decision).toBe('raise');
    expect(result.families.curved.decision).toBe('insufficient_data');
    expect(result.families.complex.decision).toBe('no_target'); // never initialized in this fixture
  });

  it('Test 13: target missing entirely -> no_target, not insufficient_data', async () => {
    familyTargetsFixture.complex = null;
    familyRowsFixture.complex = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'v' });

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.complex.decision).toBe('no_target');
    expect(result.families.complex.reason).toBe('target_not_initialized');
    expect(result.families.complex.currentThreshold).toBeNull();
    expect(result.families.complex.recommendedThreshold).toBeNull();
  });

  it('Test 14: invalid studentId is rejected before any query', async () => {
    const result = await evaluateDynamicThresholds({ studentId: -1 });
    expect(result.status).toBe('invalid_input');
    expect(mockThFindOne).not.toHaveBeenCalled();
    expect(mockLaFindAll).not.toHaveBeenCalled();
  });

  it('Test 15: invalid windowSize is rejected before any query', async () => {
    const result = await evaluateDynamicThresholds({ studentId: 13, windowSize: 0 });
    expect(result.status).toBe('invalid_window_size');
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  it('Test 16: invalid increaseStep is rejected before any query', async () => {
    const result = await evaluateDynamicThresholds({ studentId: 13, increaseStep: 'five' });
    expect(result.status).toBe('invalid_increase_step');
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  it('Test 16b: a negative increaseStep is also rejected', async () => {
    const result = await evaluateDynamicThresholds({ studentId: 13, increaseStep: -1 });
    expect(result.status).toBe('invalid_increase_step');
  });

  it('Test 17: increaseStep=0 is allowed — raise proposes exactly the current threshold', async () => {
    familyTargetsFixture.curved = 88;
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);

    const result = await evaluateDynamicThresholds({ studentId: 13, increaseStep: 0 });

    expect(result.status).toBe('evaluated');
    expect(result.increaseStep).toBe(0);
    expect(result.families.curved.decision).toBe('raise');
    expect(result.families.curved.rawRecommendedThreshold).toBe(88);
    expect(result.families.curved.recommendedThreshold).toBe(88);
  });

  it('Test 18: no writes — never calls create/bulkCreate/update/destroy on any model, never opens a transaction', async () => {
    familyTargetsFixture.straight = 80;
    familyTargetsFixture.curved = 88;
    familyTargetsFixture.complex = 98;
    familyRowsFixture.straight = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'l' });
    familyRowsFixture.curved = makeScoredAttempts([79, 77]);
    familyRowsFixture.complex = makeScoredAttempts([99, 100, 99, 100, 99], { letter: 'v' });

    await evaluateDynamicThresholds({ studentId: 13 });

    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
    expect(mockThDestroy).not.toHaveBeenCalled();
    expect(mockLaCreate).not.toHaveBeenCalled();
    expect(mockLaBulkCreate).not.toHaveBeenCalled();
    expect(mockLaUpdate).not.toHaveBeenCalled();
    expect(mockLaDestroy).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ─── Bonus — the live student 13 shape (all three families insufficient_data) ─

describe('evaluateDynamicThresholds — live student 13 shape reproduced with fixtures', () => {
  it('straight=0/5, curved=2/5 (79,77 vs target 88), complex=0/5 -> all insufficient_data', async () => {
    familyTargetsFixture.straight = 67;
    familyTargetsFixture.curved = 88;
    familyTargetsFixture.complex = 73;
    familyRowsFixture.straight = [];
    familyRowsFixture.curved = makeScoredAttempts([79, 77]);
    familyRowsFixture.complex = [];

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.families.straight.decision).toBe('insufficient_data');
    expect(result.families.curved.decision).toBe('insufficient_data');
    expect(result.families.complex.decision).toBe('insufficient_data');
    // None of the three ever reach 'raise'/'hold'/'support_review' — an
    // incomplete window NEVER activates a decision.
  });
});

// ─── Bonus — top-level status propagation ──────────────────────────────────

describe('evaluateDynamicThresholds — status propagation', () => {
  it('propagates read_failed from getRecentFamilyPerformance without throwing', async () => {
    familyTargetsFixture.straight = 80;
    mockLaFindAll.mockRejectedValue(new Error('connection terminated'));

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.status).toBe('read_failed');
    expect(result.families).toBeNull();
  });

  it('propagates read_failed when a target lookup itself throws', async () => {
    mockThFindOne.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await evaluateDynamicThresholds({ studentId: 13 });

    expect(result.status).toBe('read_failed');
    expect(result.families).toBeNull();
  });

  it('a successful evaluation reports mappingVersion/windowSize/increaseStep correctly', async () => {
    familyTargetsFixture.curved = 88;
    const result = await evaluateDynamicThresholds({ studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(result.status).toBe('evaluated');
    expect(result.mappingVersion).toBe(MAPPING_VERSION);
    expect(result.windowSize).toBe(5);
    expect(result.increaseStep).toBe(5);
    expect(THRESHOLD_INCREASE_STEP).toBe(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Feature 2 Step 6A — setTeacherFamilyThreshold() / getFamilyThresholdProtection()
// ═════════════════════════════════════════════════════════════════════════

// ─── Section 29 — service tests (20 tests) ─────────────────────────────────

describe('setTeacherFamilyThreshold — Section 29', () => {
  it('Test 1: valid owned student + initialized family -> teacher override row created', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(result.status).toBe('updated');
    expect(result.historyId).toBe(4);
    expect(mockThCreate).toHaveBeenCalledTimes(1);
  });

  it('Test 2: old_threshold equals the current Feature 2 threshold', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(result.oldThreshold).toBe(88);
    expect(result.newThreshold).toBe(85);
  });

  it('Test 3: new row has source=teacher_override, reason=teacher_override, scope_type=family, scope_key/baseline_family=family', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    const insertedRow = mockThCreate.mock.calls[0][0];
    expect(insertedRow).toMatchObject({
      student_id: 13, scope_type: 'family', scope_key: 'curved', baseline_family: 'curved',
      source: 'teacher_override', reason: 'teacher_override',
      old_threshold: 88, new_threshold: 85,
    });
  });

  it('Test 4: baseline_id/baseline_version/mapping_version are propagated from the current target event', async () => {
    familyTargetsFixture.curved = makeHistoryRow({
      scope_key: 'curved', baseline_family: 'curved', new_threshold: 88,
      baseline_id: 7, baseline_version: 'baseline-v2', mapping_version: 'letter-baseline-family-v1',
    });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    const insertedRow = mockThCreate.mock.calls[0][0];
    expect(insertedRow.baseline_id).toBe(7);
    expect(insertedRow.baseline_version).toBe('baseline-v2');
    expect(insertedRow.mapping_version).toBe('letter-baseline-family-v1');
  });

  it('Test 5: recent_window_snapshot is null — a human decision is never dressed up as an algorithmic one', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(mockThCreate.mock.calls[0][0].recent_window_snapshot).toBeNull();
  });

  it('Test 6: no current target -> threshold_not_initialized, no insert', async () => {
    familyTargetsFixture.curved = null; // no_target

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(result.status).toBe('threshold_not_initialized');
    expect(mockThCreate).not.toHaveBeenCalled();
  });

  it('Test 7: invalid teacher ID is rejected before any query', async () => {
    const result = await setTeacherFamilyThreshold({ teacherId: -1, studentId: 13, family: 'curved', value: 85 });
    expect(result.status).toBe('invalid_input');
    expect(mockStudentFindOne).not.toHaveBeenCalled();
  });

  it('Test 8: invalid student ID is rejected before any query', async () => {
    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 'abc', family: 'curved', value: 85 });
    expect(result.status).toBe('invalid_input');
    expect(mockStudentFindOne).not.toHaveBeenCalled();
  });

  it('Test 9: an unowned/nonexistent student -> student_not_found, no insert, never reveals another teacher\'s ownership', async () => {
    mockStudentFindOne.mockResolvedValueOnce(null);

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 999, family: 'curved', value: 85 });

    expect(result.status).toBe('student_not_found');
    expect(mockThCreate).not.toHaveBeenCalled();
  });

  it('Test 10: invalid family is rejected before any query', async () => {
    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'mixed', value: 85 });
    expect(result.status).toBe('invalid_family');
    expect(mockStudentFindOne).not.toHaveBeenCalled();
  });

  it('Test 11: value < 0 is rejected', async () => {
    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: -1 });
    expect(result.status).toBe('invalid_value');
    expect(mockThCreate).not.toHaveBeenCalled();
  });

  it('Test 12: value > 100 is rejected', async () => {
    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 101 });
    expect(result.status).toBe('invalid_value');
  });

  it('Test 13: NaN/Infinity/string values are rejected, never coerced', async () => {
    for (const value of [NaN, Infinity, -Infinity, '85']) {
      const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value });
      expect(result.status).toBe('invalid_value');
    }
  });

  it('Test 14: value = 0 is accepted', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 67 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 0 });

    expect(result.status).toBe('updated');
    expect(result.newThreshold).toBe(0);
  });

  it('Test 15: value = 100 is accepted', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 67 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 100 });

    expect(result.status).toBe('updated');
    expect(result.newThreshold).toBe(100);
  });

  it('Test 16: multiple overrides for the same family are allowed — no uniqueness blocks a second call', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4)).mockImplementationOnce(echoCreate(5));

    const first  = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 65 });
    const second = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 70 });

    expect(first.status).toBe('updated');
    expect(second.status).toBe('updated');
    expect(mockThCreate).toHaveBeenCalledTimes(2);
  });

  it('Test 17: the latest override becomes the current target (reusing getCurrentFamilyThreshold\'s already-proven latest-event rule)', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88, source: 'initial_from_baseline' });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 70 });

    // Simulate the DB now reflecting the just-inserted row as latest.
    familyTargetsFixture.curved = makeHistoryRow({ id: 4, scope_key: 'curved', baseline_family: 'curved', new_threshold: 70, source: 'teacher_override' });
    const current = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });

    expect(current.currentThreshold).toBe(70);
    expect(current.sourceEvent.source).toBe('teacher_override');
  });

  it('Test 18: previous history rows are never updated or deleted — append-only', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(mockThUpdate).not.toHaveBeenCalled();
    expect(mockThDestroy).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 19: students.personal_thresholds is never written — Student.update is never called', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(mockStudentUpdate).not.toHaveBeenCalled();
    expect(mockStudentCreate).not.toHaveBeenCalled();
    expect(mockStudentDestroy).not.toHaveBeenCalled();
  });

  it('Test 20: StudentMotorBaseline is never created/updated/destroyed — baseline immutability preserved', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockImplementationOnce(echoCreate(4));

    await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('a DB error during ownership check surfaces as read_failed', async () => {
    mockStudentFindOne.mockRejectedValueOnce(new Error('connection terminated'));
    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });
    expect(result.status).toBe('read_failed');
  });

  it('a DB error during the insert itself surfaces as save_failed, not thrown', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockThCreate.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await setTeacherFamilyThreshold({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });

    expect(result.status).toBe('save_failed');
  });
});

// ─── Section 30 — protection-helper tests (6 tests) ────────────────────────

describe('getFamilyThresholdProtection — Section 30', () => {
  it('Protection 1: latest event is initial_from_baseline -> protected=false', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ scope_key: 'straight', baseline_family: 'straight', source: 'initial_from_baseline', new_threshold: 67 });

    const result = await getFamilyThresholdProtection({ studentId: 13, family: 'straight' });

    expect(result.protected).toBe(false);
    expect(result.currentThreshold).toBe(67);
  });

  it('Protection 2: latest event is automatic -> protected=false', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93 });

    const result = await getFamilyThresholdProtection({ studentId: 13, family: 'curved' });

    expect(result.protected).toBe(false);
  });

  it('Protection 3: latest event is teacher_override -> protected=true', async () => {
    familyTargetsFixture.complex = makeHistoryRow({ id: 9, scope_key: 'complex', baseline_family: 'complex', source: 'teacher_override', new_threshold: 70 });

    const result = await getFamilyThresholdProtection({ studentId: 13, family: 'complex' });

    expect(result.protected).toBe(true);
    expect(result.reason).toBe('latest_target_is_teacher_override');
    expect(result.historyId).toBe(9);
  });

  it('Protection 4: an OLDER teacher_override with a NEWER automatic as latest -> protected=false (latest event, not historical existence)', async () => {
    // The mock router returns exactly "the latest row" directly (mirroring
    // what ORDER BY created_at DESC, id DESC would resolve to) — this proves
    // the helper reads whatever IS latest, never "has a teacher_override
    // ever existed for this family".
    familyTargetsFixture.curved = makeHistoryRow({ id: 12, scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 90 });

    const result = await getFamilyThresholdProtection({ studentId: 13, family: 'curved' });

    expect(result.protected).toBe(false);
  });

  it('Protection 5: no current target -> status no_target, protected=false', async () => {
    familyTargetsFixture.straight = null;

    const result = await getFamilyThresholdProtection({ studentId: 13, family: 'straight' });

    expect(result.status).toBe('no_target');
    expect(result.protected).toBe(false);
    expect(result.currentThreshold).toBeNull();
  });

  it('Protection 6: a different family is ignored — each family\'s protection is evaluated independently', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ scope_key: 'straight', baseline_family: 'straight', source: 'teacher_override', new_threshold: 70 });
    familyTargetsFixture.curved   = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93 });

    const straightResult = await getFamilyThresholdProtection({ studentId: 13, family: 'straight' });
    const curvedResult   = await getFamilyThresholdProtection({ studentId: 13, family: 'curved' });

    expect(straightResult.protected).toBe(true);
    expect(curvedResult.protected).toBe(false);
  });

  it('invalid studentId/family are rejected, never queried', async () => {
    const badStudent = await getFamilyThresholdProtection({ studentId: -1, family: 'straight' });
    expect(badStudent.status).toBe('invalid_input');

    const badFamily = await getFamilyThresholdProtection({ studentId: 13, family: 'mixed' });
    expect(badFamily.status).toBe('invalid_family');
  });

  it('never calls any write method — fully read-only', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', source: 'teacher_override', new_threshold: 70 });

    await getFamilyThresholdProtection({ studentId: 13, family: 'curved' });

    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
    expect(mockThUpdate).not.toHaveBeenCalled();
    expect(mockThDestroy).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Feature 2 Step 6B — computeEvidenceFingerprint / classifyAutomaticThresholdPersistence / persistAutomaticThresholdDecisions
// ═════════════════════════════════════════════════════════════════════════

// ─── Section 30 — evidence fingerprint tests (7 tests) ─────────────────────

describe('computeEvidenceFingerprint — Section 30', () => {
  function baseParams(overrides = {}) {
    return {
      studentId: 13, family: 'curved', currentThresholdHistoryId: 2,
      attemptIds: [104, 103, 102, 101, 100], windowSize: 5, mappingVersion: 'letter-baseline-family-v1',
      ...overrides,
    };
  }

  it('Test 1: same attempt IDs + same target history -> same fingerprint', () => {
    const a = computeEvidenceFingerprint(baseParams());
    const b = computeEvidenceFingerprint(baseParams());
    expect(a).toBe(b);
  });

  it('Test 2: attempt order is handled deterministically — a shuffled/differently-ordered attemptIds array produces the SAME fingerprint', () => {
    const inOrder    = computeEvidenceFingerprint(baseParams({ attemptIds: [100, 101, 102, 103, 104] }));
    const reversed   = computeEvidenceFingerprint(baseParams({ attemptIds: [104, 103, 102, 101, 100] }));
    const shuffled   = computeEvidenceFingerprint(baseParams({ attemptIds: [102, 100, 104, 101, 103] }));
    expect(inOrder).toBe(reversed);
    expect(inOrder).toBe(shuffled);
  });

  it('Test 3: a different attempt SET -> a different fingerprint', () => {
    const a = computeEvidenceFingerprint(baseParams({ attemptIds: [100, 101, 102, 103, 104] }));
    const b = computeEvidenceFingerprint(baseParams({ attemptIds: [100, 101, 102, 103, 105] })); // one attempt differs
    expect(a).not.toBe(b);
  });

  it('Test 4: a different family -> a different fingerprint (even with identical everything else)', () => {
    const curved = computeEvidenceFingerprint(baseParams({ family: 'curved' }));
    const straight = computeEvidenceFingerprint(baseParams({ family: 'straight' }));
    expect(curved).not.toBe(straight);
  });

  it('Test 5: a different current-target history event -> a different fingerprint (same attempts, different baseline target row)', () => {
    const a = computeEvidenceFingerprint(baseParams({ currentThresholdHistoryId: 2 }));
    const b = computeEvidenceFingerprint(baseParams({ currentThresholdHistoryId: 3 }));
    expect(a).not.toBe(b);
  });

  it('Test 6: mapping version is included — a different mapping_version changes the fingerprint even with everything else identical', () => {
    const a = computeEvidenceFingerprint(baseParams({ mappingVersion: 'letter-baseline-family-v1' }));
    const b = computeEvidenceFingerprint(baseParams({ mappingVersion: 'letter-baseline-family-v2' }));
    expect(a).not.toBe(b);
  });

  it('Test 7: the fingerprint is derived only from IDs/small integers/strings — never raw feature data — and is a well-formed sha256 hex digest', () => {
    const fingerprint = computeEvidenceFingerprint(baseParams());
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The function signature itself accepts no smoothness/dtw_distance/
    // stroke-point fields at all — there is nowhere for raw feature data to
    // enter the hash. A no-timestamp guarantee: calling it twice, moments
    // apart, still yields an identical digest.
    const later = computeEvidenceFingerprint(baseParams());
    expect(later).toBe(fingerprint);
  });
});

// ─── Section 29 — persistAutomaticThresholdDecisions service tests (22 tests) ──

describe('persistAutomaticThresholdDecisions — Section 29', () => {
  it('Test 1/2: raise + unprotected -> automatic row created, with correct old/new thresholds', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.status).toBe('created');
    expect(result.families.curved.status).toBe('created');
    expect(result.families.curved.oldThreshold).toBe(88);
    expect(result.families.curved.newThreshold).toBe(93);
  });

  it('Test 3: inserted row has source=automatic, reason=4_or_5_met_target, scope_type=family, scope_key/baseline_family=family', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    const insertedRow = mockThBulkCreate.mock.calls[0][0][0];
    expect(insertedRow).toMatchObject({
      student_id: 13, scope_type: 'family', scope_key: 'curved', baseline_family: 'curved',
      source: 'automatic', reason: '4_or_5_met_target', old_threshold: 88, new_threshold: 93,
    });
  });

  it('Test 4: baseline_id/baseline_version/mapping_version are propagated from the current target event', async () => {
    familyTargetsFixture.curved = makeHistoryRow({
      id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88,
      baseline_id: 7, baseline_version: 'baseline-v2', mapping_version: 'letter-baseline-family-v1',
    });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    const insertedRow = mockThBulkCreate.mock.calls[0][0][0];
    expect(insertedRow.baseline_id).toBe(7);
    expect(insertedRow.baseline_version).toBe('baseline-v2');
    expect(insertedRow.mapping_version).toBe('letter-baseline-family-v1');
  });

  it('Test 5: recent_window_snapshot has the recommended minimal shape — IDs + scores only, no raw feature data', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]); // ids 100-104, newest-first
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    const snapshot = mockThBulkCreate.mock.calls[0][0][0].recent_window_snapshot;
    expect(snapshot).toEqual({
      windowSize: 5,
      scores: [90, 91, 92, 93, 94],
      metTarget: [true, true, true, true, true],
      metTargetCount: 5,
      evaluatedThreshold: 88,
      increaseStep: 5,
      attemptIds: [100, 101, 102, 103, 104],
    });
  });

  it('Test 6: the same evidence, persisted a second time, resolves to already_persisted — no second insert', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const first = await persistAutomaticThresholdDecisions({ studentId: 13 });
    expect(first.families.curved.status).toBe('created');

    // Simulate the row now existing in the DB under its real fingerprint.
    const insertedFingerprint = mockThBulkCreate.mock.calls[0][0][0].evidence_fingerprint;
    evidenceFixture[insertedFingerprint] = makeHistoryRow({ id: 10, scope_key: 'curved', source: 'automatic', new_threshold: 93 });
    mockThBulkCreate.mockClear();

    const second = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(second.families.curved.status).toBe('already_persisted');
    expect(second.families.curved.historyId).toBe(10);
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 7: the same family with NEW evidence (a different attempt set) is allowed to create a new automatic event', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    // A prior automatic event exists under some OTHER (unrelated) fingerprint.
    evidenceFixture['some-other-fingerprint-from-a-past-run'] = makeHistoryRow({ id: 10, scope_key: 'curved', source: 'automatic', new_threshold: 93 });
    familyRowsFixture.curved = makeScoredAttempts([95, 96, 97, 98, 99]); // a fresh, different set of 5 attempts
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.curved.status).toBe('created');
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);
  });

  it('Test 8: teacher-protected -> skipped, no insert, even though the decision itself is raise', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', source: 'teacher_override', new_threshold: 90 });
    familyRowsFixture.curved = makeScoredAttempts([91, 92, 93, 94, 95]); // 5/5 meet 90 -> raise, if unprotected

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.curved.status).toBe('skipped_teacher_protected');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 9: hold -> no insert', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ scope_key: 'straight', baseline_family: 'straight', new_threshold: 80 });
    familyRowsFixture.straight = makeScoredAttempts([85, 86, 79, 78, 88], { letter: 'l' }); // 3/5 meet -> hold

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.straight.status).toBe('skipped_hold');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 10: support_review -> no insert', async () => {
    familyTargetsFixture.complex = makeHistoryRow({ scope_key: 'complex', baseline_family: 'complex', new_threshold: 80 });
    familyRowsFixture.complex = makeScoredAttempts([79, 78, 77, 76, 75], { letter: 'v' }); // 0/5 meet -> support_review

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.complex.status).toBe('skipped_support_review');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 11: insufficient_data -> no insert', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([79, 77]); // only 2/5 — student 13's real live shape

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.curved.status).toBe('skipped_insufficient_data');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 12: no_target -> no insert', async () => {
    // familyTargetsFixture.straight stays null (default) — no target initialized.
    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.straight.status).toBe('skipped_no_target');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 13: raise_requires_review -> no insert', async () => {
    familyTargetsFixture.complex = makeHistoryRow({ scope_key: 'complex', baseline_family: 'complex', new_threshold: 98 });
    familyRowsFixture.complex = makeScoredAttempts([99, 100, 99, 100, 99], { letter: 'v' }); // 5/5 meet, +5 -> 103 > 100

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.complex.status).toBe('skipped_requires_review');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 14: a stale target (changed between evaluation and write) -> no insert', async () => {
    let curvedCallCount = 0;
    mockThFindOne.mockImplementation(({ where }) => {
      if (where.evidence_fingerprint !== undefined) return Promise.resolve(null);
      if (where.scope_key !== 'curved') return Promise.resolve(null); // straight/complex -> no_target
      curvedCallCount++;
      // 1st read (inside evaluateDynamicThresholds) sees the ORIGINAL target;
      // every subsequent read (protection check + fresh re-read) sees a
      // DIFFERENT, already-changed target — simulating a race with another
      // process between evaluation and this write attempt.
      return Promise.resolve(curvedCallCount === 1
        ? makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 })
        : makeHistoryRow({ id: 20, scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93 }));
    });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.curved.status).toBe('stale_decision');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 15: a race unique-constraint violation at insert time resolves to already_persisted, never a thrown error', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);

    const expectedFingerprint = computeEvidenceFingerprint({
      studentId: 13, family: 'curved', currentThresholdHistoryId: 2,
      attemptIds: [100, 101, 102, 103, 104], windowSize: 5, mappingVersion: 'letter-baseline-family-v1',
    });

    mockThBulkCreate.mockImplementationOnce(async () => {
      // Simulate another process winning the race and inserting first.
      evidenceFixture[expectedFingerprint] = makeHistoryRow({ id: 55, scope_key: 'curved', source: 'automatic', new_threshold: 93 });
      const err = new Error('duplicate key value violates unique constraint');
      err.name = 'SequelizeUniqueConstraintError';
      throw err;
    });

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.curved.status).toBe('already_persisted');
    expect(result.families.curved.historyId).toBe(55);
    // Top-level status follows the same "every family already_persisted"
    // rollup rule proven in Step 3 (summarizeTopLevelStatus) — straight/
    // complex have no target in this fixture (skipped_no_target), so the
    // correct top-level rollup here is 'no_eligible_families', not
    // 'already_persisted'. The family-level result above is what Test 15
    // is actually about.
    expect(result.status).toBe('no_eligible_families');
  });

  it('Test 16: multiple eligible families are inserted transactionally in one call', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ id: 1, scope_key: 'straight', baseline_family: 'straight', source: 'initial_from_baseline', new_threshold: 80 });
    familyTargetsFixture.curved   = makeHistoryRow({ id: 2, scope_key: 'curved',   baseline_family: 'curved',   source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.straight = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'l' });
    familyRowsFixture.curved   = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'o' });
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.straight.status).toBe('created');
    expect(result.families.curved.status).toBe('created');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockThBulkCreate.mock.calls[0][0]).toHaveLength(2);
  });

  it('Test 17: a transaction failure means no eligible family is reported created', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ id: 1, scope_key: 'straight', baseline_family: 'straight', source: 'initial_from_baseline', new_threshold: 80 });
    familyTargetsFixture.curved   = makeHistoryRow({ id: 2, scope_key: 'curved',   baseline_family: 'curved',   source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.straight = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'l' });
    familyRowsFixture.curved   = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'o' });
    mockTransaction.mockRejectedValueOnce(new Error('connection terminated mid-transaction'));

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(Object.values(result.families).some(f => f.status === 'created')).toBe(false);
    expect(result.families.straight.status).toBe('save_failed');
    expect(result.families.curved.status).toBe('save_failed');
    expect(result.status).toBe('save_failed');
  });

  it('Test 18: current threshold resolves to the automatic row afterward (latest-event rule, already proven in Step 5/6A)', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    // Simulate the DB now reflecting the just-inserted automatic row as latest.
    familyTargetsFixture.curved = makeHistoryRow({ id: 4, scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93 });
    const current = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });

    expect(current.currentThreshold).toBe(93);
    expect(current.sourceEvent.source).toBe('automatic');
  });

  it('Test 19: a later teacher_override still wins over an earlier automatic event', async () => {
    // initial 88 -> automatic 93 -> teacher_override 90 -- current must be 90, protected.
    familyTargetsFixture.curved = makeHistoryRow({ id: 5, scope_key: 'curved', baseline_family: 'curved', source: 'teacher_override', new_threshold: 90 });

    const current = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });
    const protection = await getFamilyThresholdProtection({ studentId: 13, family: 'curved' });

    expect(current.currentThreshold).toBe(90);
    expect(protection.protected).toBe(true);
  });

  it('Test 20: students.personal_thresholds is never written — Student.update is never called', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(mockStudentUpdate).not.toHaveBeenCalled();
    expect(mockStudentCreate).not.toHaveBeenCalled();
    expect(mockStudentDestroy).not.toHaveBeenCalled();
  });

  it('Test 21: StudentMotorBaseline is never created/updated/destroyed', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('Test 22: LetterAttempt is never created/updated/destroyed — the window is read-only, even during a real automatic write', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(mockLaCreate).not.toHaveBeenCalled();
    expect(mockLaBulkCreate).not.toHaveBeenCalled();
    expect(mockLaUpdate).not.toHaveBeenCalled();
    expect(mockLaDestroy).not.toHaveBeenCalled();
  });

  it('invalid studentId/windowSize/increaseStep are rejected before any query', async () => {
    const badStudent = await persistAutomaticThresholdDecisions({ studentId: -1 });
    expect(badStudent.status).toBe('invalid_input');

    const badWindow = await persistAutomaticThresholdDecisions({ studentId: 13, windowSize: 0 });
    expect(badWindow.status).toBe('invalid_window_size');

    const badStep = await persistAutomaticThresholdDecisions({ studentId: 13, increaseStep: -1 });
    expect(badStep.status).toBe('invalid_increase_step');

    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('family independence: one family created, one logically skipped, one teacher-protected — all in the same run', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ id: 1, scope_key: 'straight', baseline_family: 'straight', source: 'initial_from_baseline', new_threshold: 80 });
    familyTargetsFixture.curved   = makeHistoryRow({ id: 2, scope_key: 'curved',   baseline_family: 'curved',   new_threshold: 88 }); // insufficient_data (no attempts)
    familyTargetsFixture.complex  = makeHistoryRow({ id: 3, scope_key: 'complex',  baseline_family: 'complex',  source: 'teacher_override', new_threshold: 70 });
    familyRowsFixture.straight = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'l' }); // raise
    familyRowsFixture.complex  = makeScoredAttempts([71, 72, 73, 74, 75], { letter: 'v' }); // would raise, but protected
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await persistAutomaticThresholdDecisions({ studentId: 13 });

    expect(result.families.straight.status).toBe('created');
    expect(result.families.curved.status).toBe('skipped_insufficient_data');
    expect(result.families.complex.status).toBe('skipped_teacher_protected');
    expect(result.status).toBe('created'); // top-level reflects "at least one created"
  });
});

// ─── classifyAutomaticThresholdPersistence — read-only guarantee ──────────

describe('classifyAutomaticThresholdPersistence — read-only guarantee for dry-run', () => {
  it('never calls any write method, regardless of outcome', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);

    const classification = await classifyAutomaticThresholdPersistence({ studentId: 13 });

    expect(classification.status).toBe('classified');
    expect(classification.families.curved.action).toBe('would_create');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
    expect(mockThCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('classifies already_persisted evidence correctly for dry-run reporting', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', source: 'initial_from_baseline', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    const fingerprint = computeEvidenceFingerprint({
      studentId: 13, family: 'curved', currentThresholdHistoryId: 2,
      attemptIds: [100, 101, 102, 103, 104], windowSize: 5, mappingVersion: 'letter-baseline-family-v1',
    });
    evidenceFixture[fingerprint] = makeHistoryRow({ id: 10, scope_key: 'curved', source: 'automatic', new_threshold: 93 });

    const classification = await classifyAutomaticThresholdPersistence({ studentId: 13 });

    expect(classification.families.curved.action).toBe('already_persisted');
    expect(classification.families.curved.historyId).toBe(10);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Feature 2 Step 8 — processDynamicThresholdAfterLetterSession()
// ═════════════════════════════════════════════════════════════════════════
//
// Tested in THIS file (not a separate one) because processDynamicThreshold
// AfterLetterSession() calls persistAutomaticThresholdDecisions() directly,
// in the SAME module — jest.mock() cannot selectively stub one export while
// testing another export from that same file. Reusing the exact
// familyTargetsFixture/familyRowsFixture/evidenceFixture infrastructure
// already proven throughout Steps 5/6B means these tests exercise the REAL
// underlying evaluator/persistence path end-to-end, which is strictly more
// meaningful than testing against a stubbed stand-in.

// ─── Section 34 — orchestration unit tests (15 tests) ──────────────────────

describe('processDynamicThresholdAfterLetterSession — Section 34', () => {
  it('Test 1: a mapped normal session triggers the evaluator (LetterAttempt/ThresholdHistory are queried)', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([79, 77]); // incomplete window — still triggers evaluation, just no write

    await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(mockLaFindAll).toHaveBeenCalled(); // getRecentFamilyPerformance ran
    expect(mockThFindOne).toHaveBeenCalled(); // getCurrentFamilyThreshold ran
  });

  it('Test 2: an ambiguous letter is skipped — not_applicable, no DB queries at all', async () => {
    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'a', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result).toEqual({ status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null });
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
  });

  // Test 3 (collection mode) is a CONTROLLER-level concern — this function
  // has no collection_mode parameter at all; see
  // tests/recordLetterCompletionOrchestration.test.js for proof the
  // controller never calls this function from the collection-mode branch.

  it('Test 4: mapped family but no Feature 2 target -> skipped (not_applicable), family still reported', async () => {
    // familyTargetsFixture.curved stays null (default) -> no_target
    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('not_applicable');
    expect(result.family).toBe('curved');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 5: insufficient data -> no persistence', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([79, 77]); // 2/5

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('insufficient_data');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 6: hold -> no persistence', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ id: 1, scope_key: 'straight', baseline_family: 'straight', new_threshold: 80 });
    familyRowsFixture.straight = makeScoredAttempts([85, 86, 79, 78, 88], { letter: 'l' }); // 3/5

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'l', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('hold');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 7: support_review -> no persistence', async () => {
    familyTargetsFixture.complex = makeHistoryRow({ id: 3, scope_key: 'complex', baseline_family: 'complex', new_threshold: 80 });
    familyRowsFixture.complex = makeScoredAttempts([79, 78, 77, 76, 75], { letter: 'v' }); // 0/5

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'v', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('support_review');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 8: raise -> automatic persistence invoked', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]); // 5/5
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('automatic_created');
    expect(result.newThreshold).toBe(93);
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);
  });

  it('Test 9: raise_requires_review -> no write', async () => {
    familyTargetsFixture.complex = makeHistoryRow({ id: 3, scope_key: 'complex', baseline_family: 'complex', new_threshold: 98 });
    familyRowsFixture.complex = makeScoredAttempts([99, 100, 99, 100, 99], { letter: 'v' }); // 5/5, +5 -> 103

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'v', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('raise_requires_review');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 10: teacher protected -> no write', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ scope_key: 'curved', baseline_family: 'curved', source: 'teacher_override', new_threshold: 90 });
    familyRowsFixture.curved = makeScoredAttempts([91, 92, 93, 94, 95]); // 5/5 vs 90 -> would raise, if unprotected

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('teacher_protected');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 11: an adaptation failure (DB error) is non-fatal — returns status:error, never throws', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    mockLaFindAll.mockRejectedValue(new Error('connection terminated'));

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('error');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 12: the same evidence triggering orchestration twice is idempotent — second call resolves already_persisted', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const first = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });
    expect(first.status).toBe('automatic_created');

    const insertedFingerprint = mockThBulkCreate.mock.calls[0][0][0].evidence_fingerprint;
    evidenceFixture[insertedFingerprint] = makeHistoryRow({ id: 10, scope_key: 'curved', source: 'automatic', new_threshold: 93 });
    mockThBulkCreate.mockClear();

    const second = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(second.status).toBe('already_persisted');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });

  it('Test 13: an automatic creation returns the new target in the result', async () => {
    familyTargetsFixture.straight = makeHistoryRow({ id: 1, scope_key: 'straight', baseline_family: 'straight', new_threshold: 80 });
    familyRowsFixture.straight = makeScoredAttempts([90, 91, 92, 93, 94], { letter: 'l' });
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'l', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.newThreshold).toBe(85);
    expect(result.historyId).toBeDefined();
  });

  it('Test 14: the next resolver call sees the new automatic target (future-only activation)', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    // Simulate the DB now reflecting the just-inserted automatic row.
    familyTargetsFixture.curved = makeHistoryRow({ id: 4, scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93 });
    const nextResolution = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });

    expect(nextResolution.currentThreshold).toBe(93);
  });

  it('Test 15: no recursion — evaluator/persistence are each invoked exactly once per orchestration call', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    // getRecentFamilyPerformance queries LetterAttempt 3 times (once per
    // family) per evaluation — exactly once total, never looped/repeated.
    expect(mockLaFindAll).toHaveBeenCalledTimes(3);
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);

    // Structural proof: the module source contains no self-call.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/dynamicThresholdService.js'), 'utf8');
    const orchestrationFnBody = source.split('async function processDynamicThresholdAfterLetterSession')[1];
    expect(orchestrationFnBody).not.toMatch(/processDynamicThresholdAfterLetterSession\(/);
  });

  it('invalid studentId is rejected safely (delegated to persistAutomaticThresholdDecisions\' own validation)', async () => {
    const result = await processDynamicThresholdAfterLetterSession({ studentId: -1, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });
    expect(result.status).toBe('error');
  });

  it('never writes personal_thresholds, baseline, or LetterAttempt — only ThresholdHistory.bulkCreate on a genuine raise', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]);
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(mockStudentUpdate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled(); // StudentMotorBaseline
    expect(mockLaCreate).not.toHaveBeenCalled();
    expect(mockLaBulkCreate).not.toHaveBeenCalled();
    expect(mockLaUpdate).not.toHaveBeenCalled();
    expect(mockLaDestroy).not.toHaveBeenCalled();
  });
});

// ─── Sections 36-41 — realistic scenario tests using the exact numbers from the spec ─

describe('Section 36 — ordering / future-session-only activation', () => {
  it('current target=88 stays in effect for THIS evaluation; a subsequent raise to 93 only appears on the NEXT resolver call', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([89, 90, 91, 87, 92]); // 4/5 meet 88
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    // The just-completed session's own gating already happened against 88
    // BEFORE orchestration ever runs (proven at the controller level — see
    // tests/recordLetterCompletionOrchestration.test.js's ordering test).
    // Here we prove the SERVICE side: orchestration itself creates 93...
    const orchestrationResult = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });
    expect(orchestrationResult.status).toBe('automatic_created');
    expect(orchestrationResult.newThreshold).toBe(93);

    // ...and only a LATER, separate resolver call sees the new value.
    familyTargetsFixture.curved = makeHistoryRow({ id: 4, scope_key: 'curved', baseline_family: 'curved', source: 'automatic', new_threshold: 93 });
    const laterResolution = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });
    expect(laterResolution.currentThreshold).toBe(93);
  });
});

describe('Section 37 — incomplete window (2 existing + 1 new = 3/5)', () => {
  it('insufficient_data, no automatic history row', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([79, 77, 85]); // 3/5

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('insufficient_data');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

describe('Section 38 — completed window raise (exact spec numbers)', () => {
  it('latest 5 = [92,89,90,91,87], target 88, 4/5 meet -> automatic 88 -> 93, exactly one row', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([92, 89, 90, 91, 87]); // newest-first, matches spec order
    mockThBulkCreate.mockImplementationOnce(echoBulkCreate());

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('automatic_created');
    expect(result.newThreshold).toBe(93);
    expect(mockThBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockThBulkCreate.mock.calls[0][0]).toHaveLength(1); // exactly one family's row
  });
});

describe('Section 39 — hold (exact spec numbers)', () => {
  it('latest 5 = [90,89,80,79,78], target 88, 2/5 meet -> hold, no insert', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 89, 80, 79, 78]);

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('hold');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

describe('Section 40 — support_review (exact spec numbers)', () => {
  it('latest 5 = [89,80,79,78,77], target 88, 1/5 meet -> support_review, no threshold change', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([89, 80, 79, 78, 77]);

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('support_review');
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

describe('Section 41 — teacher override integration (would-otherwise-raise scenario)', () => {
  it('teacher_override=85 blocks the automatic event; current remains 85', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 9, scope_key: 'curved', baseline_family: 'curved', source: 'teacher_override', new_threshold: 85 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]); // would be 5/5 raise if unprotected

    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true });

    expect(result.status).toBe('teacher_protected');
    expect(mockThBulkCreate).not.toHaveBeenCalled();

    const current = await getCurrentFamilyThreshold({ studentId: 13, family: 'curved' });
    expect(current.currentThreshold).toBe(85);
  });
});

describe('Section 42 — explicit request override skips automatic adaptation', () => {
  it('a non-null requestedQualityThreshold skips evaluation entirely, before even determining the family', async () => {
    familyTargetsFixture.curved = makeHistoryRow({ id: 2, scope_key: 'curved', baseline_family: 'curved', new_threshold: 88 });
    familyRowsFixture.curved = makeScoredAttempts([90, 91, 92, 93, 94]); // would otherwise raise

    const result = await processDynamicThresholdAfterLetterSession({
      studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: true, requestedQualityThreshold: 75,
    });

    expect(result).toEqual({ status: 'skipped_request_override', family: null, decision: null, newThreshold: null, historyId: null });
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThBulkCreate).not.toHaveBeenCalled();
  });
});

describe('Section 5 — no attempt-3 evidence skips evaluation', () => {
  it('hasAttempt3Evidence=false -> not_applicable, no DB queries', async () => {
    const result = await processDynamicThresholdAfterLetterSession({ studentId: 13, letter: 'c', caseType: 'lowercase', hasAttempt3Evidence: false });

    expect(result.status).toBe('not_applicable');
    expect(mockLaFindAll).not.toHaveBeenCalled();
  });
});

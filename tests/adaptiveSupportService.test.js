'use strict';

// Feature 3 Step 4 — adaptiveSupportService tests. Mocks only ../src/models
// (LetterAttempt's findAll/count, plus create/bulkCreate/update/destroy
// stand-ins that exist ONLY so the read-only-guarantee suite can assert
// they are never called) — getBaselineFamily, deriveAttemptPerformanceScore,
// and resolveAttemptSupportLevel are all real/unmocked, proving the actual
// composition this service relies on, matching
// tests/dynamicThresholdService.test.js's own established convention.
const mockLaFindAll    = jest.fn();
const mockLaCount      = jest.fn();
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();
const mockLaSave       = jest.fn();
const mockTransaction  = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll:    (...a) => mockLaFindAll(...a),
    count:      (...a) => mockLaCount(...a),
    create:     mockLaCreate,
    bulkCreate: mockLaBulkCreate,
    update:     mockLaUpdate,
    destroy:    mockLaDestroy,
    save:       mockLaSave,
  },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const { Op } = require('sequelize'); // real — only ../src/models is mocked above

const { getSupportPerformanceByFamily, SUPPORT_PERFORMANCE_WINDOW_SIZE } = require('../src/services/adaptiveSupportService');

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Builds a `features` object whose reconstructed performanceScore is EXACTLY
// `score` — same proven formula as tests/dynamicThresholdService.test.js's
// own featuresForScore() (dtw_distance solved from the inverse of
// reconstructScoreFromFeatures with smoothness fixed at 0).
function featuresForScore(score) {
  const dtw = (45 * (100 - score)) / 70;
  return { smoothness: 0, dtw_distance: dtw, pauseCount: 0, strokeCount: 1, completionTime: 1000 };
}

function row(overrides = {}) {
  return {
    id: 1,
    student_id: 13,
    letter: 'o',            // reviewed → curved
    case_type: 'lowercase',
    session_key: 'session-1',
    attempt_number: 1,
    support_level: null,
    collection_mode: false,
    capture_status: 'complete',
    features: featuresForScore(80), motor_score: 80,
    created_at: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

function mockRows(rows) {
  mockLaFindAll.mockResolvedValueOnce(rows);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaCount.mockResolvedValue(0); // default: no collection/invalid-capture exclusions
});

// ─── Family/support window tests (11–24) ───────────────────────────────────

describe('Window Test 11 — high curved attempts go only to curved/high', () => {
  it('a curved attempt-1 (proxy high) row lands in curved.high and nowhere else', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1 })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(1);
    expect(result.families.curved.medium.count).toBe(0);
    expect(result.families.curved.low.count).toBe(0);
  });
});

describe('Window Test 12 — medium curved attempts go only to curved/medium', () => {
  it('a curved attempt-2 (proxy medium) row lands in curved.medium and nowhere else', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 2 })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.medium.count).toBe(1);
    expect(result.families.curved.high.count).toBe(0);
    expect(result.families.curved.low.count).toBe(0);
  });
});

describe('Window Test 13 — low curved attempts go only to curved/low', () => {
  it('a curved attempt-3 (proxy low) row lands in curved.low and nowhere else', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 3 })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.low.count).toBe(1);
    expect(result.families.curved.high.count).toBe(0);
    expect(result.families.curved.medium.count).toBe(0);
  });
});

describe('Window Test 14 — straight/curved/complex isolated', () => {
  it('one row per family lands only in its own family, never bleeding into another', async () => {
    mockRows([
      row({ id: 1, letter: 'l', case_type: 'lowercase', session_key: 's1', attempt_number: 1 }), // straight
      row({ id: 2, letter: 'o', case_type: 'lowercase', session_key: 's2', attempt_number: 1 }), // curved
      row({ id: 3, letter: 'v', case_type: 'lowercase', session_key: 's3', attempt_number: 1 }), // complex
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.straight.high.count).toBe(1);
    expect(result.families.curved.high.count).toBe(1);
    expect(result.families.complex.high.count).toBe(1);

    expect(result.families.straight.high.attempts[0].letter).toBe('l');
    expect(result.families.curved.high.attempts[0].letter).toBe('o');
    expect(result.families.complex.high.attempts[0].letter).toBe('v');
  });
});

describe('Window Test 15 — explicit future adaptive example: attempt_number=1 + support_level=medium → medium window', () => {
  it('does not land in the high window despite attempt_number=1', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1, support_level: 'medium' })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.medium.count).toBe(1);
    expect(result.families.curved.medium.attempts[0].supportSource).toBe('explicit_support_level');
    expect(result.families.curved.high.count).toBe(0);
  });
});

describe('Window Test 16 — ambiguous letter excluded', () => {
  it('an unmapped/ambiguous letter (e.g. lowercase "a") contributes to no family window and is counted as unmappedLetter', async () => {
    mockRows([row({ id: 1, letter: 'a', case_type: 'lowercase', attempt_number: 1 })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    for (const family of ['straight', 'curved', 'complex']) {
      for (const level of ['high', 'medium', 'low']) {
        expect(result.families[family][level].count).toBe(0);
      }
    }
    expect(result.exclusions.unmappedLetter).toBe(1);
  });
});

describe('Window Test 17 — collection row excluded', () => {
  it('the candidate query itself filters collection_mode: false', async () => {
    mockRows([]);
    await getSupportPerformanceByFamily({ studentId: 13 });

    expect(mockLaFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ collection_mode: false, capture_status: 'complete' }),
    }));
  });

  it('defense in depth: a collection-mode row with no explicit support_level that somehow reaches the service is still excluded (never guessed via the attempt proxy)', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1, collection_mode: true, support_level: null })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(0);
    expect(result.exclusions.invalidSupport).toBe(1);
  });
});

describe('Window Test 18 — failed performance still included', () => {
  it('a low/poor score (valid features, bad performance) is still counted as evidence, not filtered out', async () => {
    // featuresForScore round-trips exactly only for score >= 30 (below that
    // the DTW_CAP saturates the formula — same documented caveat as
    // tests/dynamicThresholdService.test.js's identical helper). 35 is
    // still a clearly poor/"failed" score, well below any plausible
    // passing threshold, while still round-tripping exactly.
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1, features: featuresForScore(35), motor_score: 35 })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(1);
    expect(result.families.curved.high.attempts[0].performanceScore).toBe(35);
  });
});

describe('Window Test 19 — malformed features excluded', () => {
  it('a row with non-numeric/missing feature data is excluded and counted as malformedFeatures', async () => {
    // motor_score: null — the authoritative-domain equivalent of "no usable
    // normalized features at ingest time" (the now-retired featuresToScore()
    // mirror's own 'malformed' outcome).
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1, motor_score: null })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(0);
    expect(result.exclusions.malformedFeatures).toBe(1);
  });

  it('a row with features: null is excluded and counted as malformedFeatures', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1, features: null, motor_score: null })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(0);
    expect(result.exclusions.malformedFeatures).toBe(1);
  });
});

describe('Window Test 20 — exactly 5 → complete', () => {
  it('windowComplete is true at exactly windowSize', async () => {
    mockRows([1, 2, 3, 4, 5].map(i => row({
      id: i, letter: 'o', attempt_number: 1, session_key: `s${i}`,
      created_at: new Date(2026, 0, 10 - i),
    })));
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(5);
    expect(result.families.curved.high.windowComplete).toBe(true);
  });
});

describe('Window Test 21 — 3 → incomplete', () => {
  it('windowComplete is false below windowSize, with no error', async () => {
    mockRows([1, 2, 3].map(i => row({
      id: i, letter: 'o', attempt_number: 1, session_key: `s${i}`,
      created_at: new Date(2026, 0, 10 - i),
    })));
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(3);
    expect(result.families.curved.high.windowComplete).toBe(false);
    expect(result.status).toBe('found'); // no error
  });
});

describe('Window Test 22 — more than 5 → newest 5 kept', () => {
  it('only the 5 newest rows (by the given, already newest-first order) are retained', async () => {
    // 7 rows, ids 1..7, created newest(id7)→oldest(id1) — fed pre-sorted
    // newest-first, exactly as the real ORDER BY created_at DESC, id DESC
    // would return them.
    const rows = [7, 6, 5, 4, 3, 2, 1].map(i => row({
      id: i, letter: 'o', attempt_number: 1, session_key: `s${i}`,
      created_at: new Date(2026, 0, i),
    }));
    mockRows(rows);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(5);
    expect(result.families.curved.high.windowComplete).toBe(true);
    expect(result.families.curved.high.attempts.map(a => a.attemptId)).toEqual([7, 6, 5, 4, 3]);
  });
});

describe('Window Test 23 — created_at + id deterministic order is preserved, not re-sorted', () => {
  it('two rows with an identical created_at (tie-broken by id DESC, as the DB query already provides) keep the order they were given in', async () => {
    const tiedTimestamp = new Date('2026-08-05T12:00:00.000Z');
    mockRows([
      row({ id: 20, letter: 'o', attempt_number: 1, session_key: 's-newer-id', created_at: tiedTimestamp }),
      row({ id: 10, letter: 'o', attempt_number: 1, session_key: 's-older-id', created_at: tiedTimestamp }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.attempts.map(a => a.attemptId)).toEqual([20, 10]);
  });

  it('the query itself requests ORDER BY created_at DESC, id DESC', async () => {
    mockRows([]);
    await getSupportPerformanceByFamily({ studentId: 13 });

    expect(mockLaFindAll).toHaveBeenCalledWith(expect.objectContaining({
      order: [['created_at', 'DESC'], ['id', 'DESC']],
    }));
  });
});

describe('Window Test 24 — no attempts → empty windows', () => {
  it('every family/support window is empty with null aggregates, not an error', async () => {
    mockRows([]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.status).toBe('found');
    for (const family of ['straight', 'curved', 'complex']) {
      for (const level of ['high', 'medium', 'low']) {
        const w = result.families[family][level];
        expect(w).toEqual({ count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null });
      }
    }
    expect(result.supportSourceCounts).toEqual({ explicit: 0, historicalProxy: 0 });
  });
});

// ─── Deduplication tests (25–29) ────────────────────────────────────────────

describe('Dedup Test 25 — same session + same attempt_number duplicate → counted once', () => {
  it('two rows sharing session_key AND attempt_number collapse to one retained attempt', async () => {
    mockRows([
      row({ id: 2, letter: 'o', attempt_number: 1, session_key: 'dup-session', created_at: new Date('2026-08-05T10:00:01.000Z') }),
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 'dup-session', created_at: new Date('2026-08-05T10:00:00.000Z') }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(1);
    expect(result.exclusions.duplicateAttempt).toBe(1);
  });
});

describe('Dedup Test 26 — same session attempt 1/2/3 → all three retained', () => {
  it('a normal legitimate session (one row per attempt_number, shared session_key) is NOT collapsed by session_key alone', async () => {
    mockRows([
      row({ id: 3, letter: 'o', attempt_number: 3, session_key: 'session-abc', created_at: new Date('2026-08-05T10:00:03.000Z') }),
      row({ id: 2, letter: 'o', attempt_number: 2, session_key: 'session-abc', created_at: new Date('2026-08-05T10:00:02.000Z') }),
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 'session-abc', created_at: new Date('2026-08-05T10:00:01.000Z') }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(1);
    expect(result.families.curved.medium.count).toBe(1);
    expect(result.families.curved.low.count).toBe(1);
    expect(result.exclusions.duplicateAttempt).toBe(0);
  });
});

describe('Dedup Test 27 — same session, same support, different attempt numbers → both retained', () => {
  it('an explicit-support future-adaptive session with two different attempt numbers sharing one support level are both kept, not deduped', async () => {
    mockRows([
      row({ id: 2, letter: 'o', attempt_number: 2, session_key: 'session-adaptive', support_level: 'medium', created_at: new Date('2026-08-05T10:00:02.000Z') }),
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 'session-adaptive', support_level: 'medium', created_at: new Date('2026-08-05T10:00:01.000Z') }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.medium.count).toBe(2);
    expect(result.exclusions.duplicateAttempt).toBe(0);
  });
});

describe('Dedup Test 28 — duplicate newest/oldest deterministic winner', () => {
  it('the NEWEST of two duplicate rows (session_key + attempt_number) is the one retained', async () => {
    mockRows([
      row({ id: 99, letter: 'o', attempt_number: 1, session_key: 'dup-session', features: featuresForScore(90), motor_score: 90, created_at: new Date('2026-08-05T10:00:02.000Z') }), // newer
      row({ id: 1,  letter: 'o', attempt_number: 1, session_key: 'dup-session', features: featuresForScore(40), motor_score: 40, created_at: new Date('2026-08-05T10:00:01.000Z') }), // older
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    expect(result.families.curved.high.count).toBe(1);
    expect(result.families.curved.high.attempts[0].attemptId).toBe(99);
    expect(result.families.curved.high.attempts[0].performanceScore).toBe(90);
  });
});

describe('Dedup Test 29 — duplicate anomaly does not inflate the average', () => {
  it('averageScore is computed only from the deduped, unique attempts', async () => {
    mockRows([
      row({ id: 3, letter: 'o', attempt_number: 1, session_key: 'dup-session', features: featuresForScore(90), motor_score: 90, created_at: new Date('2026-08-05T10:00:03.000Z') }), // dup winner
      row({ id: 2, letter: 'o', attempt_number: 1, session_key: 'dup-session', features: featuresForScore(10), motor_score: 10, created_at: new Date('2026-08-05T10:00:02.000Z') }), // dup loser — must NOT count
      row({ id: 1, letter: 'o', attempt_number: 2, session_key: 'other-session', features: featuresForScore(70), motor_score: 70, created_at: new Date('2026-08-05T10:00:01.000Z') }), // different bucket (medium)
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });

    // curved.high has exactly ONE unique attempt (score 90) — the duplicate
    // (score 10) must never be averaged in.
    expect(result.families.curved.high.count).toBe(1);
    expect(result.families.curved.high.averageScore).toBe(90);
    expect(result.exclusions.duplicateAttempt).toBe(1);
  });
});

// ─── Aggregate statistics tests (30–36) ─────────────────────────────────────

describe('Aggregate Test 30 — correct average', () => {
  it('averages exactly the included scores', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 's1', features: featuresForScore(70), motor_score: 70, created_at: new Date(2026, 0, 3) }),
      row({ id: 2, letter: 'o', attempt_number: 1, session_key: 's2', features: featuresForScore(90), motor_score: 90, created_at: new Date(2026, 0, 2) }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.families.curved.high.averageScore).toBe(80);
  });
});

describe('Aggregate Test 31 — correct min', () => {
  it('minScore is the lowest included score', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 's1', features: featuresForScore(70), motor_score: 70 }),
      row({ id: 2, letter: 'o', attempt_number: 1, session_key: 's2', features: featuresForScore(90), motor_score: 90 }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.families.curved.high.minScore).toBe(70);
  });
});

describe('Aggregate Test 32 — correct max', () => {
  it('maxScore is the highest included score', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 's1', features: featuresForScore(70), motor_score: 70 }),
      row({ id: 2, letter: 'o', attempt_number: 1, session_key: 's2', features: featuresForScore(90), motor_score: 90 }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.families.curved.high.maxScore).toBe(90);
  });
});

describe('Aggregate Test 33 — empty → null aggregates, never 0', () => {
  it('averageScore/minScore/maxScore are null, not 0, when count is 0', async () => {
    mockRows([]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    const w = result.families.straight.high;
    expect(w.count).toBe(0);
    expect(w.averageScore).toBeNull();
    expect(w.minScore).toBeNull();
    expect(w.maxScore).toBeNull();
  });
});

describe('Aggregate Test 34 — one value handled correctly', () => {
  it('average/min/max all equal the single included score', async () => {
    mockRows([row({ id: 1, letter: 'o', attempt_number: 1, features: featuresForScore(77), motor_score: 77 })]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    const w = result.families.curved.high;
    expect(w.count).toBe(1);
    expect(w.averageScore).toBe(77);
    expect(w.minScore).toBe(77);
    expect(w.maxScore).toBe(77);
  });
});

describe('Aggregate Test 35 — historical source count', () => {
  it('supportSourceCounts.historicalProxy tallies every proxy-resolved attempt across all windows', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 's1' }), // proxy
      row({ id: 2, letter: 'o', attempt_number: 2, session_key: 's1' }), // proxy
      row({ id: 3, letter: 'o', attempt_number: 3, session_key: 's1' }), // proxy
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.supportSourceCounts.historicalProxy).toBe(3);
    expect(result.supportSourceCounts.explicit).toBe(0);
  });
});

describe('Aggregate Test 36 — explicit source count', () => {
  it('supportSourceCounts.explicit tallies every explicitly-resolved attempt across all windows', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 's1', support_level: 'high' }),
      row({ id: 2, letter: 'o', attempt_number: 2, session_key: 's1', support_level: 'medium' }),
      row({ id: 3, letter: 'l', case_type: 'lowercase', attempt_number: 3, session_key: 's2', support_level: 'low' }),
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.supportSourceCounts.explicit).toBe(3);
    expect(result.supportSourceCounts.historicalProxy).toBe(0);
  });

  it('a mixed explicit + proxy dataset tallies both correctly', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1, session_key: 's1', support_level: 'high' }), // explicit
      row({ id: 2, letter: 'o', attempt_number: 2, session_key: 's2' }),                          // proxy
    ]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.supportSourceCounts).toEqual({ explicit: 1, historicalProxy: 1 });
  });
});

// ─── Input validation (window size / student id) ───────────────────────────

describe('Input validation — studentId', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 'abc', null, undefined])(
    'rejects invalid studentId %j with status invalid_input',
    async (badId) => {
      const result = await getSupportPerformanceByFamily({ studentId: badId });
      expect(result.status).toBe('invalid_input');
      expect(mockLaFindAll).not.toHaveBeenCalled();
    }
  );
});

describe('Input validation — windowSize', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 'abc'])(
    'rejects invalid windowSize %j with status invalid_window_size',
    async (badSize) => {
      const result = await getSupportPerformanceByFamily({ studentId: 13, windowSize: badSize });
      expect(result.status).toBe('invalid_window_size');
      expect(mockLaFindAll).not.toHaveBeenCalled();
    }
  );

  it('defaults to SUPPORT_PERFORMANCE_WINDOW_SIZE (5) when omitted', async () => {
    mockRows([]);
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.windowSize).toBe(SUPPORT_PERFORMANCE_WINDOW_SIZE);
    expect(SUPPORT_PERFORMANCE_WINDOW_SIZE).toBe(5);
  });

  it('accepts a positive integer override', async () => {
    mockRows([]);
    const result = await getSupportPerformanceByFamily({ studentId: 13, windowSize: 8 });
    expect(result.windowSize).toBe(8);
  });
});

describe('Read failure handling', () => {
  it('a thrown query error resolves to status read_failed, never throws', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('connection lost'));
    const result = await getSupportPerformanceByFamily({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expect(result.families).toBeNull();
  });
});

// ─── Read-only guarantee (§35) ──────────────────────────────────────────────

describe('getSupportPerformanceByFamily — read-only guarantee', () => {
  it('never calls create/bulkCreate/update/destroy/save on LetterAttempt, and never opens a transaction', async () => {
    mockRows([
      row({ id: 1, letter: 'o', attempt_number: 1 }),
      row({ id: 2, letter: 'l', case_type: 'lowercase', attempt_number: 2, session_key: 's2' }),
      row({ id: 3, letter: 'a', case_type: 'lowercase', attempt_number: 3, session_key: 's3' }), // ambiguous
    ]);

    await getSupportPerformanceByFamily({ studentId: 13 });

    expect(mockLaCreate).not.toHaveBeenCalled();
    expect(mockLaBulkCreate).not.toHaveBeenCalled();
    expect(mockLaUpdate).not.toHaveBeenCalled();
    expect(mockLaDestroy).not.toHaveBeenCalled();
    expect(mockLaSave).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('only ever calls LetterAttempt.findAll and LetterAttempt.count — no other model method', async () => {
    mockRows([]);
    await getSupportPerformanceByFamily({ studentId: 13 });

    expect(mockLaFindAll).toHaveBeenCalled();
    expect(mockLaCount).toHaveBeenCalled();
  });

  it('the module source (excluding comments) never references bulkCreate or opens a transaction', () => {
    // Narrowed at Feature 3 Step 5: this file now ALSO exports
    // evaluateSupportRecommendations(), which legitimately imports Feature
    // 2's getCurrentFamilyThreshold() (read-only reference — see that
    // function's own tests/adaptiveSupportServiceRecommendation.test.js for
    // the precise, correctly-scoped checks: it must never consume Feature
    // 2's ephemeral dynamicThresholdStatus/support_review signal, and must
    // never write). 'support_review' is also no longer banned here — it is
    // Step 5's own decision vocabulary value now, not just a hypothetical
    // future reference. bulkCreate/transaction remain correctly banned
    // file-wide: nothing in this file ever writes, in Step 4 or Step 5.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/adaptiveSupportService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.transaction\(/);
  });
});

'use strict';

// Feature 7 Step 2 — persistentDifficultyEvidence.js pure-helper tests.
// Covers spec items 11-63 (outcome reconstruction, cycle reconstruction,
// window construction, persistence evaluation, affected letters). All
// tests here exercise pure functions only — no DB, no mocks needed for the
// bulk of this file (fetchCandidateCycles' own read-only guarantee is
// covered separately in persistentDifficultyEvidenceReadOnly.test.js).

const {
  reconstructCycleOutcome,
  dedupeCompletedCycles,
  buildFamilyCaseEvidence,
  splitLongitudinalWindows,
  evaluateDifficultyWindow,
  evaluateTemporalSeparation,
  evaluatePersistentDifficultyWindows,
  summarizeAffectedLetters,
} = require('../src/services/persistentDifficultyEvidence');
const { MIN_WINDOW_SEPARATION_MS, PERSISTENT_DIFFICULTY_STATUSES, PERSISTENT_DIFFICULTY_REASONS } = require('../src/config/persistentDifficultyPolicy');

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(base, offsetMs) {
  return new Date(base + offsetMs).toISOString();
}

// ─── §59 Tests 11-20 — outcome reconstruction ──────────────────────────────

describe('Test 11 — score > threshold -> success', () => {
  it('90 vs 55', () => {
    expect(reconstructCycleOutcome({ best_score: 90, threshold: 55 })).toBe('success');
  });
});

describe('Test 12 — score = threshold -> success', () => {
  it('55 vs 55 (>=, not >)', () => {
    expect(reconstructCycleOutcome({ best_score: 55, threshold: 55 })).toBe('success');
  });
});

describe('Test 13 — score < threshold -> failure', () => {
  it('27 vs 55', () => {
    expect(reconstructCycleOutcome({ best_score: 27, threshold: 55 })).toBe('failure');
  });
});

describe('Test 14 — score/threshold unavailable + threshold_passed true -> success (fallback)', () => {
  it('null score/threshold, threshold_passed=true', () => {
    expect(reconstructCycleOutcome({ best_score: null, threshold: null, threshold_passed: true })).toBe('success');
  });
});

describe('Test 15 — fallback false -> failure', () => {
  it('null score/threshold, threshold_passed=false', () => {
    expect(reconstructCycleOutcome({ best_score: null, threshold: null, threshold_passed: false })).toBe('failure');
  });
});

describe('Test 16 — no usable evidence -> unknown, never a silent failure', () => {
  it('everything null', () => {
    expect(reconstructCycleOutcome({ best_score: null, threshold: null, threshold_passed: null })).toBe('unknown');
  });

  it('everything undefined / empty object', () => {
    expect(reconstructCycleOutcome({})).toBe('unknown');
    expect(reconstructCycleOutcome()).toBe('unknown');
  });
});

describe('Test 17 — numeric strings never coerced (project convention: typeof, never parseFloat)', () => {
  it('string best_score/threshold are rejected, falling through to unknown when no threshold_passed fallback exists', () => {
    expect(reconstructCycleOutcome({ best_score: '90', threshold: '55' })).toBe('unknown');
  });

  it('string values fall through to the threshold_passed fallback when present', () => {
    expect(reconstructCycleOutcome({ best_score: '90', threshold: '55', threshold_passed: true })).toBe('success');
  });
});

describe('Test 18 — NaN rejected', () => {
  it('NaN best_score never treated as a valid, comparable number', () => {
    expect(reconstructCycleOutcome({ best_score: NaN, threshold: 55 })).toBe('unknown');
    expect(reconstructCycleOutcome({ best_score: NaN, threshold: 55, threshold_passed: false })).toBe('failure');
  });
});

describe('Test 19 — Infinity rejected', () => {
  it('Infinity best_score/threshold never treated as a valid, comparable number', () => {
    expect(reconstructCycleOutcome({ best_score: Infinity, threshold: 55 })).toBe('unknown');
    expect(reconstructCycleOutcome({ best_score: 90, threshold: -Infinity })).toBe('unknown');
  });
});

describe('Test 20 — current family target never used', () => {
  it('the file never imports getCurrentFamilyThreshold/evaluateDynamicThresholds/evaluateSupportRecommendations in actual code', () => {
    // Scoped to require()/import lines only — the module's own header
    // comment legitimately DISCUSSES these excluded functions by name
    // (documenting the non-circularity decision), which would otherwise be
    // a false positive on a bare substring match, the same pitfall caught
    // repeatedly throughout this project.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const requireLines = source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
    expect(requireLines).not.toMatch(/dynamicThresholdService|adaptiveSupportService/);
  });

  it('outcome depends only on the row\'s own fields — the same row/threshold pair always yields the same outcome regardless of any external state', () => {
    const row = { best_score: 60, threshold: 55 };
    expect(reconstructCycleOutcome(row)).toBe(reconstructCycleOutcome({ ...row }));
  });
});

// ─── §60 Tests 21-29 — cycle reconstruction ────────────────────────────────

function attempt(overrides = {}) {
  return {
    id: 1, student_id: 13, letter: 'c', case_type: 'lowercase',
    session_key: 'sess-1', attempt_number: 3, collection_mode: false, capture_status: 'complete',
    best_score: 90, threshold: 55, threshold_passed: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Test 21 — valid complete attempt-3 cycle accepted', () => {
  it('a well-formed candidate row produces exactly one cycle', () => {
    const result = buildFamilyCaseEvidence({ attempts: [attempt()], caseType: 'lowercase', family: 'curved' });
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].outcome).toBe('success');
  });
});

describe('Test 22 — collection excluded', () => {
  it('a collection_mode=true row never contributes a cycle, even if letter/case/family otherwise match', () => {
    const result = buildFamilyCaseEvidence({
      attempts: [attempt({ collection_mode: true })], caseType: 'lowercase', family: 'curved',
    });
    expect(result.cycles).toHaveLength(0);
    expect(result.nonCandidateExcludedCount).toBe(1);
  });
});

describe('Test 23 — incomplete excluded', () => {
  it('a capture_status !== complete row is excluded', () => {
    const result = buildFamilyCaseEvidence({
      attempts: [attempt({ capture_status: 'incomplete' })], caseType: 'lowercase', family: 'curved',
    });
    expect(result.cycles).toHaveLength(0);
    expect(result.nonCandidateExcludedCount).toBe(1);
  });

  it('a non-attempt-3 row is excluded', () => {
    const result = buildFamilyCaseEvidence({
      attempts: [attempt({ attempt_number: 1 })], caseType: 'lowercase', family: 'curved',
    });
    expect(result.cycles).toHaveLength(0);
  });
});

describe('Test 24 — duplicate session deduped', () => {
  it('two rows sharing session_key collapse to one cycle — the newest wins', () => {
    const older = attempt({ id: 1, session_key: 'dup', created_at: '2026-01-01T00:00:00.000Z', best_score: 40 });
    const newer = attempt({ id: 2, session_key: 'dup', created_at: '2026-01-02T00:00:00.000Z', best_score: 90 });
    const result = buildFamilyCaseEvidence({ attempts: [older, newer], caseType: 'lowercase', family: 'curved' });
    expect(result.cycles).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.cycles[0].attemptId).toBe(2); // newest wins
  });
});

describe('Test 25 — malformed duplicate selection is deterministic', () => {
  it('running the same duplicate input twice always selects the same canonical row', () => {
    const rows = [
      attempt({ id: 1, session_key: 'dup', created_at: '2026-01-01T00:00:00.000Z' }),
      attempt({ id: 2, session_key: 'dup', created_at: '2026-01-01T00:00:00.000Z' }), // same timestamp — id tiebreak
    ];
    const first = dedupeCompletedCycles(rows);
    const second = dedupeCompletedCycles([...rows]);
    expect(first.cycles[0].id).toBe(second.cycles[0].id);
    expect(first.cycles[0].id).toBe(2); // id DESC tiebreak — mirrors Feature 2's own rule
  });
});

describe('Test 26 — ambiguous letter excluded', () => {
  it('letter "a" (lowercase, ambiguous per getBaselineFamily) never contributes a cycle to any family', () => {
    const result = buildFamilyCaseEvidence({
      attempts: [attempt({ letter: 'a' })], caseType: 'lowercase', family: 'curved',
    });
    expect(result.cycles).toHaveLength(0);
    expect(result.ambiguousExcludedCount).toBe(1);
  });
});

describe('Test 27 — lowercase/uppercase not mixed', () => {
  it('an uppercase C row never contributes to a lowercase evidence stream, even though both map to curved', () => {
    const result = buildFamilyCaseEvidence({
      attempts: [attempt({ letter: 'C', case_type: 'uppercase' })], caseType: 'lowercase', family: 'curved',
    });
    expect(result.cycles).toHaveLength(0);
    expect(result.otherCaseExcludedCount).toBe(1);
  });

  it('requesting uppercase correctly picks up the uppercase row', () => {
    const result = buildFamilyCaseEvidence({
      attempts: [attempt({ letter: 'C', case_type: 'uppercase' })], caseType: 'uppercase', family: 'curved',
    });
    expect(result.cycles).toHaveLength(1);
  });
});

describe('Test 28 — family mapping uses getBaselineFamily, no second taxonomy', () => {
  it('the evidence file never imports letterCategories.js or letterMotorPrimitives.js', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    expect(source).not.toMatch(/letterCategories|letterMotorPrimitives/);
    expect(source).toMatch(/getBaselineFamily/);
  });
});

describe('Test 29 — chronological ordering stable', () => {
  it('cycles are returned oldest-first regardless of input order', () => {
    const a = attempt({ id: 1, session_key: 's1', created_at: '2026-01-03T00:00:00.000Z' });
    const b = attempt({ id: 2, session_key: 's2', created_at: '2026-01-01T00:00:00.000Z' });
    const c = attempt({ id: 3, session_key: 's3', created_at: '2026-01-02T00:00:00.000Z' });
    const result = buildFamilyCaseEvidence({ attempts: [a, b, c], caseType: 'lowercase', family: 'curved' });
    expect(result.cycles.map(cy => cy.sessionKey)).toEqual(['s2', 's3', 's1']);
  });
});

// ─── §61 Tests 30-38 — window construction ─────────────────────────────────

function usableCycle(offsetMs, outcome = 'success') {
  return { letter: 'c', outcome, createdAt: iso(0, offsetMs) };
}

describe('Test 30 — <5 no complete recent window', () => {
  it('4 usable cycles never produce a complete window', () => {
    const cycles = [0, 1, 2, 3].map((i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('insufficient');
    expect(result.earlierWindow).toBeNull();
    expect(result.recentWindow).toBeNull();
  });
});

describe('Test 31 — 5 provides only one usable set, still insufficient for TWO windows', () => {
  it('5 usable cycles is not enough to build both earlier and recent windows', () => {
    const cycles = [0, 1, 2, 3, 4].map((i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('insufficient');
    expect(result.usableCount).toBe(5);
  });
});

describe('Test 32 — 9 insufficient', () => {
  it('9 usable cycles remains insufficient (need 10)', () => {
    const cycles = Array.from({ length: 9 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('insufficient');
  });
});

describe('Test 33 — 10 produces exactly two windows', () => {
  it('10 usable cycles split into earlierWindow (first 5) and recentWindow (last 5)', () => {
    const cycles = Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('ok');
    expect(result.earlierWindow).toHaveLength(5);
    expect(result.recentWindow).toHaveLength(5);
  });
});

describe('Test 34 — 11 uses latest 10 usable cycles', () => {
  it('the oldest of 11 usable cycles is dropped entirely', () => {
    const cycles = Array.from({ length: 11 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('ok');
    // The oldest (offset 0) must not appear in either window.
    const allUsed = [...result.earlierWindow, ...result.recentWindow];
    expect(allUsed).toHaveLength(10);
    expect(allUsed.some((c) => c.createdAt === iso(0, 0))).toBe(false);
  });
});

describe('Test 35 — windows never overlap', () => {
  it('earlierWindow and recentWindow share zero cycles by identity', () => {
    const cycles = Array.from({ length: 12 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    const earlierSet = new Set(result.earlierWindow.map((c) => c.createdAt));
    const overlap = result.recentWindow.filter((c) => earlierSet.has(c.createdAt));
    expect(overlap).toHaveLength(0);
  });
});

describe('Test 36 — earlier is chronologically before recent', () => {
  it('every earlierWindow cycle predates every recentWindow cycle', () => {
    const cycles = Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    const maxEarlier = Math.max(...result.earlierWindow.map((c) => new Date(c.createdAt).getTime()));
    const minRecent = Math.min(...result.recentWindow.map((c) => new Date(c.createdAt).getTime()));
    expect(maxEarlier).toBeLessThan(minRecent);
  });
});

describe('Test 37 — unknown outcomes skipped', () => {
  it('an "unknown" cycle never occupies one of the 10 required slots', () => {
    const cycles = [
      ...Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS)),
      { letter: 'c', outcome: 'unknown', createdAt: iso(0, 10 * DAY_MS) },
    ];
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('ok');
    expect(result.unknownCount).toBe(1);
    const allOutcomes = [...result.earlierWindow, ...result.recentWindow].map((c) => c.outcome);
    expect(allOutcomes).not.toContain('unknown');
  });
});

describe('Test 38 — replacement older cycles used where appropriate', () => {
  it('an unknown cycle interleaved among the most recent 11 is skipped in favor of the next-older usable cycle', () => {
    const cycles = [
      ...Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS)), // offsets 0-9, all usable
      { letter: 'c', outcome: 'unknown', createdAt: iso(0, 10 * DAY_MS) }, // offset 10 — unknown, skipped
      usableCycle(11 * DAY_MS), // offset 11 — usable, becomes part of the "latest 10"
    ];
    const result = splitLongitudinalWindows(cycles);
    expect(result.status).toBe('ok');
    // usable count = 11 (10 + the offset-11 one); latest 10 usable = offsets 1..9 and 11 (offset 0 dropped).
    const allUsed = [...result.earlierWindow, ...result.recentWindow];
    expect(allUsed.some((c) => c.createdAt === iso(0, 11 * DAY_MS))).toBe(true);
    expect(allUsed.some((c) => c.createdAt === iso(0, 0))).toBe(false);
  });
});

// ─── Window SELECTION — trailing-burst regression (C1) ─────────────────────
//
// Reproduces the live student-10 shape: months of well-separated practice
// whose most recent cycles land in a single sitting. Before the fix,
// splitLongitudinalWindows() considered only the newest 10 usable cycles, so
// the earlier/recent boundary fell inside that sitting and the 24h rule could
// never be satisfied — reported as insufficient_temporal_dispersion despite
// dozens of separated cycles.

const MIN_ID = 5; // WINDOW_SIZE, restated locally to keep these tests self-describing

/** N cycles spaced `stepMs` apart, starting at `startMs`. */
function burst(startMs, count, { stepMs = 15_000, outcome = 'success' } = {}) {
  return Array.from({ length: count }, (_, i) => usableCycle(startMs + i * stepMs, outcome));
}

describe('C1 Test A — trailing burst no longer defeats the separation rule', () => {
  it('selects an older, genuinely separated window instead of reporting insufficient dispersion', () => {
    // 10 well-separated cycles (one per day), then 6 more in one sitting.
    const cycles = [
      ...Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS)),
      ...burst(20 * DAY_MS, 6),
    ];
    const result = splitLongitudinalWindows(cycles);

    expect(result.status).toBe('ok');
    expect(result.separationSatisfied).toBe(true);
    expect(result.earlierWindow).toHaveLength(MIN_ID);
    expect(result.recentWindow).toHaveLength(MIN_ID);

    // The selected boundary must clear the real 24h rule.
    const sep = evaluateTemporalSeparation({
      earlierWindow: result.earlierWindow, recentWindow: result.recentWindow,
    });
    expect(sep.meetsMinimum).toBe(true);
    expect(sep.separationMs).toBeGreaterThanOrEqual(MIN_WINDOW_SEPARATION_MS);

    // And the full decision is a real verdict, not insufficient_data.
    const decision = evaluatePersistentDifficultyWindows({
      earlierWindow: result.earlierWindow, recentWindow: result.recentWindow,
    });
    expect(decision.status).not.toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
  });

  it('reports how many newer usable cycles were skipped to reach that window', () => {
    const cycles = [
      ...Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS)),
      ...burst(20 * DAY_MS, 6),
    ];
    const result = splitLongitudinalWindows(cycles);
    expect(result.cyclesNewerThanWindow).toBeGreaterThan(0);
  });
});

describe('C1 Test B — newest-data preference is preserved', () => {
  it('when the newest 10 are already separated, exactly those 10 are used', () => {
    const cycles = Array.from({ length: 14 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);

    expect(result.separationSatisfied).toBe(true);
    expect(result.cyclesNewerThanWindow).toBe(0);
    // The newest cycle must be present, and the 4 oldest absent.
    const used = [...result.earlierWindow, ...result.recentWindow];
    expect(used.some((c) => c.createdAt === iso(0, 13 * DAY_MS))).toBe(true);
    expect(used.some((c) => c.createdAt === iso(0, 3 * DAY_MS))).toBe(false);
  });

  it('picks the MOST RECENT separated window when several qualify', () => {
    // 20 day-spaced cycles: many candidate windows qualify; the newest wins.
    const cycles = Array.from({ length: 20 }, (_, i) => usableCycle(i * DAY_MS));
    const result = splitLongitudinalWindows(cycles);
    expect(result.cyclesNewerThanWindow).toBe(0);
    expect(result.recentWindow[result.recentWindow.length - 1].createdAt).toBe(iso(0, 19 * DAY_MS));
  });
});

describe('C1 Test C — genuinely undispersed history is unchanged', () => {
  it('a stream that is one single sitting still reports insufficient_temporal_dispersion', () => {
    const cycles = burst(0, 13);
    const result = splitLongitudinalWindows(cycles);

    // Still 'ok' with the newest 10 — the previous behaviour exactly, so the
    // decision function produces the same status/reason it always did.
    expect(result.status).toBe('ok');
    expect(result.separationSatisfied).toBe(false);
    expect(result.cyclesNewerThanWindow).toBe(0);

    const decision = evaluatePersistentDifficultyWindows({
      earlierWindow: result.earlierWindow, recentWindow: result.recentWindow,
    });
    expect(decision.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(decision.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION);
    expect(decision.separationMs).toBeLessThan(MIN_WINDOW_SEPARATION_MS);
  });
});

describe('C1 Test D — window invariants hold for a scanned-back selection', () => {
  it('windows stay non-overlapping, complete, and chronologically ordered', () => {
    const cycles = [
      ...Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS)),
      ...burst(20 * DAY_MS, 8),
    ];
    const result = splitLongitudinalWindows(cycles);

    expect(result.earlierWindow).toHaveLength(MIN_ID);
    expect(result.recentWindow).toHaveLength(MIN_ID);

    const earlierSet = new Set(result.earlierWindow.map((c) => c.createdAt));
    expect(result.recentWindow.filter((c) => earlierSet.has(c.createdAt))).toHaveLength(0);

    const maxEarlier = Math.max(...result.earlierWindow.map((c) => new Date(c.createdAt).getTime()));
    const minRecent = Math.min(...result.recentWindow.map((c) => new Date(c.createdAt).getTime()));
    expect(maxEarlier).toBeLessThan(minRecent);
  });

  it('still never uses an unknown-outcome cycle', () => {
    const cycles = [
      ...Array.from({ length: 10 }, (_, i) => usableCycle(i * DAY_MS)),
      { letter: 'c', outcome: 'unknown', createdAt: iso(0, 15 * DAY_MS) },
      ...burst(20 * DAY_MS, 6),
    ];
    const result = splitLongitudinalWindows(cycles);
    const outcomes = [...result.earlierWindow, ...result.recentWindow].map((c) => c.outcome);
    expect(outcomes).not.toContain('unknown');
    expect(result.unknownCount).toBe(1);
  });
});

describe('C1 Test E — the separation threshold itself is untouched', () => {
  it('a boundary just under 24h is still rejected, just over is still accepted', () => {
    const justUnder = [
      ...Array.from({ length: 5 }, (_, i) => usableCycle(i * 1000)),
      ...Array.from({ length: 5 }, (_, i) => usableCycle(MIN_WINDOW_SEPARATION_MS - 1000 + i * 1000)),
    ];
    expect(splitLongitudinalWindows(justUnder).separationSatisfied).toBe(false);

    const justOver = [
      ...Array.from({ length: 5 }, (_, i) => usableCycle(i * 1000)),
      ...Array.from({ length: 5 }, (_, i) => usableCycle(4000 + MIN_WINDOW_SEPARATION_MS + i * 1000)),
    ];
    expect(splitLongitudinalWindows(justOver).separationSatisfied).toBe(true);
  });
});

// ─── §62 Tests 39-48 — persistence evaluation ──────────────────────────────

function difficultWindow(startMs, { successCount = 1 } = {}) {
  return Array.from({ length: 5 }, (_, i) => ({
    letter: 'c',
    outcome: i < successCount ? 'success' : 'failure',
    createdAt: iso(startMs, i * 1000),
  }));
}

function goodWindow(startMs) {
  return Array.from({ length: 5 }, (_, i) => ({
    letter: 'c', outcome: 'success', createdAt: iso(startMs, i * 1000),
  }));
}

describe('Test 39 — one difficult window only -> insufficient (no earlier window)', () => {
  it('evaluatePersistentDifficultyWindows with recentWindow only (earlierWindow null) is insufficient, never persistent', () => {
    const result = evaluatePersistentDifficultyWindows({ earlierWindow: null, recentWindow: difficultWindow(10 * DAY_MS, { successCount: 0 }) });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_CYCLES);
  });
});

describe('Test 40 — 10 all failures but <24h separation -> insufficient', () => {
  it('two adjacent 5-cycle windows only 45 minutes apart never qualify as persistent', () => {
    const earlierWindow = difficultWindow(0, { successCount: 0 });
    const recentWindow = difficultWindow(45 * 60 * 1000, { successCount: 0 }); // 45 minutes later
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION);
  });
});

describe('Test 41 — two difficult windows separated by >=24h -> persistent', () => {
  it('Case C from spec §48', () => {
    const earlierWindow = difficultWindow(0, { successCount: 1 });
    const recentWindow = difficultWindow(2 * DAY_MS, { successCount: 0 });
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS);
  });
});

describe('Test 42 — earlier good / recent bad -> not_persistent', () => {
  it('Case D from spec §48 (recent_difficulty_not_yet_persistent)', () => {
    const earlierWindow = difficultWindow(0, { successCount: 4 });
    const recentWindow = difficultWindow(2 * DAY_MS, { successCount: 1 });
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.RECENT_DIFFICULTY_NOT_YET_PERSISTENT);
  });
});

describe('Test 43 — earlier bad / recent good -> not_persistent', () => {
  it('Case E from spec §48 (recent_improvement)', () => {
    const earlierWindow = difficultWindow(0, { successCount: 1 });
    const recentWindow = difficultWindow(2 * DAY_MS, { successCount: 4 });
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.RECENT_IMPROVEMENT);
  });
});

describe('Test 44 — both good -> not_persistent', () => {
  it('Case F from spec §48 (no_persistent_difficulty)', () => {
    const earlierWindow = difficultWindow(0, { successCount: 4 });
    const recentWindow = goodWindow(2 * DAY_MS);
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.NO_PERSISTENT_DIFFICULTY);
  });
});

describe('Test 45 — exact 24h boundary accepted', () => {
  it('separationMs === MIN_WINDOW_SEPARATION_MS exactly still qualifies (>=, not >)', () => {
    const earlierWindow = difficultWindow(0, { successCount: 0 });
    const recentWindow = difficultWindow(MIN_WINDOW_SEPARATION_MS + 4000, { successCount: 0 });
    // earlierWindow's last cycle is at offset 4000ms; recentWindow's first
    // cycle must be at least MIN_WINDOW_SEPARATION_MS after that.
    const separation = evaluateTemporalSeparation({ earlierWindow, recentWindow });
    expect(separation.separationMs).toBe(MIN_WINDOW_SEPARATION_MS);
    expect(separation.meetsMinimum).toBe(true);
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT);
  });
});

describe('Test 46 — one millisecond under boundary rejected', () => {
  it('separationMs === MIN_WINDOW_SEPARATION_MS - 1 fails', () => {
    const earlierWindow = difficultWindow(0, { successCount: 0 });
    const recentWindow = difficultWindow(MIN_WINDOW_SEPARATION_MS + 4000 - 1, { successCount: 0 });
    const separation = evaluateTemporalSeparation({ earlierWindow, recentWindow });
    expect(separation.separationMs).toBe(MIN_WINDOW_SEPARATION_MS - 1);
    expect(separation.meetsMinimum).toBe(false);
    const result = evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow });
    expect(result.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(result.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION);
  });
});

describe('Test 47 — no score from current threshold', () => {
  it('evaluatePersistentDifficultyWindows and its helpers never call a current-Feature-2-threshold lookup', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const requireLines = source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
    expect(requireLines).not.toMatch(/dynamicThresholdService|adaptiveSupportService/);
  });
});

describe('Test 48 — deterministic: same input -> same output', () => {
  it('calling evaluatePersistentDifficultyWindows twice with identical (deep-equal, distinct-reference) input yields identical output', () => {
    const earlierWindow = difficultWindow(0, { successCount: 1 });
    const recentWindow = difficultWindow(2 * DAY_MS, { successCount: 0 });
    const first = evaluatePersistentDifficultyWindows({ earlierWindow: [...earlierWindow], recentWindow: [...recentWindow] });
    const second = evaluatePersistentDifficultyWindows({ earlierWindow: [...earlierWindow], recentWindow: [...recentWindow] });
    expect(first).toEqual(second);
  });
});

// ─── §63 Tests 49-54 — affected letters ────────────────────────────────────

describe('Test 49 — computed only from the selected ten-cycle evidence', () => {
  it('a letter appearing only OUTSIDE the provided cycle list never appears in the summary', () => {
    const cycles = [
      { letter: 'c', outcome: 'failure' },
      { letter: 'c', outcome: 'success' },
    ];
    const result = summarizeAffectedLetters(cycles);
    expect(result).not.toHaveProperty('o');
    expect(Object.keys(result)).toEqual(['c']);
  });
});

describe('Test 50 — failed count correct', () => {
  it('counts only outcome === "failure" toward failedCycles', () => {
    const cycles = [
      { letter: 'c', outcome: 'failure' },
      { letter: 'c', outcome: 'failure' },
      { letter: 'c', outcome: 'success' },
    ];
    const result = summarizeAffectedLetters(cycles);
    expect(result.c.failedCycles).toBe(2);
  });
});

describe('Test 51 — total count correct', () => {
  it('totalCycles counts every cycle for that letter regardless of outcome', () => {
    const cycles = [
      { letter: 'c', outcome: 'failure' },
      { letter: 'c', outcome: 'success' },
      { letter: 'c', outcome: 'success' },
    ];
    const result = summarizeAffectedLetters(cycles);
    expect(result.c.totalCycles).toBe(3);
  });
});

describe('Test 52 — deterministic ordering', () => {
  it('failedCycles descending, then totalCycles descending, then alphabetical', () => {
    const cycles = [
      // o: 1 failed of 1 total
      { letter: 'o', outcome: 'failure' },
      // c: 3 failed of 4 total
      { letter: 'c', outcome: 'failure' }, { letter: 'c', outcome: 'failure' }, { letter: 'c', outcome: 'failure' }, { letter: 'c', outcome: 'success' },
      // s: 1 failed of 2 total
      { letter: 's', outcome: 'failure' }, { letter: 's', outcome: 'success' },
      // v: 1 failed of 1 total (ties with o on both counts -> alphabetical: o before v)
      { letter: 'v', outcome: 'failure' },
    ];
    const result = summarizeAffectedLetters(cycles);
    expect(Object.keys(result)).toEqual(['c', 's', 'o', 'v']);
  });

  it('ordering is stable across repeated calls with the same (re-shuffled) input', () => {
    const cycles = [
      { letter: 'x', outcome: 'failure' }, { letter: 'a', outcome: 'failure' }, { letter: 'm', outcome: 'failure' },
    ];
    const shuffled = [cycles[2], cycles[0], cycles[1]];
    expect(Object.keys(summarizeAffectedLetters(cycles))).toEqual(Object.keys(summarizeAffectedLetters(shuffled)));
    expect(Object.keys(summarizeAffectedLetters(cycles))).toEqual(['a', 'm', 'x']);
  });
});

describe('Test 53 — ambiguous excluded (upstream, before affectedLetters ever sees the data)', () => {
  it('summarizeAffectedLetters itself has no family-mapping logic — ambiguous exclusion already happened in buildFamilyCaseEvidence', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const match = source.match(/function summarizeAffectedLetters[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/getBaselineFamily/);
  });
});

describe('Test 54 — case-separated', () => {
  it('summarizeAffectedLetters trusts caller-provided cycles verbatim — a caller that already separated lowercase/uppercase upstream (buildFamilyCaseEvidence) never has them re-mixed here', () => {
    const cycles = [
      { letter: 'c', caseType: 'lowercase', outcome: 'failure' },
      { letter: 'C', caseType: 'uppercase', outcome: 'failure' },
    ];
    const result = summarizeAffectedLetters(cycles);
    // Both appear as distinct keys ('c' vs 'C') — never merged into one entry.
    expect(Object.keys(result).sort()).toEqual(['C', 'c']);
  });
});

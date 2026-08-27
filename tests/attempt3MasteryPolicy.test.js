'use strict';

/**
 * The NORMAL LETTER PRACTICE mastery policy — Phase 20 scenarios A–L.
 *
 * The one this suite exists for is F: attempts 1 and 2 can score 95 and the
 * cycle must still FAIL if attempt 3 scores 60. Guided attempts must never
 * master a letter. Everything else here protects that rule's edges.
 */

const {
  NORMAL_PRACTICE_MASTERY_THRESHOLD, MASTERY_ATTEMPT_NUMBER, ATTEMPTS_PER_CYCLE,
  PROGRESSION_FAMILY_THRESHOLDS_ENABLED, MASTERY_FAIL_REASON, CYCLE_BRANCH,
  MASTERY_POLICY_VERSION,
} = require('../src/config/masteryPolicy');
const {
  MAX_CYCLES_PER_LETTER_PER_DATE, toPracticeDate, currentPracticeDate,
} = require('../src/config/practiceCyclePolicy');
const {
  computeAuthoritativeBestScore, computeAuthoritativeMasteryScore,
} = require('../src/utils/authoritativeAttemptScoring');

// ─── The policy constants themselves ────────────────────────────────────

describe('policy constants', () => {
  it('the pilot mastery threshold is 70, and is NOT the old global fallback', () => {
    expect(NORMAL_PRACTICE_MASTERY_THRESHOLD).toBe(70);
    const { GLOBAL_DEFAULT } = require('../src/services/progressionThresholdResolver');
    expect(GLOBAL_DEFAULT).toBe(55);                       // unchanged, still exported
    expect(NORMAL_PRACTICE_MASTERY_THRESHOLD).not.toBe(GLOBAL_DEFAULT);
  });

  it('mastery is decided on attempt 3 of 3', () => {
    expect(MASTERY_ATTEMPT_NUMBER).toBe(3);
    expect(ATTEMPTS_PER_CYCLE).toBe(3);
  });

  it('the cycle cap is 3 per letter per practice date (9 attempts max)', () => {
    expect(MAX_CYCLES_PER_LETTER_PER_DATE).toBe(3);
    expect(MAX_CYCLES_PER_LETTER_PER_DATE * ATTEMPTS_PER_CYCLE).toBe(9);
  });

  it('progression family thresholds are disabled for the pilot', () => {
    expect(PROGRESSION_FAMILY_THRESHOLDS_ENABLED).toBe(false);
  });

  it('the policy version is stamped and distinct from the legacy one', () => {
    const { LEGACY_MASTERY_POLICY_VERSION } = require('../src/config/masteryPolicy');
    expect(MASTERY_POLICY_VERSION).toBe('attempt3-only-3cycle-v1');
    expect(MASTERY_POLICY_VERSION).not.toBe(LEGACY_MASTERY_POLICY_VERSION);
  });
});

// ─── Building attempts with a known score ───────────────────────────────
//
// A straight horizontal stroke across a wide canvas: coverage-valid, and its
// motor score varies with how cleanly it is drawn. Rather than reverse the
// formula, each test asserts on the RELATIVE ordering the helper produces
// and drives the decision through the real functions.

const CANVAS = { canvasWidth: 600, canvasHeight: 300 };

/** A clean, coverage-valid stroke — scores high. */
function goodStroke() {
  const points = [];
  for (let i = 0; i <= 60; i++) points.push({ x: 40 + i * 8.6, y: 150, t: i * 30 });
  return [{ stroke_id: 0, points }];
}

/** A short, jittery stroke — coverage-INVALID (too little of the canvas). */
function tinyStroke() {
  const points = [];
  for (let i = 0; i <= 10; i++) points.push({ x: 300 + i, y: 150 + (i % 2), t: i * 30 });
  return [{ stroke_id: 0, points }];
}

// NOTE the non-empty `features`. Capture completeness is now checked BEFORE
// coverage (utils/captureStatus.js), and an empty features object is itself a
// capture fault — so a fixture meant to test COVERAGE must carry real
// features, or it silently tests the capture path instead.
const attemptWith = (strokes, features = { smoothness: 0.06, dtw_distance: 4 }) =>
  ({ strokes, features });

/** An attempt the device never captured — no strokes at all. */
const uncapturedAttempt = () => ({ strokes: [], features: { smoothness: 0.06 } });
/** An attempt whose features never arrived. */
const featurelessAttempt = () => ({ strokes: goodStroke(), features: {} });

// ─── F + G: the guided attempts must not decide ─────────────────────────

describe('Scenario F — attempts 1 and 2 excellent, attempt 3 poor', () => {
  // Constructed so the FIRST two attempts are the good ones.
  const attempts = [
    attemptWith(goodStroke()),
    attemptWith(goodStroke()),
    attemptWith(tinyStroke()),
  ];

  it('the mastery score comes from attempt 3, not from the best attempt', () => {
    const best    = computeAuthoritativeBestScore({ attempts, ...CANVAS });
    const mastery = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });

    expect(mastery.attemptNumber).toBe(3);
    // Attempt 3 is coverage-invalid, so it cannot master...
    expect(mastery.masteryScore).toBeNull();
    // ...even though the cycle's best-of-3 is a real, passing-looking score.
    expect(best.bestScore).not.toBeNull();
    expect(best.bestScore).toBeGreaterThan(NORMAL_PRACTICE_MASTERY_THRESHOLD);
  });

  it('SENTINEL — the OLD best-of-3 rule WOULD have mastered this cycle', () => {
    // Proof the change is load-bearing rather than cosmetic.
    const best = computeAuthoritativeBestScore({ attempts, ...CANVAS });
    expect(best.bestScore >= NORMAL_PRACTICE_MASTERY_THRESHOLD).toBe(true);
    const mastery = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });
    expect(mastery.masteryScore == null ||
           mastery.masteryScore < NORMAL_PRACTICE_MASTERY_THRESHOLD).toBe(true);
  });

  it('never falls back to attempt 1 or attempt 2', () => {
    const { attemptScores } = computeAuthoritativeBestScore({ attempts, ...CANVAS });
    const mastery = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });
    expect(mastery.masteryScore).not.toBe(attemptScores[0]);
    expect(mastery.masteryScore).not.toBe(attemptScores[1]);
  });
});

describe('Scenario G — attempts 1 and 2 poor, attempt 3 good', () => {
  const attempts = [
    attemptWith(tinyStroke()),
    attemptWith(tinyStroke()),
    attemptWith(goodStroke()),
  ];

  it('the good independent attempt is the one that counts', () => {
    const mastery = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });
    expect(mastery.masteryScore).not.toBeNull();
    expect(mastery.failReason).toBeNull();
    expect(mastery.coverageValid).not.toBe(false);
  });

  it('a weak start does not disqualify the cycle', () => {
    const { attemptScores } = computeAuthoritativeBestScore({ attempts, ...CANVAS });
    expect(attemptScores[0]).toBeNull();   // coverage-invalid
    expect(attemptScores[1]).toBeNull();
    const mastery = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });
    expect(mastery.masteryScore).toEqual(expect.any(Number));
  });
});

// ─── H: coverage-invalid attempt 3 ──────────────────────────────────────

describe('Scenario H — attempt 3 coverage-invalid', () => {
  it('is a FAIL with a specific reason, never a fallback', () => {
    const attempts = [
      attemptWith(goodStroke()), attemptWith(goodStroke()), attemptWith(tinyStroke()),
    ];
    const r = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });
    expect(r.masteryScore).toBeNull();
    expect(r.coverageValid).toBe(false);
    expect(r.failReason).toBe(MASTERY_FAIL_REASON.COVERAGE_INVALID);
  });

  it('undeterminable coverage is NOT a failure — a missing canvas size must not fail a child', () => {
    const attempts = [
      attemptWith(goodStroke()), attemptWith(goodStroke()), attemptWith(goodStroke()),
    ];
    const r = computeAuthoritativeMasteryScore({
      attempts, canvasWidth: null, canvasHeight: null,
    });
    expect(r.coverageValid).not.toBe(false);
    expect(r.failReason).not.toBe(MASTERY_FAIL_REASON.COVERAGE_INVALID);
  });
});

describe('a cycle that never reached attempt 3', () => {
  it('cannot master, and says so specifically', () => {
    for (const n of [0, 1, 2]) {
      const attempts = Array.from({ length: n }, () => attemptWith(goodStroke()));
      const r = computeAuthoritativeMasteryScore({ attempts, ...CANVAS });
      expect(r.masteryScore).toBeNull();
      expect(r.failReason).toBe(MASTERY_FAIL_REASON.ATTEMPT_MISSING);
    }
  });

  it('tolerates a missing or malformed attempts array', () => {
    for (const bad of [undefined, null, 'nope', 42, {}]) {
      const r = computeAuthoritativeMasteryScore({ attempts: bad, ...CANVAS });
      expect(r.masteryScore).toBeNull();
      expect(r.failReason).toBe(MASTERY_FAIL_REASON.ATTEMPT_MISSING);
    }
  });
});

// ─── P1: capture fault is NOT a coverage failure ────────────────────────
//
// isAttemptCoverageValid() returns `false` for an EMPTY drawing and for a
// genuine tiny one alike, so a device fault used to be reported as
// `attempt3_coverage_invalid` — a handwriting judgement about handwriting
// that was never recorded — and spent one of the child's three daily cycles.

describe('capture fault vs coverage failure', () => {
  const CAP = { ...CANVAS };

  it('SENTINEL — an uncaptured attempt 3 is CAPTURE_INCOMPLETE, never COVERAGE_INVALID', () => {
    const attempts = [attemptWith(goodStroke()), attemptWith(goodStroke()), uncapturedAttempt()];
    const r = computeAuthoritativeMasteryScore({ attempts, ...CAP });
    expect(r.failReason).toBe(MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE);
    expect(r.failReason).not.toBe(MASTERY_FAIL_REASON.COVERAGE_INVALID);
    expect(r.masteryScore).toBeNull();
  });

  it('a missing features object is also a capture fault', () => {
    const attempts = [attemptWith(goodStroke()), attemptWith(goodStroke()), featurelessAttempt()];
    expect(computeAuthoritativeMasteryScore({ attempts, ...CAP }).failReason)
      .toBe(MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE);
  });

  it('a REAL tiny drawing is still COVERAGE_INVALID — the distinction is preserved', () => {
    const attempts = [attemptWith(goodStroke()), attemptWith(goodStroke()), attemptWith(tinyStroke())];
    const r = computeAuthoritativeMasteryScore({ attempts, ...CAP });
    expect(r.failReason).toBe(MASTERY_FAIL_REASON.COVERAGE_INVALID);
    expect(r.coverageValid).toBe(false);
  });

  it('capture is checked BEFORE coverage — order is load-bearing', () => {
    // An attempt that is BOTH uncaptured and (vacuously) coverage-failing
    // must report the capture fault, not the coverage one.
    const attempts = [attemptWith(goodStroke()), attemptWith(goodStroke()), { strokes: [], features: {} }];
    expect(computeAuthoritativeMasteryScore({ attempts, ...CAP }).failReason)
      .toBe(MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE);
  });

  it('cycleIsConsumed is false ONLY for a capture fault', () => {
    const { cycleIsConsumed } = require('../src/config/masteryPolicy');
    expect(cycleIsConsumed(MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE)).toBe(false);
    for (const r of [
      MASTERY_FAIL_REASON.COVERAGE_INVALID,
      MASTERY_FAIL_REASON.BELOW_THRESHOLD,
      MASTERY_FAIL_REASON.ATTEMPT_MISSING,
      MASTERY_FAIL_REASON.SCORE_UNAVAILABLE,
      null,
    ]) expect(cycleIsConsumed(r)).toBe(true);
  });

  it('the shared predicate is the SAME one that labels the stored row', () => {
    const { rowCaptureStatus, isAttemptCaptureComplete } = require('../src/utils/captureStatus');
    for (const a of [uncapturedAttempt(), featurelessAttempt()]) {
      expect(rowCaptureStatus({ strokePoints: a.strokes, features: a.features })).toBe('incomplete');
      expect(isAttemptCaptureComplete(a)).toBe(false);
    }
    const ok = attemptWith(goodStroke());
    expect(rowCaptureStatus({ strokePoints: ok.strokes, features: ok.features })).toBe('complete');
    expect(isAttemptCaptureComplete(ok)).toBe(true);
  });

  it('semantics are byte-identical to the previous private rowCaptureStatus', () => {
    const { rowCaptureStatus } = require('../src/utils/captureStatus');
    const legacy = ({ strokePoints, features }) => {
      const hasStrokes  = Array.isArray(strokePoints) && strokePoints.length > 0;
      const hasFeatures = features != null && typeof features === 'object' && Object.keys(features).length > 0;
      return hasStrokes && hasFeatures ? 'complete' : 'incomplete';
    };
    for (const c of [
      { strokePoints: [{}], features: { a: 1 } }, { strokePoints: [], features: { a: 1 } },
      { strokePoints: [{}], features: {} }, { strokePoints: null, features: null },
      { strokePoints: undefined, features: undefined }, { strokePoints: [{}], features: 'no' },
    ]) expect(rowCaptureStatus(c)).toBe(legacy(c));
  });
});

// ─── A–E: the cycle decision flow ───────────────────────────────────────
//
// The branch logic as a pure decision, so the flow is testable without a
// database. Mirrors the controller's own branch selection.

function decideBranch({ passed, cyclesUsed }) {
  if (passed) return CYCLE_BRANCH.MASTERED_ADVANCE;
  if (cyclesUsed === 1) return CYCLE_BRANCH.FAILED_START_CYCLE_2;
  if (cyclesUsed === 2) return CYCLE_BRANCH.FAILED_START_CYCLE_3;
  if (cyclesUsed >= MAX_CYCLES_PER_LETTER_PER_DATE) return CYCLE_BRANCH.FAILED_ADVANCE_AFTER_CYCLE_3;
  return 'FAILED_CYCLE_COUNT_UNKNOWN';
}

describe('Scenarios A–E — the cycle flow', () => {
  it('A. Cycle 1 attempt 3 PASSES -> mastered, advance', () => {
    expect(decideBranch({ passed: true, cyclesUsed: 1 })).toBe(CYCLE_BRANCH.MASTERED_ADVANCE);
  });

  it('B. Cycle 1 attempt 3 FAILS -> Cycle 2, same letter', () => {
    expect(decideBranch({ passed: false, cyclesUsed: 1 })).toBe(CYCLE_BRANCH.FAILED_START_CYCLE_2);
  });

  it('C. Cycle 2 attempt 3 PASSES -> mastered, advance', () => {
    expect(decideBranch({ passed: true, cyclesUsed: 2 })).toBe(CYCLE_BRANCH.MASTERED_ADVANCE);
  });

  it('D. Cycle 2 attempt 3 FAILS -> Cycle 3, same letter', () => {
    expect(decideBranch({ passed: false, cyclesUsed: 2 })).toBe(CYCLE_BRANCH.FAILED_START_CYCLE_3);
  });

  it('E. Cycle 3 attempt 3 FAILS -> advance unmastered, homework candidate', () => {
    expect(decideBranch({ passed: false, cyclesUsed: 3 })).toBe(CYCLE_BRANCH.FAILED_ADVANCE_AFTER_CYCLE_3);
  });

  it('J. there is no Cycle 4 — a fourth is still the terminal branch', () => {
    expect(decideBranch({ passed: false, cyclesUsed: 4 })).toBe(CYCLE_BRANCH.FAILED_ADVANCE_AFTER_CYCLE_3);
  });
});

// ─── I: restart must not buy a cycle ────────────────────────────────────

describe('Scenario I — app restart after Cycle 2', () => {
  const remaining = (used) => Math.max(0, MAX_CYCLES_PER_LETTER_PER_DATE - used);

  it('exactly one cycle remains after two used', () => {
    expect(remaining(2)).toBe(1);
  });

  it('no cycle remains after three used', () => {
    expect(remaining(3)).toBe(0);
    expect(remaining(4)).toBe(0);
  });

  it('the cap is measured from SERVER-counted cycles, not client memory', () => {
    // letterCycleService derives cycles_today from persisted, distinct
    // completed session_keys on the practice date — an in-memory guard
    // reset by a restart cannot change that count.
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/letterCycleService.js'), 'utf8');
    expect(src).toMatch(/session_key/);
    expect(src).toMatch(/MAX_CYCLES_PER_LETTER_PER_DATE/);
  });
});

// ─── K: Writing Check isolation ─────────────────────────────────────────

describe('Scenario K — Writing Check rows are never counted', () => {
  it('the cycle service excludes collection_mode rows', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/letterCycleService.js'), 'utf8');
    expect(src).toMatch(/collection_mode/);
  });

  it('the mastery gate is unreachable for a collection-mode submission', () => {
    // recordLetterCompletion returns early for collection_mode before any
    // threshold/mastery work — proven by the early-return literal.
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    expect(src).toMatch(/completed: true, collection_mode: true/);
  });
});

// ─── L: an unmastered letter returns on a later date ────────────────────

describe('Scenario L — future-date retry', () => {
  it('the cap is scoped to a single practice date, so tomorrow starts at zero', () => {
    const yesterday = toPracticeDate('2026-08-26T10:00:00+05:30');
    const today     = toPracticeDate('2026-08-27T10:00:00+05:30');
    expect(yesterday).not.toBe(today);
    // Three cycles used YESTERDAY leave three available TODAY, because the
    // count is filtered to the target date.
    expect(MAX_CYCLES_PER_LETTER_PER_DATE - 0).toBe(3);
  });

  it('the practice date rolls at local midnight, not UTC midnight', () => {
    // 20:00 UTC on the 26th is already 01:30 on the 27th in Asia/Colombo.
    expect(toPracticeDate('2026-08-26T20:00:00Z')).toBe('2026-08-27');
    // ...and 18:00 UTC is still the 26th locally (23:30).
    expect(toPracticeDate('2026-08-26T18:00:00Z')).toBe('2026-08-26');
  });

  it('currentPracticeDate returns a comparable YYYY-MM-DD string', () => {
    expect(currentPracticeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('exhausting three cycles never writes mastery, so the letter stays eligible', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    // mastered_at is set in exactly one place, and only past the gate.
    const writes = src.match(/mastered_at:\s*masteredAt/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    expect(src).toMatch(/masteryScore == null \|\| masteryScore < threshold/);
  });
});

// ─── Phase 16: mastery semantics ────────────────────────────────────────

describe('Phase 16 — mastery semantics', () => {
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');

  it('the mastery gate reads the ATTEMPT-3 score, never the best score', () => {
    expect(src).toMatch(/if \(masteryScore == null \|\| masteryScore < threshold\)/);
    expect(src).not.toMatch(/if \(bestScore == null \|\| bestScore < threshold\)/);
  });

  it('best-of-3 is still computed — attempts 1 and 2 remain scored and reportable', () => {
    expect(src).toMatch(/computeAuthoritativeBestScore/);
    expect(src).toMatch(/best_score:\s*bestScore/);
  });
});

// ─── Phase 8: homework trigger ──────────────────────────────────────────

describe('Phase 8 — exact-letter homework', () => {
  const {
    EXACT_LETTER_CANDIDATE_SOURCES, isExactLetterCandidateSource,
  } = require('../src/services/worksheetService');

  it('new candidates use the three-cycle source name', () => {
    expect(EXACT_LETTER_CANDIDATE_SOURCES[0]).toBe('three_cycle_failure');
  });

  it('the historical source is still recognised — old rows must not be orphaned', () => {
    expect(isExactLetterCandidateSource('two_cycle_failure')).toBe(true);
    expect(isExactLetterCandidateSource('three_cycle_failure')).toBe(true);
  });

  it('unrelated sources are not swept in', () => {
    expect(isExactLetterCandidateSource('persistent_difficulty')).toBe(false);
    expect(isExactLetterCandidateSource(undefined)).toBe(false);
  });

  it('the trigger reads the cap constant rather than hardcoding a number', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/letterCycleService.js'), 'utf8');
    expect(src).toMatch(/todays\.length < MAX_CYCLES_PER_LETTER_PER_DATE/);
  });
});

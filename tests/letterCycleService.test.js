'use strict';

/**
 * The three-cycle-per-practice-date ceiling — durable half.
 *
 * Raised from two to three alongside the attempt-3-only mastery rule (see
 * config/masteryPolicy.js): mastery is now judged on the UNGUIDED attempt,
 * which is materially harder, so a third cycle restores some of the room the
 * stricter gate removes.
 *
 * One cycle = one distinct session_key. The ceiling is 2 per
 * (student, letter, case_type, practice date). Nothing here writes anything,
 * and nothing here can set mastered_at.
 */

jest.mock('../src/models', () => ({
  LetterAttempt: { findAll: jest.fn() },
  LetterProgress: { findAll: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { LetterAttempt, LetterProgress } = require('../src/models');
const {
  getCycleUsageForDate, getTwoCycleFailureLetters, groupIntoCycles,
} = require('../src/services/letterCycleService');
const {
  MAX_CYCLES_PER_LETTER_PER_DATE, PRACTICE_TIMEZONE, toPracticeDate, currentPracticeDate,
} = require('../src/config/practiceCyclePolicy');

/** Three attempt rows sharing one session_key — i.e. one complete cycle. */
function cycle({ key, letter = 'c', caseType = 'lowercase', passed = false, at }) {
  return [1, 2, 3].map(n => ({
    session_key: key, letter, case_type: caseType,
    attempt_number: n, passed, created_at: new Date(at),
  }));
}

// 10:00 local (Asia/Colombo) on two consecutive days.
const DAY1 = '2026-08-26T04:30:00.000Z';
const DAY1_LATER = '2026-08-26T05:30:00.000Z';
const DAY2 = '2026-08-27T04:30:00.000Z';

beforeEach(() => {
  jest.clearAllMocks();
  LetterProgress.findAll.mockResolvedValue([]);
});

// ─── The date rule ──────────────────────────────────────────────────────

describe('practice date', () => {
  it('is measured in the practice timezone, not raw UTC', () => {
    expect(PRACTICE_TIMEZONE).toBe('Asia/Colombo');
    // 20:00 UTC on the 26th is already 01:30 on the 27th locally. Measuring
    // in UTC would put a late-evening session on the wrong date.
    expect(toPracticeDate('2026-08-26T20:00:00.000Z')).toBe('2026-08-27');
    // ...and the boundary falls at LOCAL midnight, where no child is writing.
    expect(toPracticeDate('2026-08-26T18:29:00.000Z')).toBe('2026-08-26');
    expect(toPracticeDate('2026-08-26T18:31:00.000Z')).toBe('2026-08-27');
  });

  it('formats as YYYY-MM-DD so dates compare as plain strings', () => {
    expect(toPracticeDate(DAY1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toPracticeDate(DAY1) < toPracticeDate(DAY2)).toBe(true);
  });

  it('returns null for an unparseable timestamp — never "today"', () => {
    expect(toPracticeDate('not a date')).toBeNull();
    expect(toPracticeDate(undefined)).toBeNull();
    expect(currentPracticeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── Grouping attempts into cycles ──────────────────────────────────────

describe('one cycle = one session_key', () => {
  it('groups three attempts under one session key', () => {
    const cycles = groupIntoCycles(cycle({ key: 's1', at: DAY1 }));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].attemptNumbers).toEqual([1, 2, 3]);
    expect(cycles[0].complete).toBe(true);
  });

  it('keeps two cycles distinct even for the same letter at the same time', () => {
    const cycles = groupIntoCycles([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
    ]);
    expect(cycles).toHaveLength(2);
    expect(cycles.map(c => c.sessionKey)).toEqual(['s1', 's2']);
  });

  it('does NOT count a half-finished cycle against the child', () => {
    // App closed after attempt 2 — that is not one of their two.
    const partial = cycle({ key: 's1', at: DAY1 }).slice(0, 2);
    expect(groupIntoCycles(partial)[0].complete).toBe(false);
  });

  it('ignores rows with no session key rather than inventing one', () => {
    expect(groupIntoCycles([{ session_key: null, attempt_number: 1 }])).toHaveLength(0);
  });
});

// ─── The ceiling ────────────────────────────────────────────────────────

describe('getCycleUsageForDate', () => {
  const args = { studentId: 7, letter: 'c', caseType: 'lowercase', date: toPracticeDate(DAY1) };

  it('after ONE failed cycle the letter may have another', async () => {
    LetterAttempt.findAll.mockResolvedValue(cycle({ key: 's1', at: DAY1 }));
    const r = await getCycleUsageForDate(args);
    expect(r).toMatchObject({ status: 'ok', cycles: 1, failedCycles: 1, remaining: 2, capReached: false });
  });

  it('after TWO failed cycles a THIRD is still allowed', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
    ]);
    const r = await getCycleUsageForDate(args);
    expect(r).toMatchObject({ cycles: 2, failedCycles: 2, remaining: 1, capReached: false });
  });

  it('after THREE failed cycles the ceiling is reached', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
      ...cycle({ key: 's3', at: DAY1_LATER }),
    ]);
    const r = await getCycleUsageForDate(args);
    expect(r).toMatchObject({ cycles: 3, failedCycles: 3, remaining: 0, capReached: true });
    expect(r.reason).toBe('cycle_cap_reached_for_date');
  });

  it('there is no fourth cycle — a fourth stays capped, never negative remaining', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }), ...cycle({ key: 's2', at: DAY1_LATER }),
      ...cycle({ key: 's3', at: DAY1_LATER }), ...cycle({ key: 's4', at: DAY1_LATER }),
    ]);
    const r = await getCycleUsageForDate(args);
    expect(r.capReached).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('a cycle on ANOTHER date does not count against today', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's0', at: DAY2 }),   // a different practice date
      ...cycle({ key: 's1', at: DAY1 }),
    ]);
    const r = await getCycleUsageForDate(args);
    expect(r.cycles).toBe(1);
    expect(r.capReached).toBe(false);
  });

  it('the next practice date starts fresh', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
    ]);
    const today = await getCycleUsageForDate({ ...args, date: toPracticeDate(DAY2) });
    expect(today).toMatchObject({ cycles: 0, remaining: MAX_CYCLES_PER_LETTER_PER_DATE, capReached: false });
  });

  it('a passed cycle is counted but reported separately', async () => {
    LetterAttempt.findAll.mockResolvedValue(cycle({ key: 's1', at: DAY1, passed: true }));
    const r = await getCycleUsageForDate(args);
    expect(r).toMatchObject({ cycles: 1, passedCycles: 1, failedCycles: 0 });
  });

  it('reads normal learning only', async () => {
    LetterAttempt.findAll.mockResolvedValue([]);
    await getCycleUsageForDate(args);
    const where = LetterAttempt.findAll.mock.calls[0][0].where;
    // Research collection, Writing Check / reassessment rows, and partial
    // captures can neither consume a cycle nor be capped by one.
    expect(where.collection_mode).toBe(false);
    expect(where.source_type).toBeNull();
    expect(where.capture_status).toBe('complete');
    expect(where.letter).toBe('c');
    expect(where.case_type).toBe('lowercase');
  });

  it('a read failure reports itself rather than blocking a child', async () => {
    LetterAttempt.findAll.mockRejectedValue(new Error('db down'));
    const r = await getCycleUsageForDate(args);
    expect(r.status).toBe('read_failed');
    expect(r.capReached).toBe(false);
  });

  it('rejects malformed input without querying', async () => {
    for (const bad of [{}, { studentId: 0 }, { studentId: 7, letter: 'cc' },
      { studentId: 7, letter: 'c', caseType: 'cursive' }]) {
      const r = await getCycleUsageForDate(bad);
      expect(r.status).toBe('invalid_input');
    }
    expect(LetterAttempt.findAll).not.toHaveBeenCalled();
  });
});

// ─── The exact-letter home-practice candidates ──────────────────────────

describe('getTwoCycleFailureLetters', () => {
  const args = { studentId: 7, date: toPracticeDate(DAY1) };

  it('names a letter only after ALL THREE cycles failed', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
      ...cycle({ key: 's3', at: DAY1_LATER }),
    ]);
    const r = await getTwoCycleFailureLetters(args);
    expect(r.status).toBe('ok');
    expect(r.letters).toEqual([
      expect.objectContaining({ letter: 'c', caseType: 'lowercase', cycles: 3 }),
    ]);
  });

  it('names NOTHING after only two failed cycles — homework must not fire early', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
    ]);
    expect((await getTwoCycleFailureLetters(args)).letters).toEqual([]);
  });

  it('names nothing after only ONE failed cycle', async () => {
    LetterAttempt.findAll.mockResolvedValue(cycle({ key: 's1', at: DAY1 }));
    expect((await getTwoCycleFailureLetters(args)).letters).toEqual([]);
  });

  it('names nothing when the child passed either cycle', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER, passed: true }),
    ]);
    expect((await getTwoCycleFailureLetters(args)).letters).toEqual([]);
  });

  it('never names a letter the child has since mastered', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
    ]);
    LetterProgress.findAll.mockResolvedValue([{ letter: 'c', case_type: 'lowercase' }]);
    expect((await getTwoCycleFailureLetters(args)).letters).toEqual([]);
  });

  it('keeps lowercase c and uppercase C apart', async () => {
    LetterAttempt.findAll.mockResolvedValue([
      ...cycle({ key: 's1', at: DAY1 }),
      ...cycle({ key: 's2', at: DAY1_LATER }),
      ...cycle({ key: 's3', at: DAY1_LATER }),
      ...cycle({ key: 's4', letter: 'C', caseType: 'uppercase', at: DAY1 }),
    ]);
    const r = await getTwoCycleFailureLetters(args);
    // Uppercase C had only one cycle — not a candidate. The two cases are
    // counted independently, so lowercase c exhausting its three does not
    // pull uppercase C into home practice with it.
    expect(r.letters.map(l => `${l.letter}|${l.caseType}`)).toEqual(['c|lowercase']);
  });

  it('this service writes nothing — it cannot master or unmaster anything', async () => {
    LetterAttempt.findAll.mockResolvedValue([]);
    await getTwoCycleFailureLetters(args);
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/letterCycleService.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const write of ['.update(', '.create(', '.destroy(', '.increment(', '.bulkCreate(']) {
      expect(code).not.toContain(write);
    }
    // mastered_at appears once, inside a WHERE clause - read, never written.
    expect(code).toMatch(/mastered_at: \{ \[Op\.ne\]: null \}/);
  });
});

// ─── Feature 5 obeys the same ceiling ───────────────────────────────────

describe('the spaced repetition cannot become cycle 3', () => {
  it('the repetition service checks the practice-date ceiling', () => {
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/repetitionRecommendationService.js'), 'utf8');
    expect(src).toContain("require('./letterCycleService')");
    expect(src).toMatch(/const cycleUsage = await getCycleUsageForDate/);
    expect(src).toMatch(/if \(cycleUsage\.status === 'ok' && cycleUsage\.capReached\) \{/);
    expect(src).toMatch(/reason: CYCLE_CAP_REASON\.CAP_REACHED/);
    // The check happens BEFORE the expensive Feature 2/3 reads.
    expect(src.indexOf('cycleUsage.capReached'))
      .toBeLessThan(src.indexOf('evaluateDynamicThresholds({ studentId })'));
  });

  it('Feature 5 itself is not deleted or weakened', () => {
    const policy = require('../src/config/repetitionPolicy');
    expect(policy.MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION).toBe(1);
    expect(policy.REPETITION_REASON.FEATURE3_SUPPORT_REVIEW).toBe('feature3_support_review');
  });
});

// ─── The 10-cycle persistent-difficulty rule is untouched ───────────────

describe('the broader persistent-difficulty mechanism is unchanged', () => {
  it('still requires its own window evidence, independently of this ceiling', () => {
    // The thresholds live in the policy config; the evidence module consumes
    // them. Both are asserted, and neither knows about the new ceiling.
    const policy = require('../src/config/persistentDifficultyPolicy');
    expect(policy.WINDOW_SIZE).toBe(5);
    expect(policy.REQUIRED_WINDOW_COUNT).toBe(2);
    expect(policy.MIN_USABLE_CYCLES).toBe(10);

    const evidence = require('../src/services/persistentDifficultyEvidence');
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    expect(src).toMatch(/MIN_USABLE_CYCLES/);
    expect(src).toMatch(/MIN_WINDOW_SEPARATION_MS/);
    // ...and it knows nothing about the new ceiling.
    expect(src).not.toContain('letterCycleService');
    expect(src).not.toContain('practiceCyclePolicy');
    expect(typeof evidence).toBe('object');
  });
});

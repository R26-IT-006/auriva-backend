'use strict';

// Mastery backfill (scripts/backfillLetterProgressMastery.js) verified in
// isolation. Its own module mocks live here rather than in
// letterProgressMasterySemantics.test.js, because that file mocks
// ../src/models for the CONTROLLER and those two mock shapes are different.

const mockLpFindAll = jest.fn();
const mockLpUpdate  = jest.fn();
const mockLaFindAll = jest.fn();

jest.mock('../src/models', () => ({
  LetterProgress: { findAll: (...a) => mockLpFindAll(...a), update: (...a) => mockLpUpdate(...a) },
  LetterAttempt:  { findAll: (...a) => mockLaFindAll(...a) },
  sequelize: { close: jest.fn() },
}));

const { backfillMastery } = require('../scripts/backfillLetterProgressMastery');

// ═══════════════════════════════════════════════════════════════════════════
// BACKFILL — derivation, idempotency, and the 5 known rows
// ═══════════════════════════════════════════════════════════════════════════

describe('5. the mastery backfill', () => {
  beforeEach(() => {
    mockLpFindAll.mockReset(); mockLpUpdate.mockReset(); mockLaFindAll.mockReset();
    mockLpUpdate.mockResolvedValue([1]);
  });

  const row = (o = {}) => ({
    id: 1, student_id: 10, letter: 'l', case_type: 'lowercase',
    blocked_attempts: 0, completed_at: new Date('2026-05-01T00:00:00.000Z'), ...o,
  });

  it('uses the attempt-3 row of the EARLIEST passing session', async () => {
    mockLpFindAll.mockResolvedValue([row()]);
    mockLaFindAll.mockResolvedValue([
      { session_key: 'S1', attempt_number: 1, created_at: new Date('2026-06-17T17:23:00.000Z') },
      { session_key: 'S1', attempt_number: 3, created_at: new Date('2026-06-17T17:23:39.099Z') },
      { session_key: 'S2', attempt_number: 3, created_at: new Date('2026-08-01T00:00:00.000Z') },
    ]);
    const { results } = await backfillMastery({ commit: false });
    expect(results[0].action).toBe('would_master');
    expect(results[0].source).toBe('attempt_3');
    expect(results[0].masteredAt).toEqual(new Date('2026-06-17T17:23:39.099Z'));
  });

  it('falls back to the session end when no attempt-3 row exists', async () => {
    mockLpFindAll.mockResolvedValue([row()]);
    mockLaFindAll.mockResolvedValue([
      { session_key: 'S1', attempt_number: 1, created_at: new Date('2026-06-17T10:00:00.000Z') },
      { session_key: 'S1', attempt_number: 2, created_at: new Date('2026-06-17T10:00:30.000Z') },
    ]);
    const { results } = await backfillMastery({ commit: false });
    expect(results[0].source).toBe('session_end');
    expect(results[0].masteredAt).toEqual(new Date('2026-06-17T10:00:30.000Z'));
  });

  it('leaves a row NULL when no passing session exists - the 5 known bad rows', async () => {
    mockLpFindAll.mockResolvedValue([
      row({ id: 1, student_id: 5,  letter: 'o' }),
      row({ id: 2, student_id: 10, letter: 'C', case_type: 'uppercase' }),
      row({ id: 3, student_id: 10, letter: 'g' }),
      row({ id: 4, student_id: 10, letter: 'n' }),
      row({ id: 5, student_id: 39, letter: 'i', blocked_attempts: 1 }),
    ]);
    mockLaFindAll.mockResolvedValue([]); // no passing sessions anywhere

    const { results, totals } = await backfillMastery({ commit: true });
    expect(totals.mastered).toBe(0);
    expect(totals.leftNull).toBe(5);
    for (const r of results) {
      expect(r.action).toBe('left_null');
      expect(r.reason).toBe('no_passing_session_recorded');
      expect(r.masteredAt).toBeNull();
    }
    expect(mockLpUpdate).not.toHaveBeenCalled();
  });

  it('never invents a timestamp - completed_at is never used as a source', () => {
    const src = require('fs').readFileSync(
      require.resolve('../scripts/backfillLetterProgressMastery.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function deriveMasteryEvent'), src.indexOf('async function backfillMastery'));
    expect(fn).not.toMatch(/completed_at/);
    expect(fn).not.toMatch(/new Date\(\)|Date\.now/);
    // Only a real passing, normal-learning session qualifies.
    expect(fn).toMatch(/passed: true/);
    expect(fn).toMatch(/collection_mode: false/);
    expect(fn).toMatch(/source_type: null/);
  });

  it('is dry-run by default - no write without --commit', async () => {
    mockLpFindAll.mockResolvedValue([row()]);
    mockLaFindAll.mockResolvedValue([
      { session_key: 'S1', attempt_number: 3, created_at: new Date('2026-06-17T17:23:39.099Z') },
    ]);
    await backfillMastery();
    expect(mockLpUpdate).not.toHaveBeenCalled();
  });

  it('is idempotent - only mastered_at IS NULL rows are candidates', async () => {
    mockLpFindAll.mockResolvedValue([]);
    const { totals } = await backfillMastery({ commit: true });
    expect(mockLpFindAll.mock.calls[0][0].where).toEqual({ mastered_at: null });
    expect(totals.candidates).toBe(0);
    expect(mockLpUpdate).not.toHaveBeenCalled();
  });

  it('re-checks NULL in the UPDATE, so a concurrent live mastery is never overwritten', async () => {
    mockLpFindAll.mockResolvedValue([row()]);
    mockLaFindAll.mockResolvedValue([
      { session_key: 'S1', attempt_number: 3, created_at: new Date('2026-06-17T17:23:39.099Z') },
    ]);
    await backfillMastery({ commit: true });
    expect(mockLpUpdate.mock.calls[0][1].where).toEqual({ id: 1, mastered_at: null });
  });

  it('writes exactly one column of exactly one table', async () => {
    mockLpFindAll.mockResolvedValue([row()]);
    mockLaFindAll.mockResolvedValue([
      { session_key: 'S1', attempt_number: 3, created_at: new Date('2026-06-17T17:23:39.099Z') },
    ]);
    await backfillMastery({ commit: true });
    expect(Object.keys(mockLpUpdate.mock.calls[0][0])).toEqual(['mastered_at']);
    // LetterAttempt is only ever read.
    const src = require('fs').readFileSync(
      require.resolve('../scripts/backfillLetterProgressMastery.js'), 'utf8');
    expect(src).not.toMatch(/LetterAttempt\.(update|create|destroy|bulkCreate)/);
  });
});

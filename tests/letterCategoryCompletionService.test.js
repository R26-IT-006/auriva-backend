'use strict';

// Feature 11B Phase 5 §6 — letterCategoryCompletionService.js verified in
// isolation. Only ../src/models is mocked (the DB boundary), matching this
// project's established convention.

const mockLpFindAll = jest.fn();

jest.mock('../src/models', () => ({
  LetterProgress: { findAll: (...a) => mockLpFindAll(...a) },
}));

const {
  isCategoryComplete, getAllCategoryCompletionStatus, getMasteredLetterPairs,
} = require('../src/services/letterCategoryCompletionService');

const STUDENT_ID = 7;

beforeEach(() => jest.clearAllMocks());

function progressRow(letter) { return { letter }; }

describe('isCategoryComplete', () => {
  it('Test 1 — every letter mastered -> complete: true, no missing', async () => {
    mockLpFindAll.mockResolvedValueOnce([progressRow('l'), progressRow('i'), progressRow('t')]);
    const result = await isCategoryComplete({ studentId: STUDENT_ID, caseType: 'lowercase', category: 'straight' });
    expect(result.status).toBe('found');
    expect(result.complete).toBe(true);
    expect(result.missingLetters).toEqual([]);
    expect(result.masteredLetters).toEqual(['l', 'i', 't']);
  });

  it('Test 2 — partial category (l, i mastered, t not) -> complete: false, missing: [t]', async () => {
    mockLpFindAll.mockResolvedValueOnce([progressRow('l'), progressRow('i')]);
    const result = await isCategoryComplete({ studentId: STUDENT_ID, caseType: 'lowercase', category: 'straight' });
    expect(result.status).toBe('found');
    expect(result.complete).toBe(false);
    expect(result.missingLetters).toEqual(['t']);
    expect(result.masteredLetters).toEqual(['l', 'i']);
  });

  it('Test 3 — nothing mastered -> complete: false, all letters missing', async () => {
    mockLpFindAll.mockResolvedValueOnce([]);
    const result = await isCategoryComplete({ studentId: STUDENT_ID, caseType: 'lowercase', category: 'straight' });
    expect(result.complete).toBe(false);
    expect(result.missingLetters).toEqual(['l', 'i', 't']);
  });

  it('queries LetterProgress scoped to this student, case_type, and exactly this category\'s letters', async () => {
    mockLpFindAll.mockResolvedValueOnce([]);
    await isCategoryComplete({ studentId: STUDENT_ID, caseType: 'uppercase', category: 'mixed' });
    const callArgs = mockLpFindAll.mock.calls[0][0];
    expect(callArgs.where.student_id).toBe(STUDENT_ID);
    expect(callArgs.where.case_type).toBe('uppercase');
    expect(callArgs.where.letter).toEqual(['D', 'P', 'B', 'V', 'Y', 'A', 'K', 'M', 'N', 'R', 'W', 'X', 'Z']);
  });

  it('rejects an invalid studentId without querying', async () => {
    const result = await isCategoryComplete({ studentId: -1, caseType: 'lowercase', category: 'straight' });
    expect(result.status).toBe('invalid_input');
    expect(mockLpFindAll).not.toHaveBeenCalled();
  });

  it('rejects an invalid category, without querying', async () => {
    const result = await isCategoryComplete({ studentId: STUDENT_ID, caseType: 'lowercase', category: 'nonsense' });
    expect(result.status).toBe('invalid_input');
    expect(mockLpFindAll).not.toHaveBeenCalled();
  });

  it('returns read_failed on an unexpected DB error, never throws', async () => {
    mockLpFindAll.mockRejectedValueOnce(new Error('connection reset'));
    const result = await isCategoryComplete({ studentId: STUDENT_ID, caseType: 'lowercase', category: 'straight' });
    expect(result.status).toBe('read_failed');
    expect(result.complete).toBeNull();
  });
});

describe('getAllCategoryCompletionStatus', () => {
  it('rolls up all 6 categories in one call', async () => {
    mockLpFindAll.mockResolvedValue([]); // nothing mastered anywhere
    const result = await getAllCategoryCompletionStatus({ studentId: STUDENT_ID });
    expect(result.status).toBe('found');
    expect(result.categories.length).toBe(6);
    expect(mockLpFindAll).toHaveBeenCalledTimes(6);
  });

  it('rejects an invalid studentId without querying', async () => {
    const result = await getAllCategoryCompletionStatus({ studentId: null });
    expect(result.status).toBe('invalid_input');
    expect(mockLpFindAll).not.toHaveBeenCalled();
  });
});

describe('getMasteredLetterPairs', () => {
  it('returns every (letter, caseType) pair straight from LetterProgress, no derivation', async () => {
    mockLpFindAll.mockResolvedValueOnce([
      { letter: 'l', case_type: 'lowercase' },
      { letter: 'i', case_type: 'lowercase' },
    ]);
    const result = await getMasteredLetterPairs({ studentId: STUDENT_ID });
    expect(result.status).toBe('found');
    expect(result.pairs).toEqual([
      { letter: 'l', caseType: 'lowercase' },
      { letter: 'i', caseType: 'lowercase' },
    ]);
  });

  it('is scoped to student_id only (no letter/case filter — the full mastered set)', async () => {
    mockLpFindAll.mockResolvedValueOnce([]);
    await getMasteredLetterPairs({ studentId: STUDENT_ID });
    expect(mockLpFindAll.mock.calls[0][0].where).toEqual({ student_id: STUDENT_ID });
  });

  it('returns read_failed on an unexpected DB error, never throws', async () => {
    mockLpFindAll.mockRejectedValueOnce(new Error('connection reset'));
    const result = await getMasteredLetterPairs({ studentId: STUDENT_ID });
    expect(result.status).toBe('read_failed');
    expect(result.pairs).toEqual([]);
  });
});

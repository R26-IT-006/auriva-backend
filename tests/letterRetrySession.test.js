'use strict';

// Capture-fault retry identity — the fix for duplicated attempt-1/2 rows.
//
// session_key is minted server-side per POST. When attempt 3 failed to
// capture, the retry was a NEW POST with a NEW key, and re-sent attempts 1
// and 2 alongside the fresh attempt 3:
//
//   session A:  A1(complete) A2(complete) A3(incomplete)
//   session B:  A1(complete) A2(complete) A3(complete)   <- A1/A2 duplicated
//
// Cycle COUNTING was always correct; the damage was to the research store.

const mockFindAll = jest.fn();
jest.mock('../src/models', () => ({
  LetterAttempt: { findAll: (...a) => mockFindAll(...a) },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  resolveRetrySessionKey, RETRY_REJECTION,
} = require('../src/services/letterRetrySessionService');
const { currentPracticeDate } = require('../src/config/practiceCyclePolicy');
const { CAPTURE_STATUS } = require('../src/utils/captureStatus');
const logger = require('../src/utils/logger');

const KEY   = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const STUDENT = 51;

// A timestamp that is unambiguously TODAY in the practice timezone.
const TODAY_AT = new Date();

function row(overrides = {}) {
  return {
    student_id: STUDENT, letter: 'c', case_type: 'lowercase',
    attempt_number: 1, collection_mode: false, source_type: null,
    capture_status: CAPTURE_STATUS.COMPLETE, created_at: TODAY_AT,
    ...overrides,
  };
}

/** The exact shape a capture-fault cycle leaves behind: A1, A2 complete; A3 incomplete. */
function captureFaultCycle() {
  return [
    row({ attempt_number: 1 }),
    row({ attempt_number: 2 }),
    row({ attempt_number: 3, capture_status: CAPTURE_STATUS.INCOMPLETE }),
  ];
}

const args = { studentId: STUDENT, letter: 'c', caseType: 'lowercase', retrySessionKey: KEY };

beforeEach(() => { jest.clearAllMocks(); });

// ─── A: the ordinary cycle is untouched ─────────────────────────────────

describe('A — a normal cycle never resumes anything', () => {
  it('no key sent -> not_requested, and the DB is never even queried', async () => {
    const r = await resolveRetrySessionKey({ ...args, retrySessionKey: undefined });
    expect(r.status).toBe('not_requested');
    expect(r.sessionKey).toBeNull();
    expect(mockFindAll).not.toHaveBeenCalled();
  });

  it('an explicit null is also not_requested', async () => {
    expect((await resolveRetrySessionKey({ ...args, retrySessionKey: null })).status)
      .toBe('not_requested');
  });
});

// ─── B: the capture-fault cycle resumes ─────────────────────────────────

describe('B — a capture-fault cycle is resumable', () => {
  it('accepts the key and reports which attempts are already stored', async () => {
    mockFindAll.mockResolvedValueOnce(captureFaultCycle());
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('accepted');
    expect(r.sessionKey).toBe(KEY);
    expect(r.reason).toBeNull();
    // Attempts 1 and 2 are already complete — the save path skips them, which
    // is what stops the duplication.
    expect(r.existingAttemptNumbers).toEqual([1, 2]);
  });

  it('attempt 3 is NOT reported as already stored — its row is incomplete', async () => {
    mockFindAll.mockResolvedValueOnce(captureFaultCycle());
    const r = await resolveRetrySessionKey(args);
    expect(r.existingAttemptNumbers).not.toContain(3);
  });
});

// ─── C: replay safety ───────────────────────────────────────────────────

describe('C — replaying the retry is safe', () => {
  it('resolving the same key twice yields the same accepted session', async () => {
    mockFindAll.mockResolvedValue(captureFaultCycle());
    const a = await resolveRetrySessionKey(args);
    const b = await resolveRetrySessionKey(args);
    expect(a.sessionKey).toBe(b.sessionKey);
    expect(b.status).toBe('accepted');
  });

  it('once attempt 3 IS complete the key stops being resumable', async () => {
    // This is what makes a replay converge instead of accumulating: after the
    // retry succeeds, the same key can never open the cycle again.
    mockFindAll.mockResolvedValueOnce([
      row({ attempt_number: 1 }), row({ attempt_number: 2 }), row({ attempt_number: 3 }),
    ]);
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.ALREADY_COMPLETE);
  });
});

// ─── D / E: ownership and scope ─────────────────────────────────────────

describe('D — a key naming another student is rejected', () => {
  it('rejects and logs the attempted cross-attachment', async () => {
    mockFindAll.mockResolvedValueOnce(captureFaultCycle().map(r => ({ ...r, student_id: 999 })));
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.STUDENT_MISMATCH);
    expect(r.sessionKey).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects even when only ONE row belongs to someone else', async () => {
    const rows = captureFaultCycle();
    rows[1] = { ...rows[1], student_id: 999 };
    mockFindAll.mockResolvedValueOnce(rows);
    expect((await resolveRetrySessionKey(args)).reason).toBe(RETRY_REJECTION.STUDENT_MISMATCH);
  });
});

describe('E — a key naming another letter or case is rejected', () => {
  it('rejects a different letter', async () => {
    mockFindAll.mockResolvedValueOnce(captureFaultCycle().map(r => ({ ...r, letter: 'o' })));
    expect((await resolveRetrySessionKey(args)).reason).toBe(RETRY_REJECTION.LETTER_MISMATCH);
  });

  it('rejects the same letter in the other case', async () => {
    mockFindAll.mockResolvedValueOnce(
      captureFaultCycle().map(r => ({ ...r, letter: 'C', case_type: 'uppercase' })));
    expect((await resolveRetrySessionKey(args)).reason).toBe(RETRY_REJECTION.LETTER_MISMATCH);
  });
});

// ─── F: practice date ───────────────────────────────────────────────────

describe('F — a cycle from another practice date cannot be resumed', () => {
  it('rejects yesterday’s partial cycle', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    mockFindAll.mockResolvedValueOnce(captureFaultCycle().map(r => ({ ...r, created_at: yesterday })));
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.DATE_MISMATCH);
  });

  it('today’s cycle is accepted — the date rule is the practice date, not UTC', async () => {
    mockFindAll.mockResolvedValueOnce(captureFaultCycle());
    expect((await resolveRetrySessionKey(args)).status).toBe('accepted');
    expect(currentPracticeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── G: a genuine coverage failure is finished business ─────────────────

describe('G — an evaluated failure can never be re-opened as a capture fault', () => {
  it('a coverage failure has a COMPLETE attempt 3, so the key is rejected', async () => {
    // Coverage failure: real strokes, real features, stored 'complete' — it
    // consumed its cycle and is done.
    mockFindAll.mockResolvedValueOnce([
      row({ attempt_number: 1 }), row({ attempt_number: 2 }),
      row({ attempt_number: 3, capture_status: CAPTURE_STATUS.COMPLETE }),
    ]);
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.ALREADY_COMPLETE);
  });

  it('SENTINEL — this is what stops a consumed cycle being resumed for a free retry', async () => {
    mockFindAll.mockResolvedValueOnce([
      row({ attempt_number: 1 }), row({ attempt_number: 2 }), row({ attempt_number: 3 }),
    ]);
    expect((await resolveRetrySessionKey(args)).sessionKey).toBeNull();
  });
});

// ─── H: Writing Check and research isolation ────────────────────────────

describe('H — Writing Check and research sessions keep their own identity', () => {
  it('a collection_mode session cannot be resumed', async () => {
    mockFindAll.mockResolvedValueOnce(captureFaultCycle().map(r => ({ ...r, collection_mode: true })));
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.NOT_NORMAL);
  });

  it('a row with a source_type (homework/review) cannot be resumed', async () => {
    mockFindAll.mockResolvedValueOnce(
      captureFaultCycle().map(r => ({ ...r, source_type: 'worksheet_review' })));
    expect((await resolveRetrySessionKey(args)).reason).toBe(RETRY_REJECTION.NOT_NORMAL);
  });
});

// ─── Malformed / missing / unreadable ───────────────────────────────────

describe('a key that cannot be trusted is ignored, never fatal', () => {
  it.each([
    ['not a uuid', 'abc'],
    ['empty string', ''],
    ['a number', 12345],
    ['an object', { key: KEY }],
    ['an array', [KEY]],
    ['sql-ish text', "' OR 1=1 --"],
  ])('%s -> malformed', async (_label, value) => {
    const r = await resolveRetrySessionKey({ ...args, retrySessionKey: value });
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.MALFORMED);
    expect(mockFindAll).not.toHaveBeenCalled();   // never even queried
  });

  it('an unknown key -> not_found', async () => {
    mockFindAll.mockResolvedValueOnce([]);
    expect((await resolveRetrySessionKey({ ...args, retrySessionKey: OTHER })).reason)
      .toBe(RETRY_REJECTION.NOT_FOUND);
  });

  it('a DB read failure degrades to rejected, never throws at the child', async () => {
    mockFindAll.mockRejectedValueOnce(new Error('connection lost'));
    const r = await resolveRetrySessionKey(args);
    expect(r.status).toBe('rejected');
    expect(r.reason).toBe(RETRY_REJECTION.READ_FAILED);
    expect(logger.error).toHaveBeenCalled();
  });

  it('every rejection returns a null sessionKey — the caller always mints fresh', async () => {
    mockFindAll.mockResolvedValue([]);
    for (const v of ['abc', OTHER]) {
      expect((await resolveRetrySessionKey({ ...args, retrySessionKey: v })).sessionKey).toBeNull();
    }
  });
});

// ─── The save path's three rules ────────────────────────────────────────

describe('the persistence rules that remove the duplicates', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');

  it('an already-complete attempt_number is SKIPPED, never re-inserted', () => {
    expect(src).toMatch(/if \(completeAlready\.has\(n\)\) continue;/);
  });

  it('an incomplete row is UPDATED in place rather than duplicated', () => {
    expect(src).toMatch(/LetterAttempt\.update\(row, \{ where: \{ id: incompleteRowId \} \}\)/);
  });

  it('identity columns are never rewritten by that update', () => {
    expect(src).toMatch(/delete row\.student_id; delete row\.letter; delete row\.case_type;/);
    expect(src).toMatch(/delete row\.session_key; delete row\.attempt_number;/);
  });

  it('the ordinary path is still an unmodified bulk insert', () => {
    expect(src).toMatch(/if \(!resumedSessionKey\) \{\s*return LetterAttempt\.bulkCreate\(attempts\.map\(buildRow\)\);/);
  });

  it('SENTINEL — the retry key is resolved AFTER the ownership check', () => {
    const ownershipAt = src.indexOf('await teacherService.getOwnStudentById(req.user.id, Number(student_id));');
    const resolveAt   = src.indexOf('const retryResolution = await resolveRetrySessionKey(');
    expect(ownershipAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(ownershipAt);
  });

  it('SENTINEL — retry_session_key is returned ONLY on a capture fault', () => {
    expect(src).toMatch(/retry_session_key: captureIncomplete \? sessionKey : null/);
  });
});

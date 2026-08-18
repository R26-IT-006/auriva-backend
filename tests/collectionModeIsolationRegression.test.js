'use strict';

// Final integration audit, Part B — mandatory collection-mode isolation
// regression tests (spec §41/§42/§43). Uses the REAL persistentDifficultyEvidence
// + persistentDifficultyService chain (only ../src/models is mocked — the
// one real DB-touching boundary), matching feature9EndToEndOrchestration.test.js's
// own established "mock only the DB, use the real service chain" convention.
// Also covers the controller-level Student Progress Report regression (§43)
// via getLetterProgressReport with a mocked LetterAttempt.findAll.

const mockLaFindAll = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: { findAll: (...a) => mockLaFindAll(...a) },
}));

const { evaluatePersistentDifficulty } = require('../src/services/persistentDifficultyService');
const { PERSISTENT_DIFFICULTY_STATUSES } = require('../src/config/persistentDifficultyPolicy');
const { getLetterProgressReport } = require('../src/controllers/handwritingController');

const STUDENT_ID = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

let idCounter;
beforeEach(() => {
  jest.clearAllMocks();
  idCounter = 1;
});
function nextId() { return idCounter++; }

// ─── Fixtures (mirrors feature9EndToEndOrchestration.test.js's own proven-
// persistent construction, so a normal-data-only run is a known-good
// baseline to compare a collection-noise-added run against) ────────────────

function row({ letter, caseType = 'lowercase', createdAtMs, success, collectionMode = false, sessionKey, id }) {
  return {
    id: id ?? nextId(),
    student_id: STUDENT_ID,
    letter, case_type: caseType,
    session_key: sessionKey ?? `s-${letter}-${collectionMode ? 'col' : 'norm'}-${createdAtMs}-${nextId()}`,
    attempt_number: 3,
    collection_mode: collectionMode,
    capture_status: 'complete',
    best_score: success ? 90 : 20,
    threshold: 55,
    threshold_passed: null,
    created_at: new Date(createdAtMs),
  };
}

function makeWindow({ letters, caseType = 'lowercase', startMs, successCount, collectionMode = false }) {
  return Array.from({ length: 5 }, (_, i) => row({
    letter: letters[i % letters.length], caseType,
    createdAtMs: startMs + i * 60 * 1000,
    success: i < successCount,
    collectionMode,
  }));
}

function persistentStreamRows({ letters, caseType = 'lowercase', offsetMs = 0, collectionMode = false }) {
  const earlier = makeWindow({ letters, caseType, startMs: offsetMs, successCount: 1, collectionMode });
  const recent = makeWindow({ letters, caseType, startMs: offsetMs + 2 * DAY_MS, successCount: 0, collectionMode });
  return [...earlier, ...recent];
}

// ─── §41 — Mixed-history regression: collection noise must contribute ZERO ──

describe('Mixed-history — 5 collection-mode rows + 5 normal successful rows behaves exactly as 5 normal rows alone', () => {
  it('produces an identical evaluatePersistentDifficulty result with or without the collection noise', async () => {
    const normalOnly = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 5 }); // 5 normal successes
    const collectionNoise = makeWindow({ letters: ['c', 'o'], startMs: 10 * DAY_MS, successCount: 0, collectionMode: true }); // 5 collection failures, far away in time

    mockLaFindAll.mockResolvedValueOnce(normalOnly);
    const baseline = await evaluatePersistentDifficulty({ studentId: STUDENT_ID });

    mockLaFindAll.mockResolvedValueOnce([...normalOnly, ...collectionNoise]);
    const withNoise = await evaluatePersistentDifficulty({ studentId: STUDENT_ID });

    expect(withNoise.streams.lowercase.curved).toEqual(baseline.streams.lowercase.curved);
    expect(withNoise.summary).toEqual(baseline.summary);
  });
});

describe('Mixed-history reversed — 5 collection-mode successes + 5 normal failures behaves exactly as 5 normal failures alone', () => {
  it('produces an identical evaluatePersistentDifficulty result with or without the collection noise', async () => {
    const normalOnly = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 0 }); // 5 normal failures
    const collectionNoise = makeWindow({ letters: ['c', 'o'], startMs: 10 * DAY_MS, successCount: 5, collectionMode: true }); // 5 collection successes

    mockLaFindAll.mockResolvedValueOnce(normalOnly);
    const baseline = await evaluatePersistentDifficulty({ studentId: STUDENT_ID });

    mockLaFindAll.mockResolvedValueOnce([...normalOnly, ...collectionNoise]);
    const withNoise = await evaluatePersistentDifficulty({ studentId: STUDENT_ID });

    expect(withNoise.streams.lowercase.curved).toEqual(baseline.streams.lowercase.curved);
    expect(withNoise.summary).toEqual(baseline.summary);
  });
});

// ─── §42 — Feature 7 strongest regression (MANDATORY) ───────────────────────

describe('Feature 7 strongest regression (mandatory) — 10 difficult collection-mode cycles + insufficient normal data', () => {
  it('resolves insufficient_data, NEVER persistent', async () => {
    // A full two-window "persistent difficulty" shape (10 cycles, all failing,
    // properly separated), but every row is collection_mode=true.
    const collectionOnly = persistentStreamRows({ letters: ['c', 'o'], collectionMode: true });
    mockLaFindAll.mockResolvedValueOnce(collectionOnly);

    const result = await evaluatePersistentDifficulty({ studentId: STUDENT_ID });

    expect(result.streams.lowercase.curved.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(result.streams.lowercase.curved.status).not.toBe(PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT);
  });

  it('the exact same shape, but collection_mode=false, DOES resolve persistent — proving the difference is caused only by the collection flag', async () => {
    const normalEquivalent = persistentStreamRows({ letters: ['c', 'o'], collectionMode: false });
    mockLaFindAll.mockResolvedValueOnce(normalEquivalent);

    const result = await evaluatePersistentDifficulty({ studentId: STUDENT_ID });

    expect(result.streams.lowercase.curved.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT);
  });
});

// ─── §43 — Progress-report strongest regression (mandatory) ────────────────

describe('Progress-report strongest regression (mandatory) — 20 collection-mode + 2 normal LetterAttempt rows', () => {
  it('getLetterProgressReport queries with collection_mode: false, and reflects only the 2 normal attempts', async () => {
    // The controller's own query already filters at the DB level — this
    // test proves BOTH that the filter is present in the query AND that a
    // mock standing in for a real DB honoring that filter yields exactly 2,
    // never 22.
    mockLaFindAll.mockImplementationOnce(async ({ where }) => {
      expect(where.collection_mode).toBe(false); // the query itself must ask for normal-mode only
      // A real DB would never return the 20 collection rows for this
      // filtered query — simulate that correctly-filtered result here.
      return [
        { letter: 'c', case_type: 'lowercase', session_key: 's1', best_score: 80, created_at: new Date(0) },
        { letter: 'c', case_type: 'lowercase', session_key: 's2', best_score: 90, created_at: new Date(1000) },
      ];
    });

    const req = { params: { studentId: String(STUDENT_ID) } };
    const jsonMock = jest.fn();
    const res = { json: jsonMock };

    await getLetterProgressReport(req, res);

    const body = jsonMock.mock.calls[0][0];
    const cLetter = body.letters.find((l) => l.letter === 'c' && l.case_type === 'lowercase');
    expect(cLetter.attempts).toBe(2); // not 22
    expect(cLetter.sessions).toBe(2);
  });
});

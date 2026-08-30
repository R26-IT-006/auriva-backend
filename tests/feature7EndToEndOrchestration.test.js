'use strict';

// Feature 7 Step 6 — Final End-to-End Validation + Closure.
//
// Drives the REAL evaluatePersistentDifficulty() through the REAL
// persistentDifficultyEvidence.js helpers, mocking only ../src/models
// (same convention as persistentDifficultyServiceReadOnly.test.js /
// persistentDifficultyArchitectureDecision.test.js) — this is the final
// acceptance re-statement of the whole Feature 7 chain, not a duplicate of
// Step 2/3/4's own granular unit coverage. Endpoint/CLI items (23-25) are
// re-confirmed via source-scan here, matching Step 4's own
// "re-confirmation" convention — the full mocked-controller/CLI test suites
// already live in getPersistentDifficultyEndpoint.test.js and
// dryRunPersistentDifficulty.test.js.

const mockLaFindAll = jest.fn();
const mockLaCreate = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate = jest.fn();
const mockLaDestroy = jest.fn();
const mockLaSave = jest.fn();
const mockLaIncrement = jest.fn();
const mockLaFindOrCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate,
    destroy: mockLaDestroy, save: mockLaSave, increment: mockLaIncrement,
    findOrCreate: mockLaFindOrCreate,
  },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const { evaluatePersistentDifficulty } = require('../src/services/persistentDifficultyService');
const { PERSISTENT_DIFFICULTY_STATUSES, PERSISTENT_DIFFICULTY_REASONS, MIN_WINDOW_SEPARATION_MS } = require('../src/config/persistentDifficultyPolicy');

const DAY_MS = 24 * 60 * 60 * 1000;

let idCounter;
beforeEach(() => {
  jest.clearAllMocks();
  idCounter = 1;
});
function nextId() { return idCounter++; }

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

/** One synthetic candidate row (attempt-3, normal-mode, complete). */
function row({ letter, caseType = 'lowercase', createdAtMs, success, sessionKey, id }) {
  return {
    id: id ?? nextId(),
    student_id: 99,
    letter, case_type: caseType,
    session_key: sessionKey ?? `s-${letter}-${createdAtMs}-${nextId()}`,
    attempt_number: 3,
    collection_mode: false,
    capture_status: 'complete',
    best_score: success ? 90 : 20,
    threshold: 55,
    threshold_passed: null,
    created_at: new Date(createdAtMs),
  };
}

/** Builds a 5-cycle window alternating between two letters of the same
 * family, `successCount` of the 5 successful (first `successCount`, in
 * chronological order), starting at `startMs`, one minute apart. */
function makeWindow({ letters, caseType = 'lowercase', startMs, successCount }) {
  return Array.from({ length: 5 }, (_, i) => row({
    letter: letters[i % letters.length], caseType,
    createdAtMs: startMs + i * 60 * 1000,
    success: i < successCount,
  }));
}

// ─── Item 1 — <10 cycles -> insufficient_cycles ────────────────────────────

describe('Item 1 — <10 cycles -> insufficient_cycles', () => {
  it.each([0, 2, 5, 9])('%i cycles remains insufficient_data/insufficient_cycles', async (count) => {
    const cycles = Array.from({ length: count }, (_, i) => row({ letter: 'o', createdAtMs: i * 60000, success: true }));
    mockLaFindAll.mockResolvedValueOnce(cycles);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_CYCLES);
    expect(stream.usableCycleCount).toBe(count);
  });
});

// ─── Item 2 — 10 failed cycles, same burst -> insufficient_temporal_dispersion ──

describe('Item 2 — 10 failed cycles within one burst -> insufficient_temporal_dispersion', () => {
  it('45 minutes total span never qualifies, regardless of failure rate', async () => {
    const cycles = Array.from({ length: 10 }, (_, i) => row({ letter: 'o', createdAtMs: i * 5 * 60 * 1000, success: false })); // 5 min apart, 45 min total
    mockLaFindAll.mockResolvedValueOnce(cycles);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION);
  });
});

// ─── Item 3 — two difficult separated windows -> persistent ───────────────

describe('Item 3 — two difficult windows separated by >=24h -> persistent', () => {
  it('earlier 1/5, recent 0/5, gap 48h', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS);
  });
});

// ─── Item 4 — earlier good + recent difficult ──────────────────────────────

describe('Item 4 — earlier good, recent difficult -> not_persistent/recent_difficulty_not_yet_persistent', () => {
  it('earlier 4/5, recent 1/5, gap 48h', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 4 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 1 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.RECENT_DIFFICULTY_NOT_YET_PERSISTENT);
  });
});

// ─── Item 5 — earlier difficult + recent good ──────────────────────────────

describe('Item 5 — earlier difficult, recent good -> not_persistent/recent_improvement', () => {
  it('earlier 1/5, recent 4/5, gap 48h — never called "resolved"', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 4 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.RECENT_IMPROVEMENT);
    expect(stream.status).not.toBe('resolved');
  });
});

// ─── Item 6 — both good -> no_persistent_difficulty ────────────────────────

describe('Item 6 — both windows good -> not_persistent/no_persistent_difficulty', () => {
  it('earlier 4/5, recent 5/5, gap 48h', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 4 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 5 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.NO_PERSISTENT_DIFFICULTY);
  });
});

// ─── Items 7/8 — exact separation boundary ─────────────────────────────────

describe('Item 7 — exact 24h separation accepted', () => {
  it('separationMs === MIN_WINDOW_SEPARATION_MS exactly still qualifies', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 0 });
    // earlier's last cycle is at offset 4*60000ms; recent's first cycle
    // must be at least MIN_WINDOW_SEPARATION_MS after that.
    const recent = makeWindow({ letters: ['c', 'o'], startMs: MIN_WINDOW_SEPARATION_MS + 4 * 60000, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.separationMs).toBe(MIN_WINDOW_SEPARATION_MS);
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT);
  });
});

describe('Item 8 — 24h minus one millisecond rejected', () => {
  it('separationMs one millisecond under the boundary falls back to insufficient_temporal_dispersion', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 0 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: MIN_WINDOW_SEPARATION_MS + 4 * 60000 - 1, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    expect(stream.separationMs).toBe(MIN_WINDOW_SEPARATION_MS - 1);
    expect(stream.status).toBe(PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA);
    expect(stream.reason).toBe(PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION);
  });
});

// ─── Item 9 — ambiguous letters excluded ───────────────────────────────────

describe('Item 9 — ambiguous letters excluded from every family', () => {
  it('letter "a" (ambiguous) never contributes a cycle to straight, curved, or complex', async () => {
    const ambiguousCycles = Array.from({ length: 10 }, (_, i) => row({ letter: 'a', createdAtMs: i * DAY_MS, success: i < 5 }));
    mockLaFindAll.mockResolvedValueOnce(ambiguousCycles);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    for (const family of ['straight', 'curved', 'complex']) {
      expect(result.streams.lowercase[family].validCycleCount).toBe(0);
    }
  });
});

// ─── Item 10 — lowercase/uppercase separated ───────────────────────────────

describe('Item 10 — lowercase and uppercase evidence never mixed', () => {
  it('an uppercase C cycle never contributes to the lowercase curved stream', async () => {
    const lowercaseCycles = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 })
      .concat(makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 0 }));
    const uppercaseCycles = Array.from({ length: 3 }, (_, i) => row({ letter: 'C', caseType: 'uppercase', createdAtMs: i * DAY_MS, success: true }));
    mockLaFindAll.mockResolvedValueOnce([...lowercaseCycles, ...uppercaseCycles]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    expect(result.streams.lowercase.curved.status).toBe('persistent'); // unaffected by the uppercase rows
    expect(result.streams.uppercase.curved.validCycleCount).toBe(3); // only its own 3, never the lowercase 10
  });
});

// ─── Item 11 — duplicate session deduped ───────────────────────────────────

describe('Item 11 — duplicate session_key rows deduped, never inflating evidence', () => {
  it('two rows sharing a session_key count as ONE cycle', async () => {
    const dup1 = row({ letter: 'o', createdAtMs: 0, success: true, sessionKey: 'dup', id: 1 });
    const dup2 = row({ letter: 'o', createdAtMs: 1000, success: false, sessionKey: 'dup', id: 2 }); // newer, same session
    mockLaFindAll.mockResolvedValueOnce([dup1, dup2]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    expect(result.streams.lowercase.curved.validCycleCount).toBe(1);
  });
});

// ─── Item 12 — unknown outcome skipped ─────────────────────────────────────

describe('Item 12 — unknown-outcome cycles never occupy one of the 10 required slots', () => {
  it('an unresolvable cycle (no score, no threshold_passed) is skipped, and an older usable cycle is pulled in instead', async () => {
    const usable = Array.from({ length: 10 }, (_, i) => row({ letter: 'o', createdAtMs: i * DAY_MS, success: i % 2 === 0 }));
    const unknown = { ...row({ letter: 'o', createdAtMs: 10 * DAY_MS, success: true }), best_score: null, threshold: null, threshold_passed: null };
    mockLaFindAll.mockResolvedValueOnce([...usable, unknown]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    // 11 total cycles, 1 unknown -> 10 usable -> a valid two-window split still occurs.
    expect(stream.usableCycleCount).toBe(10);
    expect(stream.validCycleCount).toBe(11); // all reconstructed cycles, including the unknown one
    expect(stream.status).not.toBe('insufficient_data'); // two complete windows were still formed
  });
});

// ─── Items 13-19 — no live-decision / cross-feature dependencies ──────────

describe('Items 13-19 — current-threshold, Feature 2-6, and baseline independence (source-scan)', () => {
  function requireLinesOf(file) {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    return source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
  }

  it('Item 13 — current threshold never queried (no getCurrentFamilyThreshold/evaluateDynamicThresholds import)', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/dynamicThresholdService/);
  });

  it('Item 14 — Feature 2 service never imported', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/dynamicThresholdService/);
  });

  it('Item 15 — Feature 3 service never imported', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/adaptiveSupportService/);
  });

  it('Item 16 — Feature 4 service never imported', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/adaptivePreWritingService/);
  });

  it('Item 17 — Feature 5 service never imported', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/repetitionRecommendationService/);
  });

  it('Item 18 — Feature 6 service never imported', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/demoSpeedRecommendationService/);
  });

  it('Item 19 — StudentMotorBaseline never imported', () => {
    const req = requireLinesOf('../src/services/persistentDifficultyEvidence.js') + requireLinesOf('../src/services/persistentDifficultyService.js');
    expect(req).not.toMatch(/StudentMotorBaseline/);
  });
});

// ─── Items 20-22 — blocked_attempts / ThresholdHistory / timing exclusion ──

describe('Items 20-22 — blocked_attempts / ThresholdHistory / timing metrics never used', () => {
  function codeOnlyOf(file) {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  it('Item 20 — blocked_attempts never referenced in actual code', () => {
    const code = codeOnlyOf('../src/services/persistentDifficultyEvidence.js') + codeOnlyOf('../src/services/persistentDifficultyService.js');
    expect(code).not.toMatch(/blocked_attempts/);
  });

  it('Item 21 — ThresholdHistory never imported', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/ThresholdHistory/);
  });

  it('Item 22 — no raw timing metric used as a trigger input', () => {
    const code = codeOnlyOf('../src/services/persistentDifficultyEvidence.js') + codeOnlyOf('../src/services/persistentDifficultyService.js');
    expect(code).not.toMatch(/attempt_duration_ms|attempt_avg_speed|pause_frequency|pause_duration_ratio/);
  });
});

// ─── Item 23 — endpoint ownership (re-confirmation) ────────────────────────

describe('Item 23 — endpoint ownership re-confirmation', () => {
  it('getPersistentDifficulty checks teacherService.getOwnStudentById before calling the service', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getPersistentDifficulty[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const ownershipIdx = match[0].indexOf('getOwnStudentById');
    const serviceIdx = match[0].indexOf('evaluatePersistentDifficulty(');
    expect(ownershipIdx).toBeGreaterThan(-1);
    expect(serviceIdx).toBeGreaterThan(-1);
    expect(ownershipIdx).toBeLessThan(serviceIdx);
  });
});

// ─── Item 24 — endpoint no raw-attempt leakage (re-confirmation) ──────────

describe('Item 24 — endpoint no raw-attempt leakage re-confirmation', () => {
  it('the handler never references stroke_points/normalized_features/session_key in its own response construction', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getPersistentDifficulty[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/stroke_points|normalized_features|session_key/);
  });
});

// ─── Item 25 — CLI read-only re-confirmation ───────────────────────────────

describe('Item 25 — CLI read-only re-confirmation', () => {
  it('dryRunPersistentDifficulty.js hard-rejects --apply and has zero write-method references', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/scripts/dryRunPersistentDifficulty.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).toMatch(/--apply.*is not supported/s);
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(|\.save\(|transaction\(/);
  });
});

// ─── Item 26 — exactly one DB read ─────────────────────────────────────────

describe('Item 26 — service performs exactly one DB read per evaluation', () => {
  it('findAll is called exactly once regardless of how many streams have evidence', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    await evaluatePersistentDifficulty({ studentId: 99 });
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
  });
});

// ─── Item 27 — no writes anywhere ──────────────────────────────────────────

describe('Item 27 — no writes anywhere across the full chain', () => {
  it('a full persistent-triggering evaluation still performs zero writes', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    await evaluatePersistentDifficulty({ studentId: 99 });
    expectNoWrites();
  });
});

// ─── Item 28 — no persistence model/table/migration ────────────────────────

describe('Item 28 — no persistence model, table, or migration exists', () => {
  it('src/models has no PersistentDifficulty*.js file and models/index.js never registers one', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../src/models'));
    expect(files.some((f) => /persistentdifficulty/i.test(f))).toBe(false);
    const indexSource = fs.readFileSync(path.resolve(__dirname, '../src/models/index.js'), 'utf8');
    expect(indexSource).not.toMatch(/persistentDifficulty/i);
  });

  it('migrations directory has no persistent-difficulty migration', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../migrations'));
    expect(files.some((f) => /persistent.?difficulty/i.test(f))).toBe(false);
  });
});

// ─── Item 29 — affectedLetters from exact selected evidence ───────────────

describe('Item 29 — affectedLetters reflects only the 10 selected cycles', () => {
  it('a letter with cycles OUTSIDE the selected window never appears in affectedLetters', async () => {
    // 5 old 's' cycles that will be pushed out once 'c'/'o' cycles fill the
    // latest-10 window.
    const oldS = Array.from({ length: 5 }, (_, i) => row({ letter: 's', createdAtMs: -100 * DAY_MS + i * 60000, success: true }));
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...oldS, ...earlier, ...recent]);
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;
    const letters = stream.affectedLetters.map((l) => l.letter);
    expect(letters).not.toContain('s');
    expect(letters.sort()).toEqual(['c', 'o']);
  });
});

// ─── Item 30 — summary counts correct ──────────────────────────────────────

describe('Item 30 — summary counts correct across a mixed six-stream evaluation', () => {
  it('one persistent stream + five insufficient streams tally correctly', async () => {
    const earlier = makeWindow({ letters: ['c', 'o'], startMs: 0, successCount: 1 });
    const recent = makeWindow({ letters: ['c', 'o'], startMs: 2 * DAY_MS, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]); // only lowercase::curved has any evidence
    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    expect(result.summary.evaluatedStreamCount).toBe(6);
    expect(result.summary.persistentCount).toBe(1);
    expect(result.summary.notPersistentCount).toBe(0);
    expect(result.summary.insufficientDataCount).toBe(5);
    expect(result.summary.persistentStreams).toEqual([{ caseType: 'lowercase', family: 'curved' }]);
  });
});

// ─── §49 — Full synthetic persistent headline scenario ─────────────────────

describe('§49 — full synthetic persistent headline scenario (Student X, lowercase curved)', () => {
  it('Monday: c fail, c fail, o success, o fail, c fail (1/5) | Wednesday: c fail, o fail, c fail, o fail, c fail (0/5), gap >24h -> persistent', async () => {
    const monday = new Date('2026-03-02T09:00:00.000Z').getTime(); // a Monday
    const earlier = [
      row({ letter: 'c', createdAtMs: monday + 0, success: false }),
      row({ letter: 'c', createdAtMs: monday + 60000, success: false }),
      row({ letter: 'o', createdAtMs: monday + 120000, success: true }),
      row({ letter: 'o', createdAtMs: monday + 180000, success: false }),
      row({ letter: 'c', createdAtMs: monday + 240000, success: false }),
    ];
    const wednesday = monday + 2 * DAY_MS + 5 * 60 * 60 * 1000; // Monday + ~2.2 days, comfortably >=24h after earlier's last cycle
    const recent = [
      row({ letter: 'c', createdAtMs: wednesday + 0, success: false }),
      row({ letter: 'o', createdAtMs: wednesday + 60000, success: false }),
      row({ letter: 'c', createdAtMs: wednesday + 120000, success: false }),
      row({ letter: 'o', createdAtMs: wednesday + 180000, success: false }),
      row({ letter: 'c', createdAtMs: wednesday + 240000, success: false }),
    ];
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);

    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;

    expect(stream.status).toBe('persistent');
    expect(stream.reason).toBe('repeated_difficulty_across_windows');
    expect(stream.earlierWindow.successfulCycles).toBe(1);
    expect(stream.recentWindow.successfulCycles).toBe(0);

    const byLetter = Object.fromEntries(stream.affectedLetters.map((l) => [l.letter, l]));
    expect(byLetter.c).toEqual({ letter: 'c', totalCycles: 6, failedCycles: 6 });
    expect(byLetter.o).toEqual({ letter: 'o', totalCycles: 4, failedCycles: 3 });
    expect(Object.keys(byLetter).sort()).toEqual(['c', 'o']);

    expectNoWrites();
  });
});

// ─── §50 — Full synthetic anti-burst headline scenario ──────────────────────

describe('§50 — full synthetic anti-burst headline scenario (Student Y, lowercase curved)', () => {
  it('10 failed cycles within 30 minutes -> insufficient_data/insufficient_temporal_dispersion, never persistent', async () => {
    const start = new Date('2026-03-05T14:00:00.000Z').getTime();
    const burst = Array.from({ length: 10 }, (_, i) => row({
      letter: i % 2 === 0 ? 'c' : 'o', createdAtMs: start + i * 3 * 60 * 1000, success: false, // 3 min apart, 27 min total span
    }));
    mockLaFindAll.mockResolvedValueOnce(burst);

    const result = await evaluatePersistentDifficulty({ studentId: 99 });
    const stream = result.streams.lowercase.curved;

    expect(stream.status).toBe('insufficient_data');
    expect(stream.reason).toBe('insufficient_temporal_dispersion');
    expect(stream.status).not.toBe('persistent');
    expect(stream.separationMs).toBeLessThan(MIN_WINDOW_SEPARATION_MS);

    expectNoWrites();
  });
});

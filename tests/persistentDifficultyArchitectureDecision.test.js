'use strict';

// Feature 7 Step 4 — Persistence/History Architecture Decision tests.
//
// This step is primarily architecture + validation, not new production
// code — no migration, no model, no history table exists (see
// docs/feature7-persistence-design.md for the deferred design). This file
// proves the claims the Step 4 decision rests on: the REAL service (mocking
// only ../src/models, same convention as
// persistentDifficultyServiceReadOnly.test.js) is deterministic, naturally
// transitions as new evidence arrives with no invalidation mechanism
// needed, and remains fully read-only — the core argument for deferring
// persistence.

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

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
let idCounter;
beforeEach(() => { idCounter = 1; });
function nextId() { return idCounter++; }

/** Builds `count` synthetic attempt-3 rows for (letter, caseType), one per
 * `startMs + i*offsetStepMs`, `outcomeSuccessCount` of them scored above
 * threshold. */
function makeCycles({ letter, caseType, startMs, count, successCount, offsetStepMs = 60 * 1000 }) {
  return Array.from({ length: count }, (_, i) => ({
    id: nextId(),
    student_id: 13,
    letter, case_type: caseType,
    session_key: `s-${letter}-${startMs}-${i}`,
    attempt_number: 3,
    collection_mode: false,
    capture_status: 'complete',
    best_score: i < successCount ? 90 : 20,
    threshold: 55,
    threshold_passed: null,
    created_at: new Date(startMs + i * offsetStepMs),
  }));
}

function stripEvaluatedAt(result) {
  const { evaluatedAt, ...rest } = result;
  return rest;
}

// ─── Item 45.1 — service produces current status without persistence ──────

describe('Architecture Test 1 — the service produces the current status entirely from live LetterAttempt evidence, without persistence', () => {
  it('a fully-populated persistent stream is computed with zero DB tables beyond LetterAttempt', async () => {
    const earlier = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 0, count: 5, successCount: 1 });
    const recent = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 2 * DAY_MS, count: 5, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.status).toBe('evaluated');
    expect(result.streams.lowercase.curved.status).toBe('persistent');
  });
});

// ─── Item 45.2 — repeated identical evidence -> identical results ─────────

describe('Architecture Test 2 (spec §24/§25) — repeated identical evidence produces identical stream results', () => {
  it('calling evaluatePersistentDifficulty twice over the exact same evidence yields deep-equal results (ignoring evaluatedAt)', async () => {
    const earlier = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 0, count: 5, successCount: 1 });
    const recent = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 2 * DAY_MS, count: 5, successCount: 0 });

    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const first = await evaluatePersistentDifficulty({ studentId: 13 });

    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const second = await evaluatePersistentDifficulty({ studentId: 13 });

    expect(stripEvaluatedAt(first)).toEqual(stripEvaluatedAt(second));
    // Sanity: evaluatedAt itself is present as a real timestamp on both —
    // it is the ONE field deliberately excluded from the equality check
    // above, precisely because it is expected to differ (or coincide) by
    // wall-clock time, never because the underlying evaluation differs.
    expect(typeof first.evaluatedAt).toBe('string');
    expect(typeof second.evaluatedAt).toBe('string');
  });
});

// ─── Item 45.3 / spec §26 — a new cycle can change the computed result ────

describe('Architecture Test 3 (spec §26) — new evidence naturally transitions the result, with no invalidation mechanism', () => {
  it('insufficient_data (2 cycles) -> persistent (10 cycles matching the difficulty pattern), same stream, same call shape', async () => {
    const sparse = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 0, count: 2, successCount: 2 });
    mockLaFindAll.mockResolvedValueOnce(sparse);
    const before = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(before.streams.lowercase.curved.status).toBe('insufficient_data');
    expect(before.streams.lowercase.curved.reason).toBe('insufficient_cycles');

    const earlier = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 0, count: 5, successCount: 1 });
    const recent = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 2 * DAY_MS, count: 5, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const after = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(after.streams.lowercase.curved.status).toBe('persistent');

    // No cache, no invalidation call, no state carried between the two
    // calls other than what the (mocked) database itself returned.
    expect(mockLaFindAll).toHaveBeenCalledTimes(2);
  });
});

// ─── Item 45.4 / spec §27 — later success can change a prior persistent result ──

describe('Architecture Test 4 (spec §27) — later successful evidence shifts the rolling window away from a prior persistent result', () => {
  it('persistent -> not_persistent/recent_improvement as new successful cycles enter the 10-cycle window (never called "resolved")', async () => {
    const earlier = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 0, count: 5, successCount: 1 });
    const recentDifficult = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 2 * DAY_MS, count: 5, successCount: 0 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recentDifficult]);
    const before = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(before.streams.lowercase.curved.status).toBe('persistent');

    // New successful cycles arrive 2 more days later — the rolling "latest
    // 10 usable cycles" window now drops the original `earlier` 5 entirely;
    // the old `recentDifficult` 5 becomes the NEW earlier window, and the
    // new successful 5 becomes the NEW recent window.
    const newSuccess = makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 4 * DAY_MS, count: 5, successCount: 5 });
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recentDifficult, ...newSuccess]);
    const after = await evaluatePersistentDifficulty({ studentId: 13 });

    const stream = after.streams.lowercase.curved;
    expect(stream.status).toBe('not_persistent');
    expect(stream.reason).toBe('recent_improvement');
    expect(stream.status).not.toBe('resolved'); // v1 has no resolved status at all
  });
});

// ─── Item 45.5 — no invalidation cache exists/is needed ───────────────────

describe('Architecture Test 5 — no invalidation cache exists', () => {
  it('the service file never references a cache/memoization mechanism', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyService.js'), 'utf8');
    expect(source).not.toMatch(/cache|memoiz/i);
  });

  it('two back-to-back calls with DIFFERENT mocked evidence never see a stale result from the first call', async () => {
    mockLaFindAll.mockResolvedValueOnce(makeCycles({ letter: 'o', caseType: 'lowercase', startMs: 0, count: 2, successCount: 2 }));
    const first = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(first.streams.lowercase.curved.status).toBe('insufficient_data');

    mockLaFindAll.mockResolvedValueOnce([]);
    const second = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(second.streams.lowercase.curved.usableCycleCount).toBe(0); // reflects the NEW (empty) evidence, not a cached prior answer
  });
});

// ─── Item 45.6/45.7 — endpoint/CLI zero writes (re-confirmation) ──────────

describe('Architecture Test 6/7 — endpoint and CLI purity re-confirmed', () => {
  it('the controller handler source (comment-stripped) still has zero write-method references', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getPersistentDifficulty[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(|\.save\(|transaction\(/);
  });

  it('the CLI script source (comment-stripped) still has zero write-method references and no --apply mode', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/scripts/dryRunPersistentDifficulty.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(|\.save\(|transaction\(/);
    expect(codeOnly).toMatch(/--apply.*is not supported/s);
  });
});

// ─── Item 45.8 — no persistent difficulty model exists ────────────────────

describe('Architecture Test 8 — no persistent-difficulty model exists', () => {
  it('src/models has no PersistentDifficulty*.js file', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../src/models'));
    expect(files.some((f) => /persistentdifficulty/i.test(f))).toBe(false);
  });

  it('the models index never registers a persistent-difficulty model', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/models/index.js'), 'utf8');
    expect(source).not.toMatch(/persistentDifficulty/i);
  });
});

// ─── Item 45.9 — no persistent difficulty migration exists ────────────────

describe('Architecture Test 9 — no persistent-difficulty migration exists', () => {
  it('the migrations directory has no persistent-difficulty-history migration file', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../migrations'));
    expect(files.some((f) => /persistent.?difficulty/i.test(f))).toBe(false);
  });
});

// ─── Item 45.10 — no current-state database dependency ────────────────────

describe('Architecture Test 10 — no current-state database dependency', () => {
  it('the service never reads a table other than LetterAttempt (via persistentDifficultyEvidence.js\'s single query)', () => {
    const fs = require('fs');
    const path = require('path');
    const evidenceSource = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const requireLines = evidenceSource.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).toMatch(/LetterAttempt/);
    expect(requireLines).not.toMatch(/LetterProgress|ThresholdHistory|StudentMotorBaseline|ShapeFeature/);
  });
});

// ─── Design-documentation tripwire (spec §46) ──────────────────────────────
//
// NOT a schema/model test — persistence itself is deferred (§31). This only
// guards against the design document silently drifting out of sync with
// the field list it claims to document, since nothing else in the codebase
// references or enforces it (it is pure documentation, not loaded by any
// production code).

describe('Design-documentation tripwire', () => {
  it('docs/feature7-persistence-design.md exists and documents every candidate future-event field', () => {
    const fs = require('fs');
    const path = require('path');
    const docPath = path.resolve(__dirname, '../docs/feature7-persistence-design.md');
    expect(fs.existsSync(docPath)).toBe(true);
    const doc = fs.readFileSync(docPath, 'utf8');
    for (const field of [
      'student_id', 'case_type', 'family', 'status', 'reason', 'window_size',
      'earlier_successful_cycles', 'earlier_failed_cycles', 'earlier_evidence_start', 'earlier_evidence_end',
      'recent_successful_cycles', 'recent_failed_cycles', 'recent_evidence_start', 'recent_evidence_end',
      'separation_ms', 'required_separation_ms', 'affected_letters',
      'evidence_fingerprint', 'policy_version', 'mapping_version', 'created_at',
    ]) {
      expect(doc).toMatch(new RegExp(field));
    }
  });

  it('the doc explicitly states the current decision is DEFERRED, and no schema described in it has been migrated', () => {
    const fs = require('fs');
    const path = require('path');
    const doc = fs.readFileSync(path.resolve(__dirname, '../docs/feature7-persistence-design.md'), 'utf8');
    expect(doc).toMatch(/DEFERRED/);
    const migrationFiles = fs.readdirSync(path.resolve(__dirname, '../migrations'));
    expect(migrationFiles.some((f) => /persistent.?difficulty/i.test(f))).toBe(false);
  });
});

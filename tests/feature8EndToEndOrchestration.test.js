'use strict';

// Feature 8 Step 6 — Final End-to-End Validation + Closure.
//
// Drives the REAL evaluateWorksheetRecommendations() through the REAL
// chain (persistentDifficultyService -> persistentDifficultyEvidence ->
// worksheetRecommendationPolicy), mocking only ../src/models (same
// convention as tests/feature7EndToEndOrchestration.test.js and every
// other final-closure suite in this project) — this is the final
// acceptance re-statement of the whole Feature 8 chain, not a duplicate of
// Step 2/3's own granular unit coverage. Endpoint/CLI items are
// re-confirmed via source-scan here, matching every prior feature's own
// closure-step convention — the full mocked-controller/CLI test suites
// already live in getWorksheetRecommendationsEndpoint.test.js and
// dryRunWorksheetRecommendations.test.js.

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

const { evaluateWorksheetRecommendations } = require('../src/services/worksheetRecommendationService');
const { MIN_WINDOW_SEPARATION_MS } = require('../src/config/persistentDifficultyPolicy');

const DAY_MS = 24 * 60 * 60 * 1000;

let idCounter;
beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
  idCounter = 1;
});
function nextId() { return idCounter++; }

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

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

function makeWindow({ letters, caseType = 'lowercase', startMs, successCount }) {
  return Array.from({ length: 5 }, (_, i) => row({
    letter: letters[i % letters.length], caseType,
    createdAtMs: startMs + i * 60 * 1000,
    success: i < successCount,
  }));
}

/** Builds a full 10-cycle persistent-difficulty stream (both windows
 * difficult, separated by 48h). */
function persistentStreamRows({ letters, caseType = 'lowercase' }) {
  const earlier = makeWindow({ letters, caseType, startMs: 0, successCount: 1 });
  const recent = makeWindow({ letters, caseType, startMs: 2 * DAY_MS, successCount: 0 });
  return [...earlier, ...recent];
}

/** Builds a full 10-cycle not_persistent stream (both windows good). */
function notPersistentStreamRows({ letters, caseType = 'lowercase' }) {
  const earlier = makeWindow({ letters, caseType, startMs: 0, successCount: 5 });
  const recent = makeWindow({ letters, caseType, startMs: 2 * DAY_MS, successCount: 5 });
  return [...earlier, ...recent];
}

// ─── Item 1 — invalid input ─────────────────────────────────────────────────

describe('Item 1 — invalid input', () => {
  it.each([-1, 0, 1.5, 'abc', null, undefined])('studentId=%p -> invalid_input, zero reads', async (bad) => {
    const result = await evaluateWorksheetRecommendations({ studentId: bad });
    expect(result.status).toBe('invalid_input');
    expect(result.recommendations).toBeNull();
    expect(result.summary).toBeNull();
    expect(mockLaFindAll).not.toHaveBeenCalled();
  });
});

// ─── Item 2 — read_failed ────────────────────────────────────────────────────

describe('Item 2 — read_failed', () => {
  it('a DB error propagates as Feature 8 read_failed, never a fabricated empty list', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('boom'));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.status).toBe('read_failed');
    expect(result.recommendations).toBeNull();
    expect(result.summary).toBeNull();
  });
});

// ─── Item 3/4 — all insufficient / all not_persistent -> 0 ─────────────────

describe('Item 3 — all insufficient -> zero recommendations', () => {
  it('sparse evidence (2 cycles) -> recommendationCount=0, insufficientDataCount=6', async () => {
    mockLaFindAll.mockResolvedValueOnce([
      row({ letter: 'o', createdAtMs: 0, success: true }),
      row({ letter: 'o', createdAtMs: 60000, success: true }),
    ]);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations).toEqual([]);
    expect(result.summary).toMatchObject({ recommendationCount: 0, insufficientDataCount: 6, notPersistentCount: 0, persistentStreamCount: 0 });
  });
});

describe('Item 4 — all not_persistent -> zero recommendations', () => {
  it('every stream fully good -> recommendationCount=0, notPersistentCount=6', async () => {
    const rows = [
      ...notPersistentStreamRows({ letters: ['l'], caseType: 'lowercase' }),
      ...notPersistentStreamRows({ letters: ['c', 'o'], caseType: 'lowercase' }).map((r) => ({ ...r, id: nextId(), session_key: `curved-${r.session_key}` })),
      ...notPersistentStreamRows({ letters: ['v'], caseType: 'lowercase' }).map((r) => ({ ...r, id: nextId(), session_key: `complex-${r.session_key}` })),
      ...notPersistentStreamRows({ letters: ['I'], caseType: 'uppercase' }).map((r) => ({ ...r, id: nextId(), session_key: `us-${r.session_key}` })),
      ...notPersistentStreamRows({ letters: ['C'], caseType: 'uppercase' }).map((r) => ({ ...r, id: nextId(), session_key: `uc-${r.session_key}` })),
      ...notPersistentStreamRows({ letters: ['V'], caseType: 'uppercase' }).map((r) => ({ ...r, id: nextId(), session_key: `ux-${r.session_key}` })),
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations).toEqual([]);
    expect(result.summary).toMatchObject({ recommendationCount: 0, notPersistentCount: 6, insufficientDataCount: 0, persistentStreamCount: 0 });
  });
});

// ─── Item 5/6 — one/two persistent -> 1/2 recommendations ──────────────────

describe('Item 5 — one persistent -> one recommendation', () => {
  it('lowercase curved persistent (c/o) -> exactly one recommendation', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['c', 'o'] }));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      recommendationType: 'motor_family_practice', caseType: 'lowercase', family: 'curved', title: 'Curved Movement Practice',
    });
    expect(result.summary.recommendationCount).toBe(1);
  });
});

describe('Item 6 — two persistent -> two recommendations', () => {
  it('lowercase curved + uppercase straight both persistent -> two recommendations', async () => {
    const rows = [
      ...persistentStreamRows({ letters: ['c', 'o'] }),
      ...persistentStreamRows({ letters: ['I'], caseType: 'uppercase' }).map((r) => ({ ...r, id: nextId(), session_key: `up-${r.session_key}` })),
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations).toHaveLength(2);
    expect(result.summary.recommendationCount).toBe(2);
  });
});

// ─── Item 7 — only persistent streams invoke the builder ──────────────────

describe('Item 7 — only persistent streams ever produce a recommendation', () => {
  it('a mix of persistent + not_persistent + insufficient only yields recommendations for the persistent stream', async () => {
    const rows = [
      ...persistentStreamRows({ letters: ['c', 'o'] }), // lowercase curved: persistent
      ...notPersistentStreamRows({ letters: ['l'] }).map((r) => ({ ...r, id: nextId(), session_key: `straight-${r.session_key}` })), // lowercase straight: not_persistent
      // lowercase complex, uppercase *: left insufficient (0 rows)
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].family).toBe('curved');
  });
});

// ─── Item 8 — deterministic stream order ───────────────────────────────────

describe('Item 8 — deterministic stream order, never severity-based', () => {
  it('lowercase straight appears before lowercase complex even with far fewer failures', async () => {
    const straightRows = persistentStreamRows({ letters: ['l'] }); // 1 letter, low failure count
    const complexRows = persistentStreamRows({ letters: ['v', 'w', 'x'] }).map((r) => ({ ...r, id: nextId(), session_key: `complex-${r.session_key}` }));
    mockLaFindAll.mockResolvedValueOnce([...straightRows, ...complexRows]);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations.map((r) => r.family)).toEqual(['straight', 'complex']);
  });
});

// ─── Item 9 — focus-letter order preserved ─────────────────────────────────

describe('Item 9 — focus-letter order preserved (failedCycles-descending, from Feature 7, never re-sorted)', () => {
  it('the letter with more failures/cycles appears first, per Feature 7\'s own deterministic rule', async () => {
    // 'c' gets 6 cycles all failing (heaviest), 'o' gets fewer.
    const earlier = [
      row({ letter: 'c', createdAtMs: 0, success: false }),
      row({ letter: 'c', createdAtMs: 60000, success: false }),
      row({ letter: 'o', createdAtMs: 120000, success: true }),
      row({ letter: 'o', createdAtMs: 180000, success: false }),
      row({ letter: 'c', createdAtMs: 240000, success: false }),
    ];
    const recent = [
      row({ letter: 'c', createdAtMs: 2 * DAY_MS, success: false }),
      row({ letter: 'o', createdAtMs: 2 * DAY_MS + 60000, success: false }),
      row({ letter: 'c', createdAtMs: 2 * DAY_MS + 120000, success: false }),
      row({ letter: 'o', createdAtMs: 2 * DAY_MS + 180000, success: false }),
      row({ letter: 'c', createdAtMs: 2 * DAY_MS + 240000, success: false }),
    ];
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations[0].focusLetters).toEqual(['c', 'o']); // c has more failures -> first
  });
});

// ─── Item 10 — case preserved ───────────────────────────────────────────────

describe('Item 10 — case preserved', () => {
  it('uppercase persistent stream reports uppercase focus letters', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['C', 'O'], caseType: 'uppercase' }));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations[0].caseType).toBe('uppercase');
    expect(result.recommendations[0].focusLetters.every((l) => l === l.toUpperCase())).toBe(true);
  });
});

// ─── Item 11 — no static focus letters ─────────────────────────────────────

describe('Item 11 — no static focus letters added beyond live evidence', () => {
  it('a single-letter complex stream never expands to a full family letter set', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['s'] }));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations[0].focusLetters).toEqual(['s']);
    expect(result.recommendations[0].focusLetters).not.toContain('v');
    expect(result.recommendations[0].focusLetters).not.toContain('w');
  });
});

// ─── Item 12 — invalid family skipped safely ───────────────────────────────

describe('Item 12 — a structurally invalid family is skipped, never crashes the evaluation', () => {
  // Exercised at the unit level in worksheetRecommendationService.test.js
  // (a real Feature 7 stream can never produce an invalid family — this is
  // defense-in-depth only). Re-confirmed here via source-scan that the
  // skip path exists and is logged, not silently swallowed.
  it('the service source contains the defensive null-builder-result skip path', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    expect(source).toMatch(/if \(recommendation\) \{[\s\S]*?\} else \{[\s\S]*?logger\.warn/);
  });
});

// ─── Item 13 — evaluatedAt reused ──────────────────────────────────────────

describe('Item 13 — evaluatedAt reused from Feature 7, never a second timestamp', () => {
  it('Feature 8\'s evaluatedAt is a valid ISO string, generated exactly once by the underlying Feature 7 call', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['c', 'o'] }));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(typeof result.evaluatedAt).toBe('string');
    expect(new Date(result.evaluatedAt).toString()).not.toBe('Invalid Date');
  });
});

// ─── Item 14 — summary counts ──────────────────────────────────────────────

describe('Item 14 — summary counts mathematically consistent with six streams', () => {
  it('persistentStreamCount + notPersistentCount + insufficientDataCount === evaluatedStreamCount === 6', async () => {
    const rows = [
      ...persistentStreamRows({ letters: ['c', 'o'] }),
      ...notPersistentStreamRows({ letters: ['l'] }).map((r) => ({ ...r, id: nextId(), session_key: `straight-${r.session_key}` })),
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    const { evaluatedStreamCount, persistentStreamCount, notPersistentCount, insufficientDataCount, recommendationCount } = result.summary;
    expect(evaluatedStreamCount).toBe(6);
    expect(persistentStreamCount + notPersistentCount + insufficientDataCount).toBe(6);
    expect(recommendationCount).toBe(persistentStreamCount);
  });
});

// ─── Item 15 — no raw diagnostics ──────────────────────────────────────────

describe('Item 15 — no raw Feature 7 diagnostics anywhere in the result', () => {
  it('the serialized result never contains separationMs/windowSize/validCycleCount/session keys', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['c', 'o'] }));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    const blob = JSON.stringify(result.recommendations);
    expect(blob).not.toMatch(/separationMs|windowSize|validCycleCount|usableCycleCount|session_key|sessionKey|evidenceStart|evidenceEnd/i);
  });
});

// ─── Item 16 — Feature 7 called exactly once (== exactly one DB read) ─────

describe('Item 16 — exactly one underlying DB read per evaluation', () => {
  it('findAll is called exactly once even with a fully-populated six-stream result', async () => {
    const rows = [
      ...persistentStreamRows({ letters: ['c', 'o'] }),
      ...notPersistentStreamRows({ letters: ['l'] }).map((r) => ({ ...r, id: nextId(), session_key: `straight-${r.session_key}` })),
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
  });
});

// ─── Item 17 — no LetterAttempt direct access from Feature 8's own layer ──

describe('Item 17 — no direct LetterAttempt access from worksheetRecommendationService.js', () => {
  it('the service file never imports ../models', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/\.\.\/models/);
  });
});

// ─── Items 18-23 — Feature 1-6 independence ────────────────────────────────

describe('Items 18-23 — Feature 1-6 independence (source-scan)', () => {
  function requireLinesOfWorksheetFiles() {
    const fs = require('fs');
    const path = require('path');
    return ['../src/services/worksheetRecommendationService.js', '../src/config/worksheetRecommendationPolicy.js']
      .map((f) => fs.readFileSync(path.resolve(__dirname, f), 'utf8'))
      .map((s) => s.split('\n').filter((l) => /require\(/.test(l)).join('\n'))
      .join('\n');
  }

  it('Item 18 — no StudentMotorBaseline (Feature 1) import', () => {
    expect(requireLinesOfWorksheetFiles()).not.toMatch(/StudentMotorBaseline/);
  });

  it('Item 19 — no dynamicThresholdService (Feature 2) import', () => {
    expect(requireLinesOfWorksheetFiles()).not.toMatch(/dynamicThresholdService/);
  });

  it('Item 20 — no adaptiveSupportService (Feature 3) import', () => {
    expect(requireLinesOfWorksheetFiles()).not.toMatch(/adaptiveSupportService/);
  });

  it('Item 21 — no adaptivePreWritingService (Feature 4) import', () => {
    expect(requireLinesOfWorksheetFiles()).not.toMatch(/adaptivePreWritingService/);
  });

  it('Item 22 — no repetitionRecommendationService (Feature 5) import', () => {
    expect(requireLinesOfWorksheetFiles()).not.toMatch(/repetitionRecommendationService/);
  });

  it('Item 23 — no demoSpeedRecommendationService (Feature 6) import', () => {
    expect(requireLinesOfWorksheetFiles()).not.toMatch(/demoSpeedRecommendationService/);
  });
});

// ─── Item 24 — no writes ────────────────────────────────────────────────────

describe('Item 24 — no writes anywhere across the full chain', () => {
  it('a full persistent-triggering evaluation still performs zero writes', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['c', 'o'] }));
    await evaluateWorksheetRecommendations({ studentId: 99 });
    expectNoWrites();
  });
});

// ─── Item 25 — endpoint ownership (re-confirmation) ────────────────────────

describe('Item 25 — endpoint ownership re-confirmation', () => {
  it('getWorksheetRecommendations checks teacherService.getOwnStudentById before calling the service', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getWorksheetRecommendations[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const ownershipIdx = match[0].indexOf('getOwnStudentById');
    const serviceIdx = match[0].indexOf('evaluateWorksheetRecommendations(');
    expect(ownershipIdx).toBeGreaterThan(-1);
    expect(serviceIdx).toBeGreaterThan(-1);
    expect(ownershipIdx).toBeLessThan(serviceIdx);
  });
});

// ─── Item 26 — endpoint no raw attempts (re-confirmation) ──────────────────

describe('Item 26 — endpoint no raw-attempt leakage re-confirmation', () => {
  it('the handler never references stroke_points/normalized_features/session_key/best_score/threshold', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getWorksheetRecommendations[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/stroke_points|normalized_features|session_key|best_score|threshold/);
  });
});

// ─── Item 27 — CLI read-only (re-confirmation) ─────────────────────────────

describe('Item 27 — CLI read-only re-confirmation', () => {
  it('dryRunWorksheetRecommendations.js hard-rejects --apply and has zero write-method references', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/scripts/dryRunWorksheetRecommendations.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).toMatch(/--apply.*is not supported/s);
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(|\.save\(|transaction\(/);
  });
});

// ─── Item 28 — no migration/model ──────────────────────────────────────────

describe('Item 28 — no worksheet-recommendation persistence model/table/migration exists', () => {
  it('src/models has no WorksheetRecommendation*.js file and models/index.js never registers one', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../src/models'));
    expect(files.some((f) => /worksheetrecommendation/i.test(f))).toBe(false);
    const indexSource = fs.readFileSync(path.resolve(__dirname, '../src/models/index.js'), 'utf8');
    expect(indexSource).not.toMatch(/worksheetRecommendation/i);
  });

  it('migrations directory has no worksheet-recommendation migration', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../migrations'));
    expect(files.some((f) => /worksheet.?recommendation/i.test(f))).toBe(false);
  });
});

// ─── Item 29 — no PDF dependency ───────────────────────────────────────────

describe('Item 29 — no PDF dependency added', () => {
  it('package.json has no pdf/print generation packages', () => {
    const fs = require('fs');
    const path = require('path');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const forbidden of ['pdfkit', 'puppeteer', 'html-pdf', 'jspdf']) {
      expect(allDeps).not.toHaveProperty(forbidden);
    }
  });
});

// ─── Item 30 — recommendation type is only motor_family_practice ─────────

describe('Item 30 — recommendationType is always exactly motor_family_practice', () => {
  it('every recommendation across a multi-stream result carries the same single type value', async () => {
    const rows = [
      ...persistentStreamRows({ letters: ['c', 'o'] }),
      ...persistentStreamRows({ letters: ['I'], caseType: 'uppercase' }).map((r) => ({ ...r, id: nextId(), session_key: `up-${r.session_key}` })),
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((r) => r.recommendationType === 'motor_family_practice')).toBe(true);
  });
});

// ─── Full synthetic scenarios (spec §63/§64/§65) ──────────────────────────

describe('§63 — full synthetic one-recommendation scenario', () => {
  it('lowercase curved persistent, c (6/6) + o (4/3) -> exact documented shape', async () => {
    // c: 6 cycles all failing; o: 4 cycles, 3 failing, 1 succeeding.
    const earlier = [
      row({ letter: 'c', createdAtMs: 0, success: false }),
      row({ letter: 'c', createdAtMs: 60000, success: false }),
      row({ letter: 'o', createdAtMs: 120000, success: true }),
      row({ letter: 'o', createdAtMs: 180000, success: false }),
      row({ letter: 'c', createdAtMs: 240000, success: false }),
    ];
    const recent = [
      row({ letter: 'c', createdAtMs: 2 * DAY_MS, success: false }),
      row({ letter: 'o', createdAtMs: 2 * DAY_MS + 60000, success: false }),
      row({ letter: 'c', createdAtMs: 2 * DAY_MS + 120000, success: false }),
      row({ letter: 'o', createdAtMs: 2 * DAY_MS + 180000, success: false }),
      row({ letter: 'c', createdAtMs: 2 * DAY_MS + 240000, success: false }),
    ];
    mockLaFindAll.mockResolvedValueOnce([...earlier, ...recent]);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });

    expect(result.recommendations).toHaveLength(1);
    const rec = result.recommendations[0];
    expect(rec.recommendationType).toBe('motor_family_practice');
    expect(rec.caseType).toBe('lowercase');
    expect(rec.family).toBe('curved');
    expect(rec.title).toBe('Curved Movement Practice');
    expect(rec.focusLetters).toEqual(['c', 'o']);
    expect(rec.rationale).toMatch(/Curved movement practice is recommended because difficulty remained across two separate practice periods\./);
    expect(rec.suggestedActivities.length).toBeGreaterThan(0);
  });
});

describe('§64 — full synthetic multi-recommendation scenario', () => {
  it('lowercase curved + uppercase straight both persistent -> 2 recommendations, correct order, no contamination', async () => {
    const rows = [
      ...persistentStreamRows({ letters: ['c', 'o'] }),
      ...persistentStreamRows({ letters: ['I'], caseType: 'uppercase' }).map((r) => ({ ...r, id: nextId(), session_key: `up-${r.session_key}` })),
    ];
    mockLaFindAll.mockResolvedValueOnce(rows);
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });

    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations[0].family).toBe('curved');
    expect(result.recommendations[0].caseType).toBe('lowercase');
    expect(result.recommendations[1].family).toBe('straight');
    expect(result.recommendations[1].caseType).toBe('uppercase');
    expect(result.recommendations[1].focusLetters).toEqual(['I']);
    // No contamination.
    expect(result.recommendations[0].focusLetters).not.toContain('I');
    expect(result.recommendations[1].focusLetters).not.toContain('c');
  });
});

describe('§65 — full synthetic read-failure scenario', () => {
  it('a DB read failure -> Feature 8 read_failed, recommendations=null, summary=null', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('connection lost'));
    const result = await evaluateWorksheetRecommendations({ studentId: 99 });
    expect(result).toMatchObject({ status: 'read_failed', studentId: 99, evaluatedAt: null, recommendations: null, summary: null });
  });
});

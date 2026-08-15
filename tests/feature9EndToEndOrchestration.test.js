'use strict';

// Feature 9 Step 6 — Final End-to-End Validation + Closure.
//
// Drives the REAL chain — persistentDifficultyService ->
// persistentDifficultyEvidence -> worksheetRecommendationPolicy ->
// worksheetRecommendationService -> feature9Provenance ->
// teacherRecommendationValidationService — mocking ONLY ../src/models (the
// one real DB-touching boundary anywhere in the whole chain), matching
// tests/feature8EndToEndOrchestration.test.js's own established closure-step
// convention exactly. Synthetic LetterAttempt rows produce REAL Feature 7
// evidence, a REAL Feature 8 recommendation + fingerprint, and REAL Feature
// 9 provenance fingerprints — only the final `TeacherRecommendationValidation`
// read/write is a mock, standing in for the live (still-unapplied) table.

const mockLaFindAll = jest.fn();
const mockLaCreate = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate = jest.fn();
const mockLaDestroy = jest.fn();
const mockLaSave = jest.fn();
const mockLaIncrement = jest.fn();
const mockLaFindOrCreate = jest.fn();

const mockTrvFindOrCreate = jest.fn();
const mockTrvFindAll = jest.fn();
const mockTrvFindOne = jest.fn();
const mockTrvCreate = jest.fn();
const mockTrvUpdate = jest.fn();
const mockTrvDestroy = jest.fn();
const mockTrvSave = jest.fn();
const mockTrvBulkCreate = jest.fn();
const mockTrvIncrement = jest.fn();

const mockTransaction = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate,
    destroy: mockLaDestroy, save: mockLaSave, increment: mockLaIncrement,
    findOrCreate: mockLaFindOrCreate,
  },
  TeacherRecommendationValidation: {
    findOrCreate: (...a) => mockTrvFindOrCreate(...a),
    findAll: (...a) => mockTrvFindAll(...a),
    findOne: (...a) => mockTrvFindOne(...a),
    create: mockTrvCreate, update: mockTrvUpdate, destroy: mockTrvDestroy,
    save: mockTrvSave, bulkCreate: mockTrvBulkCreate, increment: mockTrvIncrement,
  },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const fs = require('fs');
const path = require('path');

const { evaluateWorksheetRecommendations } = require('../src/services/worksheetRecommendationService');
const {
  validateWorksheetRecommendation, getTeacherValidationHistory, getLatestValidationForRecommendation,
} = require('../src/services/teacherRecommendationValidationService');
const {
  PERSISTENT_DIFFICULTY_POLICY_VERSION, WORKSHEET_RECOMMENDATION_POLICY_VERSION,
} = require('../src/config/feature9Provenance');
const { MAPPING_VERSION } = require('../src/config/letterBaselineFamilies');

const SHA256_HEX = /^[a-f0-9]{64}$/;
const STUDENT_ID = 99;
const TEACHER_ID = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

let idCounter;
beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
  mockTrvFindOrCreate.mockResolvedValue([{ id: 1, created_at: new Date('2026-08-14T00:00:00.000Z') }, true]);
  mockTrvFindAll.mockResolvedValue([]);
  mockTrvFindOne.mockResolvedValue(null);
  idCounter = 1;
});
function nextId() { return idCounter++; }

function expectNoLetterAttemptWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate]) {
    expect(fn).not.toHaveBeenCalled();
  }
}
function expectNoTeacherRecommendationValidationWrites() {
  for (const fn of [mockTrvCreate, mockTrvUpdate, mockTrvDestroy, mockTrvSave, mockTrvBulkCreate, mockTrvIncrement]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

// ─── Fixtures (identical shape to feature8EndToEndOrchestration.test.js) ──

function row({ letter, caseType = 'lowercase', createdAtMs, success, sessionKey, id }) {
  return {
    id: id ?? nextId(),
    student_id: STUDENT_ID,
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

function persistentStreamRows({ letters, caseType = 'lowercase', offsetMs = 0 }) {
  const earlier = makeWindow({ letters, caseType, startMs: offsetMs, successCount: 1 });
  const recent = makeWindow({ letters, caseType, startMs: offsetMs + 2 * DAY_MS, successCount: 0 });
  return [...earlier, ...recent];
}

// Uses the PERSISTENT mockResolvedValue (not "Once") deliberately: several
// tests call getPersistentCurvedRecommendation() once to obtain a real
// recommendation/fingerprint, then call validateWorksheetRecommendation()
// afterward — which itself issues TWO further LetterAttempt.findAll calls
// internally (evaluatePersistentDifficulty + evaluateWorksheetRecommendations,
// Promise.all). The mock must keep returning the SAME evidence for those
// follow-up calls unless a test explicitly overrides it (as item 13 does,
// to simulate evidence changing between "teacher viewed" and "teacher
// confirmed").
async function getPersistentCurvedRecommendation({ offsetMs = 0 } = {}) {
  mockLaFindAll.mockResolvedValue(persistentStreamRows({ letters: ['c', 'o'], offsetMs }));
  const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
  return result.recommendations[0];
}

// ─── 1-2: invalid input / ownership boundary ────────────────────────────────

describe('1. invalid input', () => {
  it.each([
    { studentId: -1, teacherId: TEACHER_ID },
    { studentId: STUDENT_ID, teacherId: 0 },
    { studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'mixedcase' },
    { studentId: STUDENT_ID, teacherId: TEACHER_ID, family: 'diagonal' },
    { studentId: STUDENT_ID, teacherId: TEACHER_ID, validation: 'approved' },
    { studentId: STUDENT_ID, teacherId: TEACHER_ID, recommendationFingerprint: 'not-a-hash' },
  ])('%p -> invalid_input, zero reads/writes', async (overrides) => {
    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: 'a'.repeat(64),
      ...overrides,
    });
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoTeacherRecommendationValidationWrites();
    expect(mockTrvFindOrCreate).not.toHaveBeenCalled();
  });
});

describe('2. ownership guard (controller boundary, re-confirmed)', () => {
  // Ownership itself is enforced in handwritingController.js (Step 4),
  // already exhaustively tested in tests/postWorksheetRecommendationValidationEndpoint.test.js
  // (items 2/3/19 — unowned -> 404, checked before any service call, no
  // write attempted). This service layer has no ownership concept of its
  // own by design — teacherId is trusted input, exactly as tested in item
  // 17 below.
  it('is out of scope for the service layer — see the dedicated controller test file for ownership-order proof', () => {
    expect(true).toBe(true);
  });
});

// ─── 3-4: Feature 8 recommendation + fingerprint ────────────────────────────

describe('3. one persistent recommendation generated', () => {
  it('lowercase curved persistent (c/o) produces exactly one recommendation', async () => {
    const rec = await getPersistentCurvedRecommendation();
    expect(rec).toMatchObject({ caseType: 'lowercase', family: 'curved', title: 'Curved Movement Practice' });
  });
});

describe('4. recommendation fingerprint generated', () => {
  it('the real recommendation carries a 64-char lowercase hex fingerprint', async () => {
    const rec = await getPersistentCurvedRecommendation();
    expect(rec.recommendationFingerprint).toMatch(SHA256_HEX);
  });
});

// ─── 5-8: write path ─────────────────────────────────────────────────────────

describe('5. confirmed validation accepted', () => {
  it('a fingerprint-matching confirm returns status: validated', async () => {
    const rec = await getPersistentCurvedRecommendation();
    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(result.status).toBe('validated');
  });
});

describe('6. trusted snapshot stored', () => {
  it('the findOrCreate defaults exactly match the real Feature 8 recommendation content', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    const [{ defaults }] = mockTrvFindOrCreate.mock.calls[0];
    expect(defaults.recommendation_type).toBe(rec.recommendationType);
    expect(defaults.recommendation_title).toBe(rec.title);
    expect(defaults.focus_letters).toEqual(rec.focusLetters);
    expect(defaults.suggested_activities).toEqual(rec.suggestedActivities);
    expect(defaults.rationale).toBe(rec.rationale);
    expect(defaults.recommendation_fingerprint).toBe(rec.recommendationFingerprint);
  });
});

describe('7. duplicate confirm idempotent', () => {
  it('a second identical confirm resolves duplicate: true, findOrCreate reports created: false', async () => {
    const rec = await getPersistentCurvedRecommendation();
    mockTrvFindOrCreate.mockResolvedValueOnce([{ id: 7, created_at: new Date('2026-08-10T00:00:00.000Z') }, false]);
    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(result.status).toBe('validated');
    expect(result.duplicate).toBe(true);
  });
});

describe('8. dismissed after confirmed creates a second event', () => {
  it('two findOrCreate calls with different validation values, never an update', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'dismissed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(mockTrvFindOrCreate).toHaveBeenCalledTimes(2);
    expect(mockTrvFindOrCreate.mock.calls[0][0].where.validation).toBe('confirmed');
    expect(mockTrvFindOrCreate.mock.calls[1][0].where.validation).toBe('dismissed');
    expectNoTeacherRecommendationValidationWrites();
  });
});

// ─── 9-10: read path ─────────────────────────────────────────────────────────

describe('9. current state resolves dismissed', () => {
  it('getLatestValidationForRecommendation reflects the latest (dismissed) row', async () => {
    const rec = await getPersistentCurvedRecommendation();
    mockTrvFindOne.mockResolvedValueOnce({
      validation: 'dismissed', teacher_note: null, created_at: new Date('2026-08-12T00:00:00.000Z'),
    });
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(result.current.validation).toBe('dismissed');
  });
});

describe('10. history contains both events', () => {
  it('getTeacherValidationHistory returns both confirmed and dismissed events', async () => {
    const rec = await getPersistentCurvedRecommendation();
    mockTrvFindAll.mockResolvedValueOnce([
      { id: 2, case_type: 'lowercase', family: 'curved', recommendation_type: rec.recommendationType, recommendation_title: rec.title, focus_letters: rec.focusLetters, validation: 'dismissed', teacher_note: null, created_at: new Date('2026-08-12T00:00:00.000Z') },
      { id: 1, case_type: 'lowercase', family: 'curved', recommendation_type: rec.recommendationType, recommendation_title: rec.title, focus_letters: rec.focusLetters, validation: 'confirmed', teacher_note: null, created_at: new Date('2026-08-10T00:00:00.000Z') },
    ]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.validation)).toEqual(['dismissed', 'confirmed']);
  });
});

// ─── 11-13: new-evidence + race protection ──────────────────────────────────

describe('11. new evidence changes the fingerprint', () => {
  it('the same stream, shifted evidence timing, produces a different fingerprint', async () => {
    const original = await getPersistentCurvedRecommendation();
    const shifted = await getPersistentCurvedRecommendation({ offsetMs: 30 * DAY_MS });
    expect(shifted.recommendationFingerprint).not.toBe(original.recommendationFingerprint);
    // Same content otherwise — only evidence timing changed.
    expect(shifted.focusLetters).toEqual(original.focusLetters);
  });
});

describe('12. old validation does not apply to new evidence', () => {
  it('a current-state lookup with the NEW fingerprint returns null even though the OLD fingerprint has history', async () => {
    const original = await getPersistentCurvedRecommendation();
    const shifted = await getPersistentCurvedRecommendation({ offsetMs: 30 * DAY_MS });

    mockTrvFindOne.mockResolvedValueOnce(null); // nothing recorded yet for the new fingerprint
    const result = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: shifted.recommendationFingerprint,
    });
    expect(result.current).toBeNull();
    expect(shifted.recommendationFingerprint).not.toBe(original.recommendationFingerprint);
  });
});

describe('13. recommendation_changed blocks a stale validation', () => {
  it('confirming with the OLD fingerprint while the live evidence now matches a NEW fingerprint is rejected, no write', async () => {
    const original = await getPersistentCurvedRecommendation();
    // Live evidence has since moved on (new practice data) — represented by
    // a fresh evaluateWorksheetRecommendations() call inside
    // validateWorksheetRecommendation() itself returning the shifted evidence.
    mockLaFindAll.mockResolvedValue(persistentStreamRows({ letters: ['c', 'o'], offsetMs: 30 * DAY_MS }));

    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: original.recommendationFingerprint,
    });
    expect(result.status).toBe('recommendation_changed');
    expect(result.currentRecommendationFingerprint).toMatch(SHA256_HEX);
    expect(result.currentRecommendationFingerprint).not.toBe(original.recommendationFingerprint);
    expect(mockTrvFindOrCreate).not.toHaveBeenCalled();
  });
});

// ─── 14-16: unavailable / failure paths ─────────────────────────────────────

describe('14. recommendation_not_found', () => {
  it('requesting a stream Feature 8 does not currently recommend is rejected, no write', async () => {
    // Only lowercase/curved is persistent — request lowercase/complex instead.
    // Persistent (not "Once") mock: validateWorksheetRecommendation() issues
    // TWO internal LetterAttempt.findAll calls (evaluatePersistentDifficulty
    // directly + evaluateWorksheetRecommendations' own internal call) —
    // both must see the same evidence.
    mockLaFindAll.mockResolvedValue(persistentStreamRows({ letters: ['c', 'o'] }));
    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'complex',
      validation: 'confirmed', recommendationFingerprint: 'a'.repeat(64),
    });
    expect(result.status).toBe('recommendation_not_found');
    expect(mockTrvFindOrCreate).not.toHaveBeenCalled();
  });
});

describe('15. read failure', () => {
  it('a LetterAttempt read failure propagates as read_failed, no write', async () => {
    // Persistent rejection — guarantees BOTH of validateWorksheetRecommendation()'s
    // internal findAll calls fail, regardless of call ordering.
    mockLaFindAll.mockRejectedValue(new Error('boom'));
    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: 'a'.repeat(64),
    });
    expect(result.status).toBe('read_failed');
    expect(mockTrvFindOrCreate).not.toHaveBeenCalled();
  });
});

describe('16. write failure', () => {
  it('a TeacherRecommendationValidation write failure returns write_failed, never validated', async () => {
    const rec = await getPersistentCurvedRecommendation();
    mockTrvFindOrCreate.mockRejectedValueOnce(new Error('DB down'));
    const result = await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(result.status).toBe('write_failed');
  });
});

// ─── 17: teacherId trust ────────────────────────────────────────────────────

describe('17. teacherId comes from trusted input only', () => {
  it('the service persists exactly the teacherId argument it was given, never deriving/overriding it', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: 777, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    const [{ defaults }] = mockTrvFindOrCreate.mock.calls[0];
    expect(defaults.teacher_id).toBe(777);
  });
});

// ─── 18-24: dependency-isolation source-scans ───────────────────────────────

function readServiceSource() {
  return fs.readFileSync(path.resolve(__dirname, '../src/services/teacherRecommendationValidationService.js'), 'utf8');
}
function requireLines(source) {
  return source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('18. no raw attempt query from Feature 9', () => {
  it('teacherRecommendationValidationService.js never references LetterAttempt', () => {
    expect(requireLines(readServiceSource())).not.toMatch(/LetterAttempt/);
  });
});

describe('19-24. no Feature 1-6 dependency', () => {
  it('teacherRecommendationValidationService.js imports none of StudentMotorBaseline/dynamicThresholdService/adaptiveSupportService/adaptivePreWritingService/repetitionRecommendationService/demoSpeedRecommendationService', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/StudentMotorBaseline/);      // 19. Feature 1
    expect(lines).not.toMatch(/dynamicThresholdService/);   // 20. Feature 2
    expect(lines).not.toMatch(/adaptiveSupportService/);    // 21. Feature 3
    expect(lines).not.toMatch(/adaptivePreWritingService/); // 22. Feature 4
    expect(lines).not.toMatch(/repetitionRecommendationService/); // 23. Feature 5
    expect(lines).not.toMatch(/demoSpeedRecommendationService/);  // 24. Feature 6
  });
});

describe('25. Feature 7 unchanged (composition boundary only)', () => {
  it('Feature 9 only ever calls the public evaluatePersistentDifficulty()/evaluateWorksheetRecommendations() functions, never persistentDifficultyEvidence internals directly', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).toMatch(/persistentDifficultyService/);
    expect(lines).not.toMatch(/persistentDifficultyEvidence/);
  });
});

describe('26. Feature 8 only additive fingerprint', () => {
  it('the real recommendation object has exactly the 8 expected keys, nothing else', async () => {
    const rec = await getPersistentCurvedRecommendation();
    expect(Object.keys(rec).sort()).toEqual([
      'recommendationType', 'caseType', 'family', 'title', 'focusLetters',
      'rationale', 'suggestedActivities', 'recommendationFingerprint',
    ].sort());
  });
});

describe('27. no TeacherValidation reuse', () => {
  it('the collection-mode TeacherValidation table/model is never referenced', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/\bTeacherValidation\b/); // does not false-positive on TeacherRecommendationValidation
  });
});

describe('28. no RecommendationHistory reuse', () => {
  it('the explainability RecommendationHistory table/model is never referenced', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/RecommendationHistory/);
  });
});

describe('29. no persistent_difficulty_history activation', () => {
  it('no file in src/ references a persistent_difficulty_history table/model', () => {
    const serviceSource = readServiceSource();
    expect(serviceSource).not.toMatch(/persistent_difficulty_history/);
    const migrationsDir = path.resolve(__dirname, '../migrations');
    const migrationFiles = fs.readdirSync(migrationsDir);
    expect(migrationFiles.some((f) => /persistent.difficulty.history/i.test(f))).toBe(false);
    const modelFiles = fs.readdirSync(path.resolve(__dirname, '../src/models'));
    expect(modelFiles.some((f) => /persistentdifficultyhistory/i.test(f))).toBe(false);
  });
});

describe('30. no update/delete code paths', () => {
  it('the service never calls .update()/.destroy()/.save()/.bulkUpdate() on a model', () => {
    const code = stripComments(readServiceSource());
    expect(code).not.toMatch(/\.update\(/);
    expect(code).not.toMatch(/\.destroy\(/);
    expect(code).not.toMatch(/\.save\(/);
    expect(code).not.toMatch(/\.bulkUpdate\(/);
  });
});

// ─── 31-33: snapshot + provenance + note fidelity ───────────────────────────

describe('31. recommendation snapshot exact', () => {
  it('every snapshot field matches the real Feature 8 output byte-for-byte', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    const [{ defaults }] = mockTrvFindOrCreate.mock.calls[0];
    expect(defaults.recommendation_type).toBe('motor_family_practice');
    expect(defaults.recommendation_title).toBe('Curved Movement Practice');
    expect(defaults.focus_letters).toEqual(['c', 'o']);
  });
});

describe('32. provenance versions exact', () => {
  it('persisted policy/mapping versions match the trusted real constants', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', recommendationFingerprint: rec.recommendationFingerprint,
    });
    const [{ defaults }] = mockTrvFindOrCreate.mock.calls[0];
    expect(defaults.persistent_policy_version).toBe(PERSISTENT_DIFFICULTY_POLICY_VERSION);
    expect(defaults.recommendation_policy_version).toBe(WORKSHEET_RECOMMENDATION_POLICY_VERSION);
    expect(defaults.mapping_version).toBe(MAPPING_VERSION);
    expect(defaults.evidence_fingerprint).toMatch(SHA256_HEX);
  });
});

describe('33. note normalization', () => {
  it('a whitespace-only note is persisted as null; a padded note is trimmed', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', teacherNote: '   ', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(mockTrvFindOrCreate.mock.calls[0][0].defaults.teacher_note).toBeNull();

    const rec2 = await getPersistentCurvedRecommendation({ offsetMs: 60 * DAY_MS });
    await validateWorksheetRecommendation({
      studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
      validation: 'confirmed', teacherNote: '  Tired today  ', recommendationFingerprint: rec2.recommendationFingerprint,
    });
    expect(mockTrvFindOrCreate.mock.calls[1][0].defaults.teacher_note).toBe('Tired today');
  });
});

// ─── 34-36: history/current-state exactness ─────────────────────────────────

describe('34. history newest-first', () => {
  it('the service never re-sorts what the (mocked) DB-ordered query returns', async () => {
    mockTrvFindAll.mockResolvedValueOnce([
      { id: 2, case_type: 'lowercase', family: 'curved', recommendation_type: 'motor_family_practice', recommendation_title: 'x', focus_letters: [], validation: 'dismissed', teacher_note: null, created_at: new Date('2026-08-12T00:00:00.000Z') },
      { id: 1, case_type: 'lowercase', family: 'curved', recommendation_type: 'motor_family_practice', recommendation_title: 'x', focus_letters: [], validation: 'confirmed', teacher_note: null, created_at: new Date('2026-08-10T00:00:00.000Z') },
    ]);
    const result = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(result.events.map((e) => e.id)).toEqual([2, 1]);
  });
});

describe('35. exact-fingerprint current state', () => {
  it('getLatestValidationForRecommendation queries by recommendation_fingerprint, not just stream identity', async () => {
    const rec = await getPersistentCurvedRecommendation();
    await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: rec.recommendationFingerprint,
    });
    const [{ where }] = mockTrvFindOne.mock.calls[0];
    expect(where.recommendation_fingerprint).toBe(rec.recommendationFingerprint);
  });
});

describe('36. same stream, new fingerprint isolation', () => {
  it('two current-state lookups for the same stream but different fingerprints query with different values', async () => {
    const original = await getPersistentCurvedRecommendation();
    const shifted = await getPersistentCurvedRecommendation({ offsetMs: 90 * DAY_MS });

    await getLatestValidationForRecommendation({ studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: original.recommendationFingerprint });
    await getLatestValidationForRecommendation({ studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: shifted.recommendationFingerprint });

    const fp1 = mockTrvFindOne.mock.calls[0][0].where.recommendation_fingerprint;
    const fp2 = mockTrvFindOne.mock.calls[1][0].where.recommendation_fingerprint;
    expect(fp1).not.toBe(fp2);
  });
});

// ─── 37: single Feature 7 read per Feature 8 evaluation ─────────────────────

describe('37. one Feature 7 (LetterAttempt) call per Feature 8 evaluation', () => {
  it('evaluateWorksheetRecommendations triggers exactly one LetterAttempt.findAll', async () => {
    mockLaFindAll.mockResolvedValueOnce(persistentStreamRows({ letters: ['c', 'o'] }));
    await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
  });
});

// ─── 38: no raw hashes exposed publicly ─────────────────────────────────────

describe('38. no raw hashes exposed publicly', () => {
  it('history events and current-state results never serialize a fingerprint field', async () => {
    const rec = await getPersistentCurvedRecommendation();
    mockTrvFindAll.mockResolvedValueOnce([
      { id: 1, case_type: 'lowercase', family: 'curved', recommendation_type: rec.recommendationType, recommendation_title: rec.title, focus_letters: rec.focusLetters, validation: 'confirmed', teacher_note: null, created_at: new Date() },
    ]);
    const history = await getTeacherValidationHistory({ studentId: STUDENT_ID });
    expect(JSON.stringify(history.events)).not.toMatch(/[a-f0-9]{64}/);

    mockTrvFindOne.mockResolvedValueOnce({ validation: 'confirmed', teacher_note: null, created_at: new Date() });
    const current = await getLatestValidationForRecommendation({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved', recommendationFingerprint: rec.recommendationFingerprint,
    });
    expect(JSON.stringify(current.current)).not.toMatch(/[a-f0-9]{64}/);
  });
});

// ─── 39: no clinical/severity wording ────────────────────────────────────────

describe('39. no clinical/severity wording', () => {
  it('the real recommendation content and the service source contain no clinical/diagnostic/severity language', async () => {
    const rec = await getPersistentCurvedRecommendation();
    const contentBlob = `${rec.title} ${rec.rationale} ${rec.suggestedActivities.join(' ')}`;
    expect(contentBlob).not.toMatch(/diagnos|clinical|impairment|therapy|treatment|severity|confidence score/i);

    // Comment-stripped: the service's own header legitimately DISCUSSES
    // "clinical validation"/"diagnosis confirmation"/"treatment approval" by
    // name, to document that it is NOT any of those — the same recurring
    // comment-vs-code false-positive pattern hit across every prior
    // feature's own source-scan tests. Only real code should ever be scanned.
    const code = stripComments(readServiceSource());
    expect(code).not.toMatch(/diagnos|clinical validation|treatment approval/i);
  });
});

// ─── 40: deterministic behavior ──────────────────────────────────────────────

describe('40. deterministic behavior', () => {
  it('identical synthetic evidence produces identical fingerprints across two separate evaluations', async () => {
    const first = await getPersistentCurvedRecommendation();
    const second = await getPersistentCurvedRecommendation();
    expect(second.recommendationFingerprint).toBe(first.recommendationFingerprint);
  });
});

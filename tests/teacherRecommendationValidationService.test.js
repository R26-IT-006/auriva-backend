'use strict';

// Feature 9 Step 3 — validateWorksheetRecommendation() write-path tests.
// Mocks Feature 7 (persistentDifficultyService), Feature 8
// (worksheetRecommendationService), and the model layer (../src/models) —
// the same "mocks only the next-lower service" discipline every prior
// feature's own {feature}Service.test.js file already follows. No live DB
// write ever happens in this file.

jest.mock('../src/services/persistentDifficultyService');
jest.mock('../src/services/worksheetRecommendationService');
jest.mock('../src/models', () => ({
  TeacherRecommendationValidation: { findOrCreate: jest.fn() },
}));

const fs = require('fs');
const path = require('path');

const { evaluatePersistentDifficulty } = require('../src/services/persistentDifficultyService');
const { evaluateWorksheetRecommendations } = require('../src/services/worksheetRecommendationService');
const { TeacherRecommendationValidation } = require('../src/models');
const { validateWorksheetRecommendation, MAX_TEACHER_NOTE_LENGTH } = require('../src/services/teacherRecommendationValidationService');
const {
  computePersistentEvidenceFingerprint, computeWorksheetRecommendationFingerprint,
  PERSISTENT_DIFFICULTY_POLICY_VERSION, WORKSHEET_RECOMMENDATION_POLICY_VERSION,
} = require('../src/config/feature9Provenance');
const { MAPPING_VERSION } = require('../src/config/letterBaselineFamilies');

const STUDENT_ID = 13;
const TEACHER_ID = 4;

const EARLIER_WINDOW = {
  successfulCycles: 1, failedCycles: 4,
  evidenceStart: '2026-08-01T10:00:00.000Z', evidenceEnd: '2026-08-01T12:00:00.000Z',
};
const RECENT_WINDOW = {
  successfulCycles: 0, failedCycles: 5,
  evidenceStart: '2026-08-03T10:00:00.000Z', evidenceEnd: '2026-08-03T12:00:00.000Z',
};
const AFFECTED_LETTERS = [
  { letter: 'c', totalCycles: 6, failedCycles: 6 },
  { letter: 'o', totalCycles: 4, failedCycles: 3 },
];

const EXPECTED_EVIDENCE_FINGERPRINT = computePersistentEvidenceFingerprint({
  studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved',
  earlierWindow: EARLIER_WINDOW, recentWindow: RECENT_WINDOW, affectedLetters: AFFECTED_LETTERS,
  persistentPolicyVersion: PERSISTENT_DIFFICULTY_POLICY_VERSION, mappingVersion: MAPPING_VERSION,
});
const EXPECTED_RECOMMENDATION_FINGERPRINT = computeWorksheetRecommendationFingerprint({
  studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved',
  recommendationType: 'motor_family_practice', focusLetters: ['c', 'o'],
  evidenceFingerprint: EXPECTED_EVIDENCE_FINGERPRINT,
  recommendationPolicyVersion: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
});

function emptyStreams() {
  const streams = { lowercase: {}, uppercase: {} };
  for (const caseType of ['lowercase', 'uppercase']) {
    for (const family of ['straight', 'curved', 'complex']) {
      streams[caseType][family] = {
        caseType, family, status: 'insufficient_data', reason: 'insufficient_cycles',
        validCycleCount: 0, usableCycleCount: 0, windowSize: 5, requiredSeparationMs: 86400000,
        earlierWindow: null, recentWindow: null, separationMs: null, affectedLetters: [],
      };
    }
  }
  return streams;
}

function persistentStream(overrides = {}) {
  return {
    caseType: 'lowercase', family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
    validCycleCount: 10, usableCycleCount: 10, windowSize: 5, requiredSeparationMs: 86400000,
    earlierWindow: EARLIER_WINDOW, recentWindow: RECENT_WINDOW, separationMs: 190800000,
    affectedLetters: AFFECTED_LETTERS,
    ...overrides,
  };
}

function feature7EvaluatedResult(overrides = {}) {
  const streams = emptyStreams();
  streams.lowercase.curved = persistentStream();
  return {
    status: 'evaluated', studentId: STUDENT_ID, evaluatedAt: '2026-08-14T00:00:00.000Z', streams,
    summary: { evaluatedStreamCount: 6, persistentCount: 1, notPersistentCount: 0, insufficientDataCount: 5, persistentStreams: [{ caseType: 'lowercase', family: 'curved' }] },
    ...overrides,
  };
}

function feature8Recommendation(overrides = {}) {
  return {
    recommendationType: 'motor_family_practice', caseType: 'lowercase', family: 'curved',
    title: 'Curved Movement Practice', focusLetters: ['c', 'o'],
    rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods.',
    suggestedActivities: ['Circle tracing exercises', 'Curved-line guided tracing'],
    ...overrides,
  };
}

function feature8EvaluatedResult(overrides = {}) {
  return {
    status: 'evaluated', studentId: STUDENT_ID, evaluatedAt: '2026-08-14T00:00:00.000Z',
    recommendations: [feature8Recommendation()],
    summary: { evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 0, insufficientDataCount: 5, recommendationCount: 1 },
    ...overrides,
  };
}

const ACTION_ID_1 = '11111111-1111-4111-8111-111111111111';
const ACTION_ID_2 = '22222222-2222-4222-8222-222222222222';
const ACTION_ID_3 = '33333333-3333-4333-8333-333333333333';
const ACTION_ID_4 = '44444444-4444-4444-8444-444444444444';

function validArgs(overrides = {}) {
  return {
    studentId: STUDENT_ID, teacherId: TEACHER_ID, caseType: 'lowercase', family: 'curved',
    validation: 'confirmed', teacherNote: undefined,
    recommendationFingerprint: EXPECTED_RECOMMENDATION_FINGERPRINT,
    actionId: ACTION_ID_1,
    ...overrides,
  };
}

beforeEach(() => {
  // mockReset (not clearAllMocks) — clears any queued mockResolvedValueOnce
  // left over from a prior test, avoiding the cross-test mock-queue leak
  // hit repeatedly in Features 6/8's own test suites.
  evaluatePersistentDifficulty.mockReset();
  evaluateWorksheetRecommendations.mockReset();
  TeacherRecommendationValidation.findOrCreate.mockReset();

  evaluatePersistentDifficulty.mockResolvedValue(feature7EvaluatedResult());
  evaluateWorksheetRecommendations.mockResolvedValue(feature8EvaluatedResult());
  TeacherRecommendationValidation.findOrCreate.mockResolvedValue([
    { id: 1, created_at: new Date('2026-08-14T12:00:00.000Z') }, true,
  ]);
});

// ─── 27-32: input validation ────────────────────────────────────────────────

describe('input validation (spec §37)', () => {
  it('27. invalid studentId returns invalid_input, without calling Feature 7/8', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ studentId: -1 }));
    expect(result.status).toBe('invalid_input');
    expect(evaluatePersistentDifficulty).not.toHaveBeenCalled();
    expect(evaluateWorksheetRecommendations).not.toHaveBeenCalled();
  });

  it('28. invalid teacherId returns invalid_input', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ teacherId: 0 }));
    expect(result.status).toBe('invalid_input');
  });

  it('29. invalid caseType returns invalid_input', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ caseType: 'mixedcase' }));
    expect(result.status).toBe('invalid_input');
  });

  it('30. invalid family returns invalid_input', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ family: 'diagonal' }));
    expect(result.status).toBe('invalid_input');
  });

  it('31. invalid validation value returns invalid_input', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ validation: 'approved' }));
    expect(result.status).toBe('invalid_input');
  });

  it('32. malformed recommendationFingerprint returns invalid_input', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ recommendationFingerprint: 'not-a-hash' }));
    expect(result.status).toBe('invalid_input');
  });

  // Feature 9 repair (final integration audit finding) — actionId is now a
  // required, validated field: the sole idempotency key.
  it('missing actionId returns invalid_input, no write', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ actionId: undefined }));
    expect(result.status).toBe('invalid_input');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });

  it('malformed actionId returns invalid_input, no write', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ actionId: 'not-a-uuid' }));
    expect(result.status).toBe('invalid_input');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });
});

// ─── 33-34: teacher note normalization ──────────────────────────────────────

describe('teacher-note normalization (spec §17)', () => {
  it('33. a note longer than MAX_TEACHER_NOTE_LENGTH returns invalid_input, no write', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ teacherNote: 'x'.repeat(MAX_TEACHER_NOTE_LENGTH + 1) }));
    expect(result.status).toBe('invalid_input');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });

  it('34. a whitespace-only note is normalized to null before writing', async () => {
    await validateWorksheetRecommendation(validArgs({ teacherNote: '   \n  ' }));
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.teacher_note).toBeNull();
  });

  it('a note with surrounding whitespace is trimmed before writing', async () => {
    await validateWorksheetRecommendation(validArgs({ teacherNote: '  Tired today  ' }));
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.teacher_note).toBe('Tired today');
  });
});

// ─── 35-37: Feature 7/8 composition ─────────────────────────────────────────

describe('Feature 7/8 composition (spec §38-§40)', () => {
  it('35. Feature 8 (and Feature 7) are each called exactly once per validation call', async () => {
    await validateWorksheetRecommendation(validArgs());
    expect(evaluateWorksheetRecommendations).toHaveBeenCalledTimes(1);
    expect(evaluateWorksheetRecommendations).toHaveBeenCalledWith({ studentId: STUDENT_ID });
    expect(evaluatePersistentDifficulty).toHaveBeenCalledTimes(1);
    expect(evaluatePersistentDifficulty).toHaveBeenCalledWith({ studentId: STUDENT_ID });
  });

  it('36. Feature 8 read_failed returns read_failed, no write', async () => {
    evaluateWorksheetRecommendations.mockResolvedValue({ status: 'read_failed', studentId: STUDENT_ID, evaluatedAt: null, recommendations: null, summary: null });
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.status).toBe('read_failed');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });

  it('Feature 7 read_failed also returns read_failed, no write', async () => {
    evaluatePersistentDifficulty.mockResolvedValue({ status: 'read_failed', studentId: STUDENT_ID, evaluatedAt: null, streams: null, summary: null });
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.status).toBe('read_failed');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });

  it('37. no matching Feature 8 recommendation for the requested stream returns recommendation_not_found, no write', async () => {
    evaluateWorksheetRecommendations.mockResolvedValue(feature8EvaluatedResult({ recommendations: [] }));
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.status).toBe('recommendation_not_found');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });

  it('a Feature 8 recommendation whose Feature 7 stream is no longer persistent returns recommendation_not_found, no write', async () => {
    const streams = emptyStreams(); // lowercase.curved stays insufficient_data, never persistent
    evaluatePersistentDifficulty.mockResolvedValue(feature7EvaluatedResult({ streams }));
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.status).toBe('recommendation_not_found');
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });
});

// ─── 38-41: fingerprint verification + trusted snapshot ────────────────────

describe('fingerprint verification and trusted snapshot (spec §45-§46)', () => {
  it('38. a client fingerprint mismatch returns recommendation_changed with the current server fingerprint, no write', async () => {
    const result = await validateWorksheetRecommendation(validArgs({ recommendationFingerprint: 'f'.repeat(64) }));
    expect(result.status).toBe('recommendation_changed');
    expect(result.currentRecommendationFingerprint).toBe(EXPECTED_RECOMMENDATION_FINGERPRINT);
    expect(TeacherRecommendationValidation.findOrCreate).not.toHaveBeenCalled();
  });

  it('39. a matching fingerprint creates exactly one row', async () => {
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.status).toBe('validated');
    expect(TeacherRecommendationValidation.findOrCreate).toHaveBeenCalledTimes(1);
  });

  it('40. the written snapshot comes from the server-side Feature 8 result', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.recommendation_title).toBe('Curved Movement Practice');
    expect(defaults.rationale).toBe(feature8Recommendation().rationale);
    expect(defaults.suggested_activities).toEqual(feature8Recommendation().suggestedActivities);
  });

  it('41. client-supplied content fields (even if present on the input object) never reach the write', async () => {
    await validateWorksheetRecommendation({
      ...validArgs(),
      title: 'FAKE TITLE FROM CLIENT',
      focusLetters: ['x', 'y'],
      rationale: 'FAKE RATIONALE',
    });
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.recommendation_title).toBe('Curved Movement Practice');
    expect(defaults.focus_letters).toEqual(['c', 'o']);
    expect(defaults.rationale).not.toBe('FAKE RATIONALE');
  });
});

// ─── 42-48: snapshot field fidelity ─────────────────────────────────────────

describe('snapshot field fidelity (spec §32/§46/§47/§48)', () => {
  it('42. focus letters preserve order exactly as Feature 8 returned them', async () => {
    evaluateWorksheetRecommendations.mockResolvedValue(feature8EvaluatedResult({
      recommendations: [feature8Recommendation({ focusLetters: ['o', 'c'] })],
    }));
    // Recompute expected fingerprints for this reordered-letters scenario so the race check still passes.
    const evidenceFp = EXPECTED_EVIDENCE_FINGERPRINT;
    const recFp = computeWorksheetRecommendationFingerprint({
      studentId: STUDENT_ID, caseType: 'lowercase', family: 'curved',
      recommendationType: 'motor_family_practice', focusLetters: ['o', 'c'],
      evidenceFingerprint: evidenceFp, recommendationPolicyVersion: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
    });
    await validateWorksheetRecommendation(validArgs({ recommendationFingerprint: recFp }));
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.focus_letters).toEqual(['o', 'c']);
  });

  it('43. case (lowercase/uppercase) is preserved on the written row', async () => {
    const streams = emptyStreams();
    streams.uppercase.straight = persistentStream({ caseType: 'uppercase', family: 'straight', affectedLetters: [{ letter: 'I', totalCycles: 5, failedCycles: 5 }] });
    evaluatePersistentDifficulty.mockResolvedValue(feature7EvaluatedResult({ streams }));
    const rec = feature8Recommendation({ caseType: 'uppercase', family: 'straight', title: 'Straight Movement Practice', focusLetters: ['I'] });
    evaluateWorksheetRecommendations.mockResolvedValue(feature8EvaluatedResult({ recommendations: [rec] }));

    const evidenceFp = computePersistentEvidenceFingerprint({
      studentId: STUDENT_ID, caseType: 'uppercase', family: 'straight',
      earlierWindow: EARLIER_WINDOW, recentWindow: RECENT_WINDOW,
      affectedLetters: [{ letter: 'I', totalCycles: 5, failedCycles: 5 }],
      persistentPolicyVersion: PERSISTENT_DIFFICULTY_POLICY_VERSION, mappingVersion: MAPPING_VERSION,
    });
    const recFp = computeWorksheetRecommendationFingerprint({
      studentId: STUDENT_ID, caseType: 'uppercase', family: 'straight',
      recommendationType: 'motor_family_practice', focusLetters: ['I'],
      evidenceFingerprint: evidenceFp, recommendationPolicyVersion: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
    });

    await validateWorksheetRecommendation(validArgs({ caseType: 'uppercase', family: 'straight', recommendationFingerprint: recFp }));
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.case_type).toBe('uppercase');
    expect(defaults.focus_letters).toEqual(['I']);
  });

  it('44. persistent_policy_version and recommendation_policy_version are persisted from trusted constants', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.persistent_policy_version).toBe(PERSISTENT_DIFFICULTY_POLICY_VERSION);
    expect(defaults.recommendation_policy_version).toBe(WORKSHEET_RECOMMENDATION_POLICY_VERSION);
  });

  it('45. mapping_version is persisted from letterBaselineFamilies.js\'s own constant', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.mapping_version).toBe(MAPPING_VERSION);
  });

  it('46. evidence_fingerprint is persisted', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.evidence_fingerprint).toBe(EXPECTED_EVIDENCE_FINGERPRINT);
  });

  it('47. recommendation_fingerprint is persisted', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.recommendation_fingerprint).toBe(EXPECTED_RECOMMENDATION_FINGERPRINT);
  });

  it('48. teacherId is persisted exactly from the trusted function argument', async () => {
    await validateWorksheetRecommendation(validArgs({ teacherId: 99 }));
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.teacher_id).toBe(99);
  });
});

// ─── 49-50: idempotency / append-only semantics ─────────────────────────────

describe('idempotency and append-only semantics — Feature 9 repair (final integration audit finding)', () => {
  it('49. a duplicate identical action (same actionId) is idempotent (findOrCreate returns created:false)', async () => {
    TeacherRecommendationValidation.findOrCreate.mockResolvedValue([
      { id: 7, created_at: new Date('2026-08-10T00:00:00.000Z') }, false,
    ]);
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.status).toBe('validated');
    expect(result.duplicate).toBe(true);
    expect(result.id).toBe(7);
  });

  it('a first-time write is not marked duplicate', async () => {
    const result = await validateWorksheetRecommendation(validArgs());
    expect(result.duplicate).toBe(false);
  });

  it('the findOrCreate where-clause keys on action_id ALONE — never the old semantic tuple', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ where }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(Object.keys(where)).toEqual(['action_id']);
    expect(where.action_id).toBe(ACTION_ID_1);
  });

  it('the defaults still carry student/teacher/case/family/validation for the new row', async () => {
    await validateWorksheetRecommendation(validArgs());
    const [{ defaults }] = TeacherRecommendationValidation.findOrCreate.mock.calls[0];
    expect(defaults.student_id).toBe(STUDENT_ID);
    expect(defaults.teacher_id).toBe(TEACHER_ID);
    expect(defaults.case_type).toBe('lowercase');
    expect(defaults.family).toBe('curved');
    expect(defaults.validation).toBe('confirmed');
    expect(defaults.action_id).toBe(ACTION_ID_1);
  });

  it('50. confirmed then dismissed for the same recommendation produces two separate findOrCreate calls, keyed on their own distinct actionIds', async () => {
    await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_1 }));
    await validateWorksheetRecommendation(validArgs({ validation: 'dismissed', actionId: ACTION_ID_2 }));

    expect(TeacherRecommendationValidation.findOrCreate).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = TeacherRecommendationValidation.findOrCreate.mock.calls;
    expect(firstCall[0].where.action_id).toBe(ACTION_ID_1);
    expect(firstCall[0].defaults.validation).toBe('confirmed');
    expect(secondCall[0].where.action_id).toBe(ACTION_ID_2);
    expect(secondCall[0].defaults.validation).toBe('dismissed');
  });

  // ── Alternating-state acceptance test (repair spec §12) ────────────────────
  // Confirm → Dismiss → Confirm → Dismiss: each action gets its own actionId
  // (exactly how the real frontend behaves — one fresh UUID per button
  // press) and therefore its own findOrCreate call/row, never colliding
  // with an earlier historical row even though `validation` repeats.
  it('Confirm -> Dismiss -> Confirm -> Dismiss creates 4 separate findOrCreate calls, one per action, in order', async () => {
    await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_1 }));
    await validateWorksheetRecommendation(validArgs({ validation: 'dismissed', actionId: ACTION_ID_2 }));
    await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_3 }));
    await validateWorksheetRecommendation(validArgs({ validation: 'dismissed', actionId: ACTION_ID_4 }));

    expect(TeacherRecommendationValidation.findOrCreate).toHaveBeenCalledTimes(4);
    const calls = TeacherRecommendationValidation.findOrCreate.mock.calls;
    expect(calls.map((c) => c[0].where.action_id)).toEqual([ACTION_ID_1, ACTION_ID_2, ACTION_ID_3, ACTION_ID_4]);
    expect(calls.map((c) => c[0].defaults.validation)).toEqual(['confirmed', 'dismissed', 'confirmed', 'dismissed']);
    // None of the 4 where-clauses collide with each other — this is exactly
    // what the old semantic key (student/teacher/case/family/validation/
    // fingerprint) could NOT guarantee for calls 1 and 3 (both 'confirmed'
    // for the identical recommendation instance).
    const whereClauses = calls.map((c) => JSON.stringify(c[0].where));
    expect(new Set(whereClauses).size).toBe(4);
  });

  // ── Same-action retry test (repair spec §13) ────────────────────────────────
  it('a retry of the SAME action (identical actionId) does not create a second row', async () => {
    await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_1 }));
    // Simulate client.js's response interceptor resending the identical body.
    TeacherRecommendationValidation.findOrCreate.mockResolvedValueOnce([
      { id: 1, created_at: new Date('2026-08-14T12:00:00.000Z') }, false,
    ]);
    const retryResult = await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_1 }));

    expect(TeacherRecommendationValidation.findOrCreate).toHaveBeenCalledTimes(2);
    expect(TeacherRecommendationValidation.findOrCreate.mock.calls[1][0].where.action_id).toBe(ACTION_ID_1);
    expect(retryResult.duplicate).toBe(true);
  });

  it('a genuinely new action with the same validation+fingerprint as an earlier action still creates a new row', async () => {
    await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_1 }));
    // Different actionId, but same validation/fingerprint as the first call —
    // this is exactly the case the old semantic key incorrectly deduplicated.
    await validateWorksheetRecommendation(validArgs({ validation: 'confirmed', actionId: ACTION_ID_2 }));

    expect(TeacherRecommendationValidation.findOrCreate).toHaveBeenCalledTimes(2);
    expect(TeacherRecommendationValidation.findOrCreate.mock.calls[0][0].where.action_id).toBe(ACTION_ID_1);
    expect(TeacherRecommendationValidation.findOrCreate.mock.calls[1][0].where.action_id).toBe(ACTION_ID_2);
  });
});

// ─── 51-56: write-method + source-scan discipline ───────────────────────────

function readServiceSource() {
  return fs.readFileSync(path.resolve(__dirname, '../src/services/teacherRecommendationValidationService.js'), 'utf8');
}

function requireLines(source) {
  return source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
}

// The module's own header/JSDoc comments legitimately DISCUSS every one of
// these excluded names/methods by name, to document why they are excluded
// (e.g. "never calls .update()/.destroy()/.save()", "never imports ...
// RecommendationHistory, or TeacherValidation") — exactly the recurring
// comment-vs-code false-positive pattern hit across Features 6-9's own
// source-scan tests. Strip /* */ and // comments before scanning actual
// code, rather than scoping only to require(...) lines, since these checks
// need to catch code patterns (method calls), not just import statements.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('write-method and source-scan discipline (spec §34/§53-§56, §70/§71)', () => {
  it('51. the service never calls .update() on a model instance/class', () => {
    expect(stripComments(readServiceSource())).not.toMatch(/\.update\(/);
  });

  it('52. the service never calls .destroy()/.bulkUpdate()/.save() on an existing row', () => {
    const code = stripComments(readServiceSource());
    expect(code).not.toMatch(/\.destroy\(/);
    expect(code).not.toMatch(/\.bulkUpdate\(/);
    expect(code).not.toMatch(/\.save\(/);
  });

  it('the only TeacherRecommendationValidation write method used anywhere is findOrCreate (findAll/findOne are read-only, expected in the history path)', () => {
    const code = stripComments(readServiceSource());
    const modelMethodCalls = code.match(/TeacherRecommendationValidation\.\w+\(/g) || [];
    const writeCalls = modelMethodCalls.filter((call) => !/\.(findAll|findOne)\(/.test(call));
    expect(writeCalls.every((call) => call === 'TeacherRecommendationValidation.findOrCreate(')).toBe(true);
    expect(writeCalls.length).toBeGreaterThan(0);
  });

  it('53. never imports any Feature 1-6 service', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/StudentMotorBaseline/);
    expect(lines).not.toMatch(/dynamicThresholdService/);
    expect(lines).not.toMatch(/adaptiveSupportService/);
    expect(lines).not.toMatch(/adaptivePreWritingService/);
    expect(lines).not.toMatch(/repetitionRecommendationService/);
    expect(lines).not.toMatch(/demoSpeedRecommendationService/);
  });

  it('54. never imports or queries LetterAttempt directly', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/LetterAttempt/);
  });

  it('55. never imports or writes to RecommendationHistory', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/RecommendationHistory/);
  });

  it('56. never imports or writes to TeacherValidation (the unrelated collection-mode table)', () => {
    // Deliberately does NOT false-positive on "TeacherRecommendationValidation"
    // itself — "TeacherValidation" is not a contiguous substring of
    // "TeacherRecommendationValidation" ("Recommendation" sits between them).
    const lines = requireLines(readServiceSource());
    expect(lines).not.toMatch(/\bTeacherValidation\b/);
  });

  it('only imports persistentDifficultyService and worksheetRecommendationService among Feature 7/8 modules', () => {
    const lines = requireLines(readServiceSource());
    expect(lines).toMatch(/persistentDifficultyService/);
    expect(lines).toMatch(/worksheetRecommendationService/);
    expect(lines).not.toMatch(/persistentDifficultyEvidence/);
    expect(lines).not.toMatch(/worksheetRecommendationPolicy/);
  });
});

'use strict';

/**
 * Historical letter-motor evidence backfill — scripts/auditLetterMotorBackfill.js
 * and scripts/backfillLetterMotorEvidence.js.
 *
 * The backfill exists to recover evidence rows the old `created === true`
 * gate suppressed. Its entire value rests on one property: every field it
 * writes is copied out of a LetterAttempt row that already exists. These
 * tests pin that property down, and pin down every case where the script
 * must REFUSE to write rather than approximate.
 *
 * validateEvidenceEligibility() and checkAndTriggerMilestones() are the REAL
 * implementations here (only the models and the ML client are mocked), so a
 * change to the eligibility rule or the milestone/OOD logic breaks these
 * tests rather than silently changing what gets backfilled.
 */

const mockStudentFindAll = jest.fn();
const mockLetterProgressFindAll = jest.fn();
const mockLetterProgressCreate = jest.fn();
const mockLetterProgressUpdate = jest.fn();
const mockLetterAttemptFindAll = jest.fn();
const mockLetterAttemptCreate = jest.fn();
const mockLetterAttemptUpdate = jest.fn();
const mockEvidenceFindOne = jest.fn();
const mockEvidenceFindAll = jest.fn();
const mockEvidenceCreate = jest.fn();
const mockHistoryFindOne = jest.fn();
const mockHistoryCreate = jest.fn();
const mockPredictLetterMotorState = jest.fn();

const mockEvaluationFindOne = jest.fn();
const mockEvaluationFindAll = jest.fn();
const mockEvaluationCreate  = jest.fn();

jest.mock('../src/models', () => ({
  Student: { findAll: (...a) => mockStudentFindAll(...a) },
  LetterProgress: {
    findAll: (...a) => mockLetterProgressFindAll(...a),
    create: (...a) => mockLetterProgressCreate(...a),
    update: (...a) => mockLetterProgressUpdate(...a),
  },
  LetterAttempt: {
    findAll: (...a) => mockLetterAttemptFindAll(...a),
    create: (...a) => mockLetterAttemptCreate(...a),
    update: (...a) => mockLetterAttemptUpdate(...a),
  },
  LetterMotorMasteryEvidence: {
    findOne: (...a) => mockEvidenceFindOne(...a),
    findAll: (...a) => mockEvidenceFindAll(...a),
    create: (...a) => mockEvidenceCreate(...a),
  },
  LetterMotorStateHistory: {
    findOne: (...a) => mockHistoryFindOne(...a),
    create: (...a) => mockHistoryCreate(...a),
    count: jest.fn().mockResolvedValue(0),
  },
  // S2 - the sibling evaluation-events table.
  LetterMotorStateEvaluation: {
    findOne: (...a) => mockEvaluationFindOne(...a),
    findAll: (...a) => mockEvaluationFindAll(...a),
    create: (...a) => mockEvaluationCreate(...a),
  },
  sequelize: { options: {}, close: jest.fn() },
}));

jest.mock('../src/services/mlServiceClient', () => ({
  predictLetterMotorState: (...a) => mockPredictLetterMotorState(...a),
}));

const { classifyLetter } = require('../scripts/auditLetterMotorBackfill');
const { backfill, buildEvidencePayload } = require('../scripts/backfillLetterMotorEvidence');
const { MILESTONES } = require('../src/config/letterMotorMilestones');

const MASTERING_AT = new Date('2026-08-18T15:02:43.131Z');
const EARLIER_AT = new Date('2026-08-18T15:02:19.925Z');

/** An attempt-3 row that satisfies every eligibility condition. */
function eligibleAttempt3(overrides = {}) {
  return {
    id: 1187,
    student_id: 40,
    letter: 'c',
    case_type: 'lowercase',
    session_key: 'pass-session',
    attempt_number: 3,
    passed: true,
    support_level: 'low',
    collection_mode: false,
    source_type: null,
    capture_status: 'complete',
    feature_version: 'v1',
    template_version: 't1',
    normalization_version: 'n1',
    created_at: MASTERING_AT,
    normalized_features: { smoothness_score: 90, dtw_distance: 3.04, speed_cv: 0.46 },
    ...overrides,
  };
}

/** A three-attempt session sharing one session_key. */
function session({ key, passed, at, a3 = {} }) {
  return [1, 2, 3].map(n => eligibleAttempt3({
    id: 1000 + (key.length * 10) + n,
    session_key: key,
    attempt_number: n,
    passed,
    created_at: at,
    ...(n === 3 ? a3 : {}),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStudentFindAll.mockResolvedValue([{ sid: 40, full_name: 'Kasun Perera' }]);
  mockLetterProgressFindAll.mockResolvedValue([{ letter: 'c', case_type: 'lowercase' }]);
  mockEvidenceFindOne.mockResolvedValue(null);
  mockEvidenceFindAll.mockResolvedValue([]);
  mockEvidenceCreate.mockImplementation(async p => ({ id: 1, ...p }));
  mockHistoryFindOne.mockResolvedValue(null);
  mockHistoryCreate.mockImplementation(async p => ({ id: 1, ...p }));
  // S2 defaults: nothing evaluated yet, and evaluation writes succeed.
  mockEvaluationFindOne.mockResolvedValue(null);
  mockEvaluationFindAll.mockResolvedValue([]);
  mockEvaluationCreate.mockImplementation(async p => ({ id: 1, ...p }));
});

// ─── The exact bug being recovered from ────────────────────────────────────
describe('historical FAIL -> PASS letter, where LetterProgress already existed', () => {
  it('is backfillable, and takes its data from the PASSING session', async () => {
    mockLetterAttemptFindAll.mockResolvedValue([
      ...session({ key: 'failed', passed: false, at: EARLIER_AT }),
      ...session({ key: 'passed', passed: true, at: MASTERING_AT }),
    ]);

    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });

    expect(verdict.status).toBe('backfillable');
    expect(verdict.row.session_key).toBe('passed');
    expect(verdict.row.created_at).toEqual(MASTERING_AT);
  });

  it('never takes mastered_at from the earlier FAILED session', async () => {
    // This is the whole reason LetterProgress.completed_at is unusable as a
    // timestamp source: it defaults to NOW when the blocked branch creates
    // the row, so it records the FAILURE, not the mastery.
    mockLetterAttemptFindAll.mockResolvedValue([
      ...session({ key: 'failed', passed: false, at: EARLIER_AT }),
      ...session({ key: 'passed', passed: true, at: MASTERING_AT }),
    ]);

    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    const payload = buildEvidencePayload({
      studentId: 40, letter: 'c', caseType: 'lowercase', row: verdict.row,
    });

    expect(payload.mastered_at).toEqual(MASTERING_AT);
    expect(payload.mastered_at).not.toEqual(EARLIER_AT);
  });
});

describe('historical direct PASS letter', () => {
  it('is backfillable from its single passing session', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.status).toBe('backfillable');
  });

  it('uses the EARLIEST passing session, never a later re-practice', async () => {
    const later = new Date('2026-08-20T09:00:00.000Z');
    mockLetterAttemptFindAll.mockResolvedValue([
      ...session({ key: 'first-pass', passed: true, at: MASTERING_AT }),
      ...session({ key: 'repractice', passed: true, at: later }),
    ]);
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.row.session_key).toBe('first-pass');
    expect(verdict.row.created_at).toEqual(MASTERING_AT);
  });
});

// ─── Nothing is invented ───────────────────────────────────────────────────
describe('every written field is copied from the source attempt row', () => {
  it('copies the feature values, versions and support level verbatim', () => {
    const row = eligibleAttempt3();
    const payload = buildEvidencePayload({ studentId: 40, letter: 'c', caseType: 'lowercase', row });

    expect(payload).toEqual({
      student_id: 40,
      letter: 'c',
      case_type: 'lowercase',
      letter_attempt_id: row.id,
      mastered_at: row.created_at,
      smoothness_score: row.normalized_features.smoothness_score,
      dtw_distance: row.normalized_features.dtw_distance,
      speed_cv: row.normalized_features.speed_cv,
      support_level: row.support_level,
      feature_version: row.feature_version,
      template_version: row.template_version,
      normalization_version: row.normalization_version,
    });
  });

  it('mastered_at is the historical capture time, never the time the script runs', () => {
    const before = Date.now();
    const payload = buildEvidencePayload({
      studentId: 40, letter: 'c', caseType: 'lowercase', row: eligibleAttempt3(),
    });
    expect(new Date(payload.mastered_at).getTime()).toBeLessThan(before);
  });

  it('carries the source attempt id so each row stays traceable', () => {
    const payload = buildEvidencePayload({
      studentId: 40, letter: 'c', caseType: 'lowercase', row: eligibleAttempt3({ id: 9876 }),
    });
    expect(payload.letter_attempt_id).toBe(9876);
  });
});

// ─── Refusals ──────────────────────────────────────────────────────────────
describe('rows that must be refused rather than approximated', () => {
  it.each([
    ['smoothness missing', { normalized_features: { dtw_distance: 3, speed_cv: 0.4 } }, 'smoothness_score_not_finite'],
    ['dtw missing', { normalized_features: { smoothness_score: 90, speed_cv: 0.4 } }, 'dtw_distance_invalid'],
    ['speed_cv missing', { normalized_features: { smoothness_score: 90, dtw_distance: 3 } }, 'speed_cv_invalid'],
    ['negative dtw', { normalized_features: { smoothness_score: 90, dtw_distance: -1, speed_cv: 0.4 } }, 'dtw_distance_invalid'],
    ['support_level null (old client)', { support_level: null }, 'support_level_not_low'],
    ['support_level high', { support_level: 'high' }, 'support_level_not_low'],
    ['feature_version null', { feature_version: null }, 'feature_version_null'],
    ['template_version null', { template_version: null }, 'template_version_null'],
    ['normalization_version null', { normalization_version: null }, 'normalization_version_null'],
    ['capture incomplete', { capture_status: 'partial' }, 'capture_status_not_complete'],
    ['source_type set', { source_type: 'reassessment' }, 'source_type_not_null'],
  ])('refuses %s', async (_label, override, expectedReason) => {
    mockLetterAttemptFindAll.mockResolvedValue(
      session({ key: 'only', passed: true, at: MASTERING_AT, a3: override })
    );
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.status).toBe('not_backfillable');
    expect(verdict.reason).toBe(expectedReason);
    expect(verdict.row).toBeNull();
  });

  it('refuses a letter with no recorded passing session', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'failed', passed: false, at: EARLIER_AT }));
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.reason).toBe('no_passing_session_recorded');
  });

  it('refuses a passing session that has no attempt-3 row', async () => {
    const rows = session({ key: 'short', passed: true, at: MASTERING_AT }).filter(r => r.attempt_number !== 3);
    mockLetterAttemptFindAll.mockResolvedValue(rows);
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.reason).toBe('mastering_session_has_no_attempt_3');
  });

  it('refuses a row with no historical timestamp rather than substituting one', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(
      session({ key: 'only', passed: true, at: MASTERING_AT, a3: { created_at: null } })
    );
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.status).toBe('not_backfillable');
    expect(verdict.reason).toBe('no_historical_timestamp');
  });

  it('refuses when the letter has no non-collection attempts at all', async () => {
    mockLetterAttemptFindAll.mockResolvedValue([]);
    const verdict = await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(verdict.reason).toBe('no_non_collection_attempts');
  });

  it('queries only non-collection attempts, so collection rows can never be a source', async () => {
    mockLetterAttemptFindAll.mockResolvedValue([]);
    await classifyLetter({ studentId: 40, letter: 'c', caseType: 'lowercase' });
    expect(mockLetterAttemptFindAll.mock.calls[0][0].where).toMatchObject({ collection_mode: false });
  });
});

// ─── Idempotency and write scope ───────────────────────────────────────────
describe('idempotency', () => {
  it('a rerun over already-backfilled letters creates nothing', async () => {
    mockEvidenceFindOne.mockResolvedValue({ id: 1, letter: 'c', case_type: 'lowercase' });
    const result = await backfill({ commit: true });
    expect(mockEvidenceCreate).not.toHaveBeenCalled();
    expect(result.totals.created).toBe(0);
    expect(result.totals.skippedExisting).toBe(1);
  });

  it('treats a unique-constraint violation as already-present, not a failure', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    const err = new Error('duplicate');
    err.name = 'SequelizeUniqueConstraintError';
    mockEvidenceCreate.mockRejectedValueOnce(err);

    const result = await backfill({ commit: true });
    expect(result.totals.created).toBe(0);
    expect(result.totals.skippedExisting).toBe(1);
  });

  it('an existing evidence row is never overwritten', async () => {
    mockEvidenceFindOne.mockResolvedValue({ id: 1, smoothness_score: 11 });
    await backfill({ commit: true });
    expect(mockEvidenceCreate).not.toHaveBeenCalled();
  });
});

describe('dry run', () => {
  it('writes nothing but still reports what it would write', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    const result = await backfill({ commit: false });
    expect(mockEvidenceCreate).not.toHaveBeenCalled();
    expect(mockHistoryCreate).not.toHaveBeenCalled();
    expect(result.totals.created).toBe(1);
  });
});

describe('write scope — exactly one table', () => {
  it('never writes to LetterProgress or LetterAttempt', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    await backfill({ commit: true });
    expect(mockLetterProgressCreate).not.toHaveBeenCalled();
    expect(mockLetterProgressUpdate).not.toHaveBeenCalled();
    expect(mockLetterAttemptCreate).not.toHaveBeenCalled();
    expect(mockLetterAttemptUpdate).not.toHaveBeenCalled();
  });

  it('only considers reference letters — a non-reference mastery is never examined', async () => {
    mockLetterProgressFindAll.mockResolvedValue([{ letter: 'z', case_type: 'lowercase' }]);
    const result = await backfill({ commit: true });
    expect(mockEvidenceCreate).not.toHaveBeenCalled();
    expect(result.totals.created).toBe(0);
    expect(result.totals.blocked).toBe(0);
  });
});

// ─── Milestones go through the normal service ──────────────────────────────
describe('milestone handling uses the real service, never a fabricated label', () => {
  const FOURTEEN = MILESTONES[0].requiredPairs;

  function evidenceRowsFor(pairs) {
    return pairs.map((p, i) => ({
      letter: p.letter, case_type: p.caseType,
      smoothness_score: 90 + i, dtw_distance: 3 + i, speed_cv: 0.4,
      feature_version: 'v1', template_version: 't1', normalization_version: 'n1',
    }));
  }

  it('below 14: records no state history and never calls the model', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    mockEvidenceFindAll.mockResolvedValue(evidenceRowsFor(FOURTEEN.slice(0, 4)));

    const result = await backfill({ commit: true });

    expect(mockPredictLetterMotorState).not.toHaveBeenCalled();
    expect(mockHistoryCreate).not.toHaveBeenCalled();
    const statuses = result.results[0].milestoneResults.map(m => m.status);
    expect(statuses).toEqual(['not_yet_eligible', 'not_yet_eligible', 'not_yet_eligible']);
  });

  it('reaching 14: calls the frozen model and persists the state it returns', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    mockEvidenceFindAll.mockResolvedValue(evidenceRowsFor(FOURTEEN));
    mockPredictLetterMotorState.mockResolvedValue({
      status: 'ok', cluster_id: 1, state_code: 'LETTER_STATE_B', display_name: 'State B',
      nearest_distance: 1.1, second_nearest_distance: 2.2, separation_margin: 1.1,
      model_version: 'letter_motor_cluster_v1',
    });

    const result = await backfill({ commit: true });

    expect(mockPredictLetterMotorState).toHaveBeenCalledTimes(1);
    const written = mockHistoryCreate.mock.calls[0][0];
    expect(written.state_code).toBe('LETTER_STATE_B');
    expect(written.milestone).toBe(MILESTONES[0].code);
    expect(written.coverage_n).toBe(14);
    expect(result.results[0].milestoneResults[0].status).toBe('recorded');
  });

  it('the script itself never supplies a state_code, cluster or display name', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    mockEvidenceFindAll.mockResolvedValue(evidenceRowsFor(FOURTEEN));
    mockPredictLetterMotorState.mockResolvedValue({
      status: 'ok', cluster_id: 0, state_code: 'LETTER_STATE_A', display_name: 'State A',
      nearest_distance: 1, second_nearest_distance: 2, separation_margin: 1,
      model_version: 'letter_motor_cluster_v1',
    });

    await backfill({ commit: true });

    // Every persisted label came out of the prediction, not the backfill.
    const written = mockHistoryCreate.mock.calls[0][0];
    expect(written.cluster_id).toBe(0);
    expect(written.state_code).toBe('LETTER_STATE_A');
    expect(written.model_version).toBe('letter_motor_cluster_v1');
  });

  it('OOD: an outside-reference-range observation records NO pattern and forces no A/B', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    mockEvidenceFindAll.mockResolvedValue(evidenceRowsFor(FOURTEEN));
    mockPredictLetterMotorState.mockResolvedValue({
      status: 'outside_reference_range',
      model_version: 'letter_motor_cluster_v1',
      ood: { reason: 'max_abs_z_exceeded' },
    });

    const result = await backfill({ commit: true });

    expect(mockHistoryCreate).not.toHaveBeenCalled();
    expect(result.results[0].milestoneResults[0].status).toBe('outside_reference_range');
  });

  it('the evidence row is still kept when the milestone is rejected as OOD', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(session({ key: 'only', passed: true, at: MASTERING_AT }));
    mockEvidenceFindAll.mockResolvedValue(evidenceRowsFor(FOURTEEN));
    mockPredictLetterMotorState.mockResolvedValue({
      status: 'outside_reference_range', model_version: 'letter_motor_cluster_v1', ood: null,
    });

    const result = await backfill({ commit: true });
    expect(result.totals.created).toBe(1);
  });

  it('milestones are not evaluated at all when this run added no evidence', async () => {
    mockEvidenceFindOne.mockResolvedValue({ id: 1 });
    await backfill({ commit: true });
    expect(mockEvidenceFindAll).not.toHaveBeenCalled();
    expect(mockPredictLetterMotorState).not.toHaveBeenCalled();
  });
});

// ─── Isolation ─────────────────────────────────────────────────────────────
describe('no adaptive, scoring, mastery or model logic is touched', () => {
  const fs = require('fs');
  const path = require('path');
  const sources = ['../scripts/backfillLetterMotorEvidence.js', '../scripts/auditLetterMotorBackfill.js']
    .map(p => fs.readFileSync(path.resolve(__dirname, p), 'utf8'))
    .join('\n');

  function codeOnly(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  it('never imports a threshold, scoring, sequencing or recommendation service', () => {
    const code = codeOnly(sources);
    expect(code).not.toMatch(/dynamicThresholdService|progressionThresholdResolver|motorScore|worksheetRecommendationService|persistentDifficulty|letterProgressionService/);
  });

  it('never computes a score — it only copies stored feature values', () => {
    const code = codeOnly(sources);
    expect(code).not.toMatch(/computeMotorScore|computeUnifiedShapeScore|normalizeLetterFeatures/);
  });

  it('the only model written to is the evidence table', () => {
    const code = codeOnly(sources);
    expect(code).toMatch(/LetterMotorMasteryEvidence\.create/);
    expect(code).not.toMatch(/LetterProgress\.(create|update|upsert|destroy)/);
    expect(code).not.toMatch(/LetterAttempt\.(create|update|upsert|destroy)/);
    expect(code).not.toMatch(/LetterMotorStateHistory\.(create|update|upsert|destroy)/);
  });

  it('delegates milestone/state creation to the service rather than writing history itself', () => {
    const code = codeOnly(sources);
    expect(code).toMatch(/checkAndTriggerMilestones/);
  });

  it('imports the live eligibility rule instead of restating it', () => {
    const code = codeOnly(sources);
    expect(code).toMatch(/validateEvidenceEligibility/);
    // The reasons must come from the service, not be re-derived here.
    expect(code).not.toMatch(/attempt_number !== 3/);
  });

  it('defaults to dry-run: writing requires an explicit --commit', () => {
    const code = codeOnly(sources);
    expect(code).toMatch(/commit = false/);
    expect(code).toMatch(/--commit/);
  });
});

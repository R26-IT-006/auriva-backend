'use strict';

// Feature 11B Phase 5 — letterMotorMasteryService.js verified in isolation.
// Only ../src/models and mlServiceClient are mocked (the two real
// DB/network boundaries), matching this project's established convention.

const mockLaFindOne  = jest.fn();
const mockLmeFindOne = jest.fn();
const mockLmeFindAll = jest.fn();
const mockLmeCreate  = jest.fn();
const mockLshFindOne = jest.fn();
const mockLshFindAll = jest.fn();
const mockLshCreate  = jest.fn();
const mockPredict    = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: { findOne: (...a) => mockLaFindOne(...a) },
  LetterMotorMasteryEvidence: {
    findOne: (...a) => mockLmeFindOne(...a),
    findAll: (...a) => mockLmeFindAll(...a),
    create:  (...a) => mockLmeCreate(...a),
  },
  LetterMotorStateHistory: {
    findOne: (...a) => mockLshFindOne(...a),
    findAll: (...a) => mockLshFindAll(...a),
    create:  (...a) => mockLshCreate(...a),
  },
}));

jest.mock('../src/services/mlServiceClient', () => ({
  predictLetterMotorState: (...a) => mockPredict(...a),
}));

const {
  validateEvidenceEligibility, onLetterMastered, checkAndTriggerMilestones,
  getLatestLetterMotorState, getLetterMotorStateHistory, getMasteryEvidenceTrend,
} = require('../src/services/letterMotorMasteryService');
const { MILESTONES, MILESTONE_UPPERCASE_STRAIGHT_14, MILESTONE_UPPERCASE_CURVED_17, MILESTONE_FULL_REFERENCE_20 } = require('../src/config/letterMotorMilestones');

const STUDENT_ID = 9;
const SESSION_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => jest.clearAllMocks());

// ─── Fixtures ───────────────────────────────────────────────────────────────

function eligibleAttemptRow(overrides = {}) {
  return {
    id: 501,
    student_id: STUDENT_ID,
    letter: 'l', case_type: 'lowercase',
    session_key: SESSION_KEY,
    attempt_number: 3,
    support_level: 'low',
    collection_mode: false,
    source_type: null,
    capture_status: 'complete',
    normalized_features: { smoothness_score: 72, dtw_distance: 10, speed_cv: 0.25 },
    feature_version: 'v1', template_version: 'v1', normalization_version: 'dtw_norm_v1',
    ...overrides,
  };
}

function evidenceRowFor(letter, caseType, i = 0, versionOverrides = {}) {
  return {
    id: i + 1, student_id: STUDENT_ID, letter, case_type: caseType,
    smoothness_score: 50 + i, dtw_distance: 10 + i * 0.5, speed_cv: 0.2 + i * 0.01,
    support_level: 'low',
    feature_version: 'v1', template_version: 'v1', normalization_version: 'dtw_norm_v1',
    ...versionOverrides,
  };
}

const FOURTEEN_SET = MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_STRAIGHT_14).requiredPairs;
const SEVENTEEN_SET = MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_CURVED_17).requiredPairs;
const TWENTY_SET = MILESTONES.find(m => m.code === MILESTONE_FULL_REFERENCE_20).requiredPairs;

function evidenceRowsFor(pairs) {
  return pairs.map((p, i) => evidenceRowFor(p.letter, p.caseType, i));
}

const PREDICTION_FIXTURE = {
  cluster_id: 0, state_code: 'LETTER_STATE_A', display_name: 'State A',
  model_version: 'letter_motor_cluster_v1',
  nearest_distance: 0.4, second_nearest_distance: 2.1, separation_margin: 1.7,
};

// ═══════════════════════════════════════════════════════════════════════════
// validateEvidenceEligibility (spec §9)
// ═══════════════════════════════════════════════════════════════════════════

describe('validateEvidenceEligibility', () => {
  it('accepts a fully eligible row', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow())).toEqual({ valid: true, reason: null });
  });

  it('rejects support_level other than low', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ support_level: 'high' })).valid).toBe(false);
    expect(validateEvidenceEligibility(eligibleAttemptRow({ support_level: null })).valid).toBe(false);
  });

  it('rejects collection_mode: true', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ collection_mode: true })).valid).toBe(false);
  });

  it('rejects a non-null source_type (e.g. any non-normal-learning row)', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ source_type: 'something_else' })).valid).toBe(false);
  });

  it('rejects capture_status other than complete', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ capture_status: 'incomplete' })).valid).toBe(false);
  });

  it('rejects a non-finite or missing smoothness_score', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ normalized_features: { smoothness_score: null, dtw_distance: 10, speed_cv: 0.2 } })).valid).toBe(false);
    expect(validateEvidenceEligibility(eligibleAttemptRow({ normalized_features: { smoothness_score: NaN, dtw_distance: 10, speed_cv: 0.2 } })).valid).toBe(false);
  });

  it('rejects a negative or non-finite dtw_distance', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ normalized_features: { smoothness_score: 70, dtw_distance: -1, speed_cv: 0.2 } })).valid).toBe(false);
    expect(validateEvidenceEligibility(eligibleAttemptRow({ normalized_features: { smoothness_score: 70, dtw_distance: null, speed_cv: 0.2 } })).valid).toBe(false);
  });

  it('rejects a negative or non-finite speed_cv', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ normalized_features: { smoothness_score: 70, dtw_distance: 10, speed_cv: -0.1 } })).valid).toBe(false);
  });

  it('rejects any null version field', () => {
    expect(validateEvidenceEligibility(eligibleAttemptRow({ feature_version: null })).valid).toBe(false);
    expect(validateEvidenceEligibility(eligibleAttemptRow({ template_version: null })).valid).toBe(false);
    expect(validateEvidenceEligibility(eligibleAttemptRow({ normalization_version: null })).valid).toBe(false);
  });

  it('never reads motor_score/best_score/threshold/passed', () => {
    // A row where those legacy fields are wrong/missing must not affect eligibility.
    const row = eligibleAttemptRow({ motor_score: null, best_score: null, threshold: null, passed: undefined });
    expect(validateEvidenceEligibility(row).valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// onLetterMastered (spec §8/§9/§10/§11)
// ═══════════════════════════════════════════════════════════════════════════

describe('onLetterMastered', () => {
  const params = { studentId: STUDENT_ID, letter: 'l', caseType: 'lowercase', sessionKey: SESSION_KEY };

  it('Scenario — non-reference letter never becomes evidence', async () => {
    const res = await onLetterMastered({ ...params, letter: 'd' }); // 'd' is lowercase-mixed, not a reference letter
    expect(res.status).toBe('not_reference_letter');
    expect(mockLaFindOne).not.toHaveBeenCalled();
    expect(mockLmeCreate).not.toHaveBeenCalled();
  });

  it('Scenario — attempt-3 row not found', async () => {
    mockLmeFindOne.mockResolvedValueOnce(null);
    mockLaFindOne.mockResolvedValueOnce(null);
    const res = await onLetterMastered(params);
    expect(res.status).toBe('attempt_row_not_found');
    expect(mockLmeCreate).not.toHaveBeenCalled();
  });

  it('Scenario — ineligible attempt-3 row (e.g. support_level not low) is not frozen as evidence', async () => {
    mockLmeFindOne.mockResolvedValueOnce(null);
    mockLaFindOne.mockResolvedValueOnce(eligibleAttemptRow({ support_level: 'medium' }));
    const res = await onLetterMastered(params);
    expect(res.status).toBe('not_eligible');
    expect(mockLmeCreate).not.toHaveBeenCalled();
  });

  it('Scenario — eligible row freezes evidence with support_level "low" and the exact source features', async () => {
    mockLmeFindOne.mockResolvedValueOnce(null);
    mockLaFindOne.mockResolvedValueOnce(eligibleAttemptRow());
    mockLmeCreate.mockResolvedValueOnce({ id: 1 });
    mockLmeFindAll.mockResolvedValueOnce([]); // milestone check sees no evidence yet

    const res = await onLetterMastered(params);
    expect(res.status).toBe('evidence_created');
    const createArgs = mockLmeCreate.mock.calls[0][0];
    expect(createArgs.letter).toBe('l');
    expect(createArgs.case_type).toBe('lowercase');
    expect(createArgs.letter_attempt_id).toBe(501);
    expect(createArgs.support_level).toBe('low');
    expect(createArgs.smoothness_score).toBe(72);
    expect(createArgs.dtw_distance).toBe(10);
    expect(createArgs.speed_cv).toBe(0.25);
    expect(createArgs.feature_version).toBe('v1');
  });

  it('Scenario — evidence created once: a letter that already has evidence is never re-frozen (idempotent)', async () => {
    const existing = { id: 5, letter: 'l', case_type: 'lowercase' };
    mockLmeFindOne.mockResolvedValueOnce(existing);
    mockLmeFindAll.mockResolvedValueOnce([]); // milestone check still runs
    const res = await onLetterMastered(params);
    expect(res.status).toBe('evidence_already_exists');
    expect(res.evidence).toBe(existing);
    expect(mockLaFindOne).not.toHaveBeenCalled();
    expect(mockLmeCreate).not.toHaveBeenCalled();
  });

  it('Scenario — race condition on create resolves to evidence_already_exists via re-fetch', async () => {
    mockLmeFindOne.mockResolvedValueOnce(null);
    mockLaFindOne.mockResolvedValueOnce(eligibleAttemptRow());
    const raceErr = new Error('duplicate key');
    raceErr.name = 'SequelizeUniqueConstraintError';
    mockLmeCreate.mockRejectedValueOnce(raceErr);
    const raceWinner = { id: 9, letter: 'l', case_type: 'lowercase' };
    mockLmeFindOne.mockResolvedValueOnce(raceWinner);
    mockLmeFindAll.mockResolvedValueOnce([]);

    const res = await onLetterMastered(params);
    expect(res.status).toBe('evidence_already_exists');
    expect(res.evidence).toBe(raceWinner);
  });

  it('Scenario — unexpected DB error returns save_failed, never throws', async () => {
    mockLmeFindOne.mockRejectedValueOnce(new Error('connection reset'));
    const res = await onLetterMastered(params);
    expect(res.status).toBe('save_failed');
  });

  it('Scenario — invalid input rejected before any query', async () => {
    const res = await onLetterMastered({ studentId: -1, letter: 'l', caseType: 'lowercase', sessionKey: SESSION_KEY });
    expect(res.status).toBe('invalid_input');
    expect(mockLmeFindOne).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkAndTriggerMilestones (spec §12-§19)
// ═══════════════════════════════════════════════════════════════════════════

describe('checkAndTriggerMilestones', () => {
  const params = { studentId: STUDENT_ID };

  it('Scenario — 3/20 (lowercase straight only): all milestones not_yet_eligible, no ML call, nothing persisted', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor([
      { letter: 'i', caseType: 'lowercase' }, { letter: 'l', caseType: 'lowercase' }, { letter: 't', caseType: 'lowercase' },
    ]));
    mockLshFindOne.mockResolvedValue(null);
    const results = await checkAndTriggerMilestones(params);
    expect(results.every(r => r.status === 'not_yet_eligible')).toBe(true);
    expect(mockPredict).not.toHaveBeenCalled();
    expect(mockLshCreate).not.toHaveBeenCalled();
  });

  it('Scenario — 7/20 (all lowercase straight+curved): still not_yet_eligible for every milestone', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor([
      { letter: 'i', caseType: 'lowercase' }, { letter: 'l', caseType: 'lowercase' }, { letter: 't', caseType: 'lowercase' },
      { letter: 'a', caseType: 'lowercase' }, { letter: 'c', caseType: 'lowercase' }, { letter: 'o', caseType: 'lowercase' }, { letter: 's', caseType: 'lowercase' },
    ]));
    mockLshFindOne.mockResolvedValue(null);
    const results = await checkAndTriggerMilestones(params);
    expect(results.every(r => r.status === 'not_yet_eligible')).toBe(true);
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('Scenario — 10/20 (all lowercase): still not_yet_eligible for every milestone', async () => {
    const lowercaseTen = FOURTEEN_SET.filter(p => p.caseType === 'lowercase');
    expect(lowercaseTen.length).toBe(10);
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(lowercaseTen));
    mockLshFindOne.mockResolvedValue(null);
    const results = await checkAndTriggerMilestones(params);
    expect(results.every(r => r.status === 'not_yet_eligible')).toBe(true);
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('Scenario — exact 14/20 triggers ONLY the first milestone', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(FOURTEEN_SET));
    mockLshFindOne.mockResolvedValue(null);
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    mockLshCreate.mockResolvedValueOnce({ id: 1, ...PREDICTION_FIXTURE });

    const results = await checkAndTriggerMilestones(params);
    const byCode = Object.fromEntries(results.map(r => [r.milestone, r.status]));
    expect(byCode[MILESTONE_UPPERCASE_STRAIGHT_14]).toBe('recorded');
    expect(byCode[MILESTONE_UPPERCASE_CURVED_17]).toBe('not_yet_eligible');
    expect(byCode[MILESTONE_FULL_REFERENCE_20]).toBe('not_yet_eligible');
    expect(mockPredict).toHaveBeenCalledTimes(1);

    const createArgs = mockLshCreate.mock.calls[0][0];
    expect(createArgs.milestone).toBe(MILESTONE_UPPERCASE_STRAIGHT_14);
    expect(createArgs.coverage_n).toBe(14);
  });

  it('Scenario — 14 evidence rows that are NOT the exact required set never qualify (wrong composition)', async () => {
    // 14 rows, but substituting one uppercase-curved letter (C) for one of
    // the required uppercase-straight letters (H) — same COUNT, wrong SET.
    const wrongFourteen = FOURTEEN_SET.filter(p => !(p.letter === 'H' && p.caseType === 'uppercase'))
      .concat([{ letter: 'C', caseType: 'uppercase' }]);
    expect(wrongFourteen.length).toBe(14);
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(wrongFourteen));
    mockLshFindOne.mockResolvedValue(null);

    const results = await checkAndTriggerMilestones(params);
    expect(results.every(r => r.status === 'not_yet_eligible')).toBe(true);
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('Scenario — exact 17/20 updates (records the 17 milestone; 14 already recorded, 20 not yet)', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(SEVENTEEN_SET));
    mockLshFindOne.mockImplementation(async ({ where }) => {
      if (where.milestone === MILESTONE_UPPERCASE_STRAIGHT_14) return { id: 1, milestone: MILESTONE_UPPERCASE_STRAIGHT_14 };
      return null;
    });
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    mockLshCreate.mockResolvedValueOnce({ id: 2, ...PREDICTION_FIXTURE });

    const results = await checkAndTriggerMilestones(params);
    const byCode = Object.fromEntries(results.map(r => [r.milestone, r.status]));
    expect(byCode[MILESTONE_UPPERCASE_STRAIGHT_14]).toBe('already_recorded');
    expect(byCode[MILESTONE_UPPERCASE_CURVED_17]).toBe('recorded');
    expect(byCode[MILESTONE_FULL_REFERENCE_20]).toBe('not_yet_eligible');
    expect(mockPredict).toHaveBeenCalledTimes(1);
  });

  it('Scenario — exact 20/20 updates (records the 20 milestone; 14/17 already recorded)', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(TWENTY_SET));
    mockLshFindOne.mockImplementation(async ({ where }) =>
      where.milestone === MILESTONE_FULL_REFERENCE_20 ? null : { id: 1, milestone: where.milestone }
    );
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    mockLshCreate.mockResolvedValueOnce({ id: 3, ...PREDICTION_FIXTURE });

    const results = await checkAndTriggerMilestones(params);
    const byCode = Object.fromEntries(results.map(r => [r.milestone, r.status]));
    expect(byCode[MILESTONE_UPPERCASE_STRAIGHT_14]).toBe('already_recorded');
    expect(byCode[MILESTONE_UPPERCASE_CURVED_17]).toBe('already_recorded');
    expect(byCode[MILESTONE_FULL_REFERENCE_20]).toBe('recorded');
  });

  it('Scenario — out-of-order coverage (all 20 appear at once, nothing recorded yet) records all 3 milestones', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(TWENTY_SET));
    mockLshFindOne.mockResolvedValue(null);
    mockPredict.mockResolvedValue(PREDICTION_FIXTURE);
    mockLshCreate.mockResolvedValue({ id: 1, ...PREDICTION_FIXTURE });

    const results = await checkAndTriggerMilestones(params);
    expect(results.every(r => r.status === 'recorded')).toBe(true);
    expect(mockPredict).toHaveBeenCalledTimes(3);
    expect(mockLshCreate).toHaveBeenCalledTimes(3);
  });

  it('Scenario — milestone finalization is idempotent: an already-recorded milestone is never re-predicted', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(FOURTEEN_SET));
    mockLshFindOne.mockResolvedValue({ id: 1, milestone: MILESTONE_UPPERCASE_STRAIGHT_14 });
    const results = await checkAndTriggerMilestones(params);
    expect(results.every(r => r.status === 'already_recorded')).toBe(true);
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('Scenario — version mismatch across the 14-set evidence blocks that milestone, never averages', async () => {
    const rows = evidenceRowsFor(FOURTEEN_SET);
    rows[0] = { ...rows[0], feature_version: 'v2' };
    mockLmeFindAll.mockResolvedValueOnce(rows);
    mockLshFindOne.mockResolvedValue(null);
    const results = await checkAndTriggerMilestones(params);
    const first = results.find(r => r.milestone === MILESTONE_UPPERCASE_STRAIGHT_14);
    expect(first.status).toBe('version_mismatch');
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('Scenario — ML service failure never fabricates a state; nothing persisted', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(FOURTEEN_SET));
    mockLshFindOne.mockResolvedValue(null);
    mockPredict.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const results = await checkAndTriggerMilestones(params);
    const first = results.find(r => r.milestone === MILESTONE_UPPERCASE_STRAIGHT_14);
    expect(first.status).toBe('ml_service_unavailable');
    expect(mockLshCreate).not.toHaveBeenCalled();
  });

  it('Scenario — a unique-constraint race on state-history create resolves to already_recorded via re-fetch', async () => {
    mockLmeFindAll.mockResolvedValueOnce(evidenceRowsFor(FOURTEEN_SET));
    mockLshFindOne.mockResolvedValueOnce(null); // first idempotency check
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    const raceErr = new Error('duplicate key');
    raceErr.name = 'SequelizeUniqueConstraintError';
    mockLshCreate.mockRejectedValueOnce(raceErr);
    const raceWinner = { id: 77, milestone: MILESTONE_UPPERCASE_STRAIGHT_14 };
    mockLshFindOne.mockResolvedValueOnce(raceWinner);

    const results = await checkAndTriggerMilestones(params);
    const first = results.find(r => r.milestone === MILESTONE_UPPERCASE_STRAIGHT_14);
    expect(first.status).toBe('already_recorded');
    expect(first.result).toBe(raceWinner);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Read-only endpoints — never call ML (spec §24)
// ═══════════════════════════════════════════════════════════════════════════

describe('getLatestLetterMotorState / getLetterMotorStateHistory / getMasteryEvidenceTrend', () => {
  it('getLatestLetterMotorState returns found, never touches predict', async () => {
    mockLshFindOne.mockResolvedValueOnce({ id: 1 });
    const res = await getLatestLetterMotorState({ studentId: STUDENT_ID });
    expect(res.status).toBe('found');
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('getLatestLetterMotorState returns not_found when nothing exists', async () => {
    mockLshFindOne.mockResolvedValueOnce(null);
    const res = await getLatestLetterMotorState({ studentId: STUDENT_ID });
    expect(res.status).toBe('not_found');
  });

  it('getLetterMotorStateHistory returns chronological results, never touches predict', async () => {
    mockLshFindAll.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const res = await getLetterMotorStateHistory({ studentId: STUDENT_ID });
    expect(res.status).toBe('found');
    expect(res.results.length).toBe(2);
    expect(mockPredict).not.toHaveBeenCalled();
    expect(mockLshFindAll.mock.calls[0][0].order).toEqual([['observed_at', 'ASC'], ['id', 'ASC']]);
  });

  it('getMasteryEvidenceTrend computes descriptive means only, never touches predict or creates a state row', async () => {
    mockLmeFindAll.mockResolvedValueOnce([
      { smoothness_score: 60, dtw_distance: 10, speed_cv: 0.2 },
      { smoothness_score: 80, dtw_distance: 20, speed_cv: 0.4 },
    ]);
    const res = await getMasteryEvidenceTrend({ studentId: STUDENT_ID });
    expect(res.status).toBe('found');
    expect(res.coverageN).toBe(2);
    expect(res.meanSmoothness).toBe(70);
    expect(res.meanDtw).toBe(15);
    expect(res.meanSpeedCv).toBeCloseTo(0.3, 10);
    expect(mockPredict).not.toHaveBeenCalled();
    expect(mockLshCreate).not.toHaveBeenCalled();
  });
});

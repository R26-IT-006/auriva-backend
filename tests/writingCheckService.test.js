'use strict';

// Writing Check — the dedicated teacher-initiated route for
// letter_motor_cluster_v1. Verified in isolation: only ../src/models and
// mlServiceClient are mocked, matching this project's established convention.

const mockLaFindAll = jest.fn();
const mockPcFindOne = jest.fn();
const mockPcFindAll = jest.fn();
const mockPcFindByPk = jest.fn();
const mockPcCreate = jest.fn();
const mockHistCreate = jest.fn();
const mockHistFindAll = jest.fn();
const mockEvalCreate = jest.fn();
const mockEvalFindOne = jest.fn();
const mockEvalFindAll = jest.fn();
const mockPredict = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: { findAll: (...a) => mockLaFindAll(...a) },
  LetterMotorPatternCheck: {
    findOne: (...a) => mockPcFindOne(...a),
    findAll: (...a) => mockPcFindAll(...a),
    findByPk: (...a) => mockPcFindByPk(...a),
    create: (...a) => mockPcCreate(...a),
  },
  LetterMotorStateHistory: {
    create: (...a) => mockHistCreate(...a),
    findAll: (...a) => mockHistFindAll(...a),
  },
  LetterMotorStateEvaluation: {
    create: (...a) => mockEvalCreate(...a),
    findOne: (...a) => mockEvalFindOne(...a),
    findAll: (...a) => mockEvalFindAll(...a),
  },
}));

jest.mock('../src/services/mlServiceClient', () => ({
  predictLetterMotorState: (...a) => mockPredict(...a),
}));

const svc = require('../src/services/letterMotorPatternCheckService');
const { LETTER_MOTOR_REFERENCE_LETTERS } = require('../src/config/letterMotorReferenceLetters');

const SID = 44;
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function capture(letter, caseType, feats = {}) {
  return {
    id: Math.random(), student_id: SID, letter, case_type: caseType,
    collection_session_id: SESSION, attempt_number: 3, collection_mode: true,
    capture_status: 'complete',
    feature_version: 'v1', template_version: 'v1', normalization_version: 'dtw_norm_v1',
    created_at: new Date('2026-08-26T10:00:00.000Z'),
    normalized_features: { smoothness_score: 88.05, dtw_distance: 17.76, speed_cv: 0.834, ...feats },
  };
}
function allTwenty(feats) {
  return LETTER_MOTOR_REFERENCE_LETTERS.map(p => capture(p.letter, p.caseType, feats));
}
function checkRow(over = {}) {
  return {
    id: 1, student_id: SID, collection_session_id: SESSION, status: 'in_progress',
    started_at: new Date(), letters_captured: 0,
    update: jest.fn().mockResolvedValue(undefined), ...over,
  };
}
const ASSIGNED = {
  status: 'assigned', cluster_id: 1, state_code: 'LETTER_STATE_B',
  display_name: 'Letter Motor State B', model_version: 'letter_motor_cluster_v1',
  nearest_distance: 0.5, second_nearest_distance: 2.7, separation_margin: 2.2, ood: { reason: null },
};
const OOD = {
  status: 'outside_reference_range', cluster_id: null, state_code: null, display_name: null,
  model_version: 'letter_motor_cluster_v1',
  ood: { reason: 'dtw_distance_outside_reference_range', outside_features: ['dtw_distance'],
         triggered_by: ['feature:dtw_distance'] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPcFindOne.mockResolvedValue(null);
  mockPcFindAll.mockResolvedValue([]);
  mockEvalFindAll.mockResolvedValue([]);
  mockHistFindAll.mockResolvedValue([]);
  mockPcCreate.mockImplementation(async (p) => checkRow(p));
  mockEvalCreate.mockImplementation(async (p) => ({ id: 10, ...p }));
  mockHistCreate.mockImplementation(async (p) => ({ id: 20, ...p }));
});

// ── Protocol ──────────────────────────────────────────────────────────────

describe('protocol', () => {
  it('requires exactly the 20 reference pairs the model was trained on', () => {
    expect(svc.REQUIRED_COUNT).toBe(20);
    const got = svc.REQUIRED_PAIRS.map(p => `${p.letter}|${p.caseType}`).sort();
    const want = LETTER_MOTOR_REFERENCE_LETTERS.map(p => `${p.letter}|${p.caseType}`).sort();
    expect(got).toEqual(want);
  });

  it('accepts only collection-mode attempt-3 complete captures', () => {
    expect(svc.isUsableCheckCapture(capture('a', 'lowercase'))).toBe(true);
    expect(svc.isUsableCheckCapture({ ...capture('a', 'lowercase'), attempt_number: 2 })).toBe(false);
    expect(svc.isUsableCheckCapture({ ...capture('a', 'lowercase'), collection_mode: false })).toBe(false);
    expect(svc.isUsableCheckCapture({ ...capture('a', 'lowercase'), capture_status: 'incomplete' })).toBe(false);
    expect(svc.isUsableCheckCapture({ ...capture('a', 'lowercase'), normalized_features: {} })).toBe(false);
  });
});

// ── Session lifecycle / resume ────────────────────────────────────────────

describe('session lifecycle', () => {
  it('starts a new check when none is unfinished', async () => {
    mockLaFindAll.mockResolvedValue([]);
    const r = await svc.startOrResumePatternCheck({ studentId: SID, collectionSessionId: SESSION });
    expect(r.status).toBe('started');
    expect(r.remaining).toHaveLength(20);
  });

  it('resumes an unfinished check at the next uncaptured pair', async () => {
    mockPcFindOne.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty().slice(0, 8));
    const r = await svc.startOrResumePatternCheck({ studentId: SID, collectionSessionId: 'other' });
    expect(r.status).toBe('resumed');
    expect(r.remaining).toHaveLength(12);
    expect(r.check.id).toBe(1);
  });

  it('a new check never resumes a COMPLETED one — only in_progress is looked up', async () => {
    mockLaFindAll.mockResolvedValue([]);
    await svc.startOrResumePatternCheck({ studentId: SID, collectionSessionId: SESSION });
    expect(mockPcFindOne.mock.calls[0][0].where.status).toBe('in_progress');
  });

  it('scopes captures to the check\'s own collection session', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue([]);
    await svc.getPatternCheckProgress({ checkId: 1 });
    const where = mockLaFindAll.mock.calls[0][0].where;
    expect(where.collection_session_id).toBe(SESSION);
    expect(where.collection_mode).toBe(true);
    expect(where.attempt_number).toBe(3);
  });
});

// ── Completion requirement ────────────────────────────────────────────────

describe('completion requirement', () => {
  it('19/20 does NOT evaluate and never calls the model', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty().slice(0, 19));
    const r = await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(r.status).toBe('incomplete');
    expect(r.missing).toHaveLength(1);
    expect(mockPredict).not.toHaveBeenCalled();
    expect(mockEvalCreate).not.toHaveBeenCalled();
    expect(mockHistCreate).not.toHaveBeenCalled();
  });

  it('a duplicate capture of one pair does not count as two', async () => {
    const rows = allTwenty().slice(0, 19);
    rows.push(capture(rows[0].letter, rows[0].case_type)); // repeat, not a new pair
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(rows);
    const r = await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(r.status).toBe('incomplete');
    expect(mockPredict).not.toHaveBeenCalled();
  });
});

// ── Aggregation ───────────────────────────────────────────────────────────

describe('aggregation', () => {
  it('sends exactly the three features, in the model\'s own order', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(ASSIGNED);
    await svc.completeAndEvaluatePatternCheck({ checkId: 1 });

    const sent = mockPredict.mock.calls[0][0];
    expect(Object.keys(sent).sort()).toEqual(['dtwDistance', 'smoothnessScore', 'speedCv']);
    expect(sent.smoothnessScore).toBeCloseTo(88.05, 10);
    expect(sent.dtwDistance).toBeCloseTo(17.76, 10);
    expect(sent.speedCv).toBeCloseTo(0.834, 10);
  });

  it('computes the true mean across the 20 pairs', async () => {
    const rows = allTwenty();
    rows[0].normalized_features = { smoothness_score: 68.05, dtw_distance: 17.76, speed_cv: 0.834 };
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(rows);
    mockPredict.mockResolvedValue(ASSIGNED);
    await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    // 19 rows at 88.05 + 1 at 68.05
    expect(mockPredict.mock.calls[0][0].smoothnessScore).toBeCloseTo((88.05 * 19 + 68.05) / 20, 10);
  });

  it('never reads motor_score / best_score / threshold / support_level', () => {
    const src = require('fs').readFileSync(
      require.resolve('../src/services/letterMotorPatternCheckService.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function completeAndEvaluatePatternCheck'));
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['motor_score', 'best_score', 'threshold', 'support_level']) {
      expect(code).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});

// ── Model outcomes ────────────────────────────────────────────────────────

describe('model outcomes', () => {
  it('an assigned pattern writes BOTH an evaluation and a pattern row', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(ASSIGNED);
    const r = await svc.completeAndEvaluatePatternCheck({ checkId: 1 });

    expect(r.status).toBe('assigned');
    expect(mockEvalCreate).toHaveBeenCalledTimes(1);
    expect(mockHistCreate).toHaveBeenCalledTimes(1);
    expect(mockEvalCreate.mock.calls[0][0].evaluation_status).toBe('assigned');
    expect(mockHistCreate.mock.calls[0][0].state_code).toBe('LETTER_STATE_B');
  });

  it('OOD writes an evaluation and NO pattern row — nothing is fabricated', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(OOD);
    const r = await svc.completeAndEvaluatePatternCheck({ checkId: 1 });

    expect(r.status).toBe('outside_reference_range');
    expect(mockHistCreate).not.toHaveBeenCalled();
    const payload = mockEvalCreate.mock.calls[0][0];
    expect(payload.evaluation_status).toBe('outside_reference_range');
    expect(payload.inside_reference_range).toBe(false);
    expect(payload.ood_reason).toBe('dtw_distance_outside_reference_range');
    for (const f of ['cluster_id', 'state_code', 'display_name']) {
      expect(payload).not.toHaveProperty(f);
    }
  });

  it('an ML failure persists nothing and stays retryable', async () => {
    const check = checkRow();
    mockPcFindByPk.mockResolvedValue(check);
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await svc.completeAndEvaluatePatternCheck({ checkId: 1 });

    expect(r.status).toBe('ml_service_unavailable');
    expect(mockEvalCreate).not.toHaveBeenCalled();
    expect(mockHistCreate).not.toHaveBeenCalled();
    expect(check.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'evaluation_failed' }));
  });

  it('preserves the model version the prediction actually came from', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(ASSIGNED);
    await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(mockEvalCreate.mock.calls[0][0].model_version).toBe('letter_motor_cluster_v1');
  });

  it('an already-evaluated check is never re-scored', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow({ status: 'evaluated' }));
    mockEvalFindOne.mockResolvedValue({ id: 10, evaluation_status: 'assigned' });
    const r = await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(r.status).toBe('already_evaluated');
    expect(mockPredict).not.toHaveBeenCalled();
  });
});

// ── Persistence identity ──────────────────────────────────────────────────

describe('persistence identity', () => {
  it('stamps pattern_check_id on both result rows', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(ASSIGNED);
    await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(mockEvalCreate.mock.calls[0][0].pattern_check_id).toBe(1);
    expect(mockHistCreate.mock.calls[0][0].pattern_check_id).toBe(1);
  });

  it('uses its own milestone sentinel, never a legacy 14/17/20 code', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(ASSIGNED);
    await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(mockEvalCreate.mock.calls[0][0].milestone).toBe('WRITING_CHECK');
    expect(svc.WRITING_CHECK_MILESTONE).toBe('WRITING_CHECK');
    expect(['UPPERCASE_STRAIGHT_14', 'UPPERCASE_CURVED_17', 'FULL_REFERENCE_20'])
      .not.toContain(svc.WRITING_CHECK_MILESTONE);
  });

  it('observed_at is a real recorded capture timestamp, never Date.now()', async () => {
    mockPcFindByPk.mockResolvedValue(checkRow());
    mockLaFindAll.mockResolvedValue(allTwenty());
    mockPredict.mockResolvedValue(ASSIGNED);
    await svc.completeAndEvaluatePatternCheck({ checkId: 1 });
    expect(mockEvalCreate.mock.calls[0][0].observed_at)
      .toEqual(new Date('2026-08-26T10:00:00.000Z'));
  });
});

// ── Isolation ─────────────────────────────────────────────────────────────

describe('isolation from mastery / progression / adaptation', () => {
  const src = require('fs').readFileSync(
    require.resolve('../src/services/letterMotorPatternCheckService.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('never touches LetterProgress, mastered_at or blocked_attempts', () => {
    expect(code).not.toMatch(/LetterProgress/);
    expect(code).not.toMatch(/mastered_at/);
    expect(code).not.toMatch(/blocked_attempts/);
  });

  it('never calls a threshold, Motor Score, adaptive or recommendation service', () => {
    for (const forbidden of [
      'dynamicThresholdService', 'adaptiveSupportService', 'progressionThresholdResolver',
      'persistentDifficultyService', 'worksheetRecommendationService', 'computeMotorScore',
      'letterMotorMasteryService', 'repetitionRecommendationService',
    ]) {
      expect(code).not.toMatch(new RegExp(forbidden));
    }
  });

  it('never writes a LetterAttempt — it only reads captures', () => {
    expect(code).not.toMatch(/LetterAttempt\.(create|update|destroy|bulkCreate)/);
  });

  it('reads only collection_mode = true rows, which every normal query excludes', () => {
    expect(code).toMatch(/collection_mode: true/);
    expect(code).not.toMatch(/collection_mode: false/);
  });
});

// ── History ───────────────────────────────────────────────────────────────

describe('teacher history', () => {
  it('returns checks newest first with their outcome, and no cluster id', async () => {
    mockPcFindAll.mockResolvedValue([
      { id: 2, student_id: SID, status: 'evaluated', started_at: new Date('2026-10-15'),
        completed_at: new Date('2026-10-15'), letters_captured: 20, model_version: 'letter_motor_cluster_v1' },
      { id: 1, student_id: SID, status: 'evaluated', started_at: new Date('2026-08-26'),
        completed_at: new Date('2026-08-26'), letters_captured: 20, model_version: 'letter_motor_cluster_v1' },
    ]);
    mockEvalFindAll.mockResolvedValue([
      { pattern_check_id: 2, evaluation_status: 'outside_reference_range', observed_at: new Date('2026-10-15'), ood_reason: 'dtw_distance_outside_reference_range' },
      { pattern_check_id: 1, evaluation_status: 'assigned', observed_at: new Date('2026-08-26'), ood_reason: null },
    ]);
    mockHistFindAll.mockResolvedValue([{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' }]);

    const r = await svc.getPatternCheckHistory({ studentId: SID });
    expect(r.status).toBe('found');
    expect(r.checks).toHaveLength(2);
    expect(r.checks[0].evaluation_status).toBe('outside_reference_range');
    expect(r.checks[0].state_code).toBeNull();
    expect(r.checks[1].state_code).toBe('LETTER_STATE_A');
    for (const c of r.checks) expect(c).not.toHaveProperty('cluster_id');
  });

  it('repeated checks each keep their own identity', async () => {
    mockPcFindAll.mockResolvedValue([
      { id: 3, student_id: SID, status: 'evaluated', started_at: new Date('2026-12-12'), letters_captured: 20 },
      { id: 2, student_id: SID, status: 'evaluated', started_at: new Date('2026-10-15'), letters_captured: 20 },
      { id: 1, student_id: SID, status: 'evaluated', started_at: new Date('2026-08-26'), letters_captured: 20 },
    ]);
    const r = await svc.getPatternCheckHistory({ studentId: SID });
    expect(r.checks.map(c => c.id)).toEqual([3, 2, 1]);
  });
});

'use strict';

// Feature 11B Phase 4 — letterMotorReassessmentService.js verified in
// isolation. Only ../src/models and mlServiceClient are mocked (the two
// real DB/network-touching boundaries) — featureNormalization.js/
// motorScore.js run for real in the save-path tests, matching this
// project's established "mock only the DB" convention
// (collectionModeIsolationRegression.test.js, feature9EndToEndOrchestration.test.js).

const mockLaCreate  = jest.fn();
const mockLaFindAll = jest.fn();
const mockLmrFindOne = jest.fn();
const mockLmrCreate  = jest.fn();
const mockLmrFindAll = jest.fn();
const mockPredict    = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    create:   (...a) => mockLaCreate(...a),
    findAll:  (...a) => mockLaFindAll(...a),
  },
  LetterMotorReassessment: {
    findOne:  (...a) => mockLmrFindOne(...a),
    create:   (...a) => mockLmrCreate(...a),
    findAll:  (...a) => mockLmrFindAll(...a),
  },
}));

jest.mock('../src/services/mlServiceClient', () => ({
  predictLetterMotorState: (...a) => mockPredict(...a),
}));

const {
  saveReassessmentAttempt, finalizeReassessment, getLatestReassessment, getReassessmentHistory,
  selectMostRecentPerLetter, SOURCE_TYPE_REASSESSMENT, REASSESSMENT_ATTEMPT_NUMBER,
} = require('../src/services/letterMotorReassessmentService');
const { getRequiredLetterPairs } = require('../src/config/letterMotorReassessmentLetters');

const STUDENT_ID = 42;
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function fixtureRow({ letter, caseType, id, createdAtMs = 1000, overrides = {} }) {
  return {
    id,
    student_id: STUDENT_ID,
    letter, case_type: caseType,
    session_key: SESSION_ID,
    attempt_number: REASSESSMENT_ATTEMPT_NUMBER,
    collection_mode: false,
    capture_status: 'complete',
    support_level: 'low',
    source_type: SOURCE_TYPE_REASSESSMENT,
    created_at: new Date(createdAtMs),
    normalized_features: { smoothness_score: 70, dtw_distance: 12, speed_cv: 0.3 },
    feature_version: 'fv1', template_version: 'tv1', normalization_version: 'nv1',
    ...overrides,
  };
}

// Exactly 20 rows, one per required pair, deterministic feature values so
// the aggregation test can compute an exact expected mean.
function fullFixtureSet({ smoothnessBase = 50, dtwBase = 10, speedCvBase = 0.2, versions = {} } = {}) {
  const pairs = getRequiredLetterPairs();
  return pairs.map((p, i) => fixtureRow({
    letter: p.letter, caseType: p.caseType, id: i + 1, createdAtMs: 1000 + i,
    overrides: {
      normalized_features: {
        smoothness_score: smoothnessBase + i,
        dtw_distance: dtwBase + i * 0.5,
        speed_cv: speedCvBase + i * 0.01,
      },
      feature_version: versions.feature_version ?? 'fv1',
      template_version: versions.template_version ?? 'tv1',
      normalization_version: versions.normalization_version ?? 'nv1',
    },
  }));
}

function average(values) { return values.reduce((s, v) => s + v, 0) / values.length; }

const PREDICTION_FIXTURE = {
  cluster_id: 1, state_code: 'LETTER_STATE_B', display_name: 'State B',
  model_version: 'letter_motor_cluster_v1',
  nearest_distance: 0.5, second_nearest_distance: 1.8, separation_margin: 1.3,
};

// ═══════════════════════════════════════════════════════════════════════════
// saveReassessmentAttempt
// ═══════════════════════════════════════════════════════════════════════════

describe('saveReassessmentAttempt', () => {
  const baseParams = {
    studentId: STUDENT_ID, letter: 'A', caseType: 'uppercase',
    reassessmentSessionId: SESSION_ID, supportLevel: 'low',
    features: { smoothness: 0.1, dtw_distance: 5, completionTime: 1000, pauseCount: 0, strokeCount: 1 },
    strokes: [{ stroke_id: 0, points: [{ x: 0, y: 0, t: 0 }, { x: 10, y: 5, t: 100 }] }],
    meta: {},
  };

  it('saves a low-support, required-letter attempt with the correct narrow shape', async () => {
    mockLaCreate.mockResolvedValueOnce({ id: 501, letter: 'A', case_type: 'uppercase', session_key: SESSION_ID });
    const res = await saveReassessmentAttempt(baseParams);
    expect(res.status).toBe('saved');
    expect(mockLaCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockLaCreate.mock.calls[0][0];
    expect(createArgs.source_type).toBe('letter_motor_reassessment');
    expect(createArgs.collection_mode).toBe(false);
    expect(createArgs.attempt_number).toBe(1);
    expect(createArgs.support_level).toBe('low');
    expect(createArgs.session_key).toBe(SESSION_ID);
    expect(createArgs.threshold_passed).toBeNull();
    expect(createArgs.best_score).toBeNull();
  });

  it.each(['high', 'medium', null, undefined, 'LOW', 'bogus'])(
    'rejects support_level=%p — never trusts the frontend alone',
    async (bad) => {
      const res = await saveReassessmentAttempt({ ...baseParams, supportLevel: bad });
      expect(res.status).toBe('invalid_support_level');
      expect(mockLaCreate).not.toHaveBeenCalled();
    }
  );

  it('rejects a letter/case not in the 20-letter reassessment set', async () => {
    const res = await saveReassessmentAttempt({ ...baseParams, letter: 'Z', caseType: 'uppercase' });
    expect(res.status).toBe('not_required_letter');
    expect(mockLaCreate).not.toHaveBeenCalled();
  });

  it('rejects a valid letter in the wrong case (A is only required as uppercase)', async () => {
    const res = await saveReassessmentAttempt({ ...baseParams, letter: 'A', caseType: 'lowercase' });
    expect(res.status).toBe('not_required_letter');
  });

  it('rejects an invalid studentId', async () => {
    const res = await saveReassessmentAttempt({ ...baseParams, studentId: -1 });
    expect(res.status).toBe('invalid_input');
    expect(mockLaCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID reassessmentSessionId', async () => {
    const res = await saveReassessmentAttempt({ ...baseParams, reassessmentSessionId: 'not-a-uuid' });
    expect(res.status).toBe('invalid_input');
    expect(mockLaCreate).not.toHaveBeenCalled();
  });

  it('rejects an invalid case_type', async () => {
    const res = await saveReassessmentAttempt({ ...baseParams, caseType: 'sideways' });
    expect(res.status).toBe('invalid_input');
  });

  it('reports save_failed on an unexpected DB error, never throws', async () => {
    mockLaCreate.mockRejectedValueOnce(new Error('connection reset'));
    const res = await saveReassessmentAttempt(baseParams);
    expect(res.status).toBe('save_failed');
  });

  it('never references any Features 1-10 side-effect model or orchestration call in its own source', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/letterMotorReassessmentService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/LetterProgress|ThresholdHistory|personal_thresholds|runDynamicThresholdOrchestration|processDynamicThresholdAfterLetterSession|persistentDifficulty|worksheetRecommendation|demoSpeedRecommendation|supportRecommendation|wordWriting|Student\.update|streak/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// finalizeReassessment — ~19 named scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe('finalizeReassessment', () => {
  const params = { studentId: STUDENT_ID, reassessmentSessionId: SESSION_ID };

  // 1. invalid input
  it('Scenario 1 — invalid studentId returns invalid_input, no queries run', async () => {
    const res = await finalizeReassessment({ studentId: -1, reassessmentSessionId: SESSION_ID });
    expect(res.status).toBe('invalid_input');
    expect(mockLmrFindOne).not.toHaveBeenCalled();
  });

  // 2. invalid session id
  it('Scenario 2 — invalid (non-UUID) reassessmentSessionId returns invalid_input', async () => {
    const res = await finalizeReassessment({ studentId: STUDENT_ID, reassessmentSessionId: 'nope' });
    expect(res.status).toBe('invalid_input');
    expect(mockLmrFindOne).not.toHaveBeenCalled();
  });

  // 3. idempotent replay
  it('Scenario 3 — idempotent replay: an existing result short-circuits before any raw-row query or ML call', async () => {
    const existing = { id: 9, student_id: STUDENT_ID, reassessment_session_id: SESSION_ID, model_version: 'letter_motor_cluster_v1' };
    mockLmrFindOne.mockResolvedValueOnce(existing);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('already_finalized');
    expect(res.result).toBe(existing);
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockPredict).not.toHaveBeenCalled();
  });

  // 4. zero rows collected -> incomplete, missing = all 20
  it('Scenario 4 — zero raw rows collected returns incomplete with all 20 missing', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    mockLaFindAll.mockResolvedValueOnce([]);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('incomplete');
    expect(res.missing.length).toBe(20);
  });

  // 5. 19/20 present -> incomplete with exactly 1 missing
  it('Scenario 5 — 19 of 20 present returns incomplete with exactly 1 missing letter', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet().slice(0, 19);
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('incomplete');
    expect(res.missing.length).toBe(1);
  });

  // 6. all 20 present but query returned rows for a DIFFERENT collection_mode/capture_status/support_level
  //    -> those rows are defensively excluded, so still incomplete
  it('Scenario 6 — a row with support_level != low is defensively excluded even though the save path should prevent it', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[0] = { ...rows[0], support_level: 'high' }; // corrupt one row
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('incomplete');
    expect(res.missing.length).toBe(1);
  });

  it('Scenario 6b — a row with collection_mode true is defensively excluded', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[0] = { ...rows[0], collection_mode: true };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('incomplete');
  });

  it('Scenario 6c — a row with capture_status != complete is defensively excluded', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[0] = { ...rows[0], capture_status: 'incomplete' };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('incomplete');
  });

  // 7. retries for one letter -> most-recent-wins selection rule
  it('Scenario 7 — retries for one letter: the MOST RECENT eligible row is selected (documented selection rule)', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    // Add an older AND a newer duplicate for the first required pair.
    const first = rows[0];
    const older = fixtureRow({ letter: first.letter, caseType: first.case_type, id: 9001, createdAtMs: 500,
      overrides: { normalized_features: { smoothness_score: 1, dtw_distance: 1, speed_cv: 1 }, feature_version: 'fv1', template_version: 'tv1', normalization_version: 'nv1' } });
    const newer = fixtureRow({ letter: first.letter, caseType: first.case_type, id: 9002, createdAtMs: 5000,
      overrides: { normalized_features: { smoothness_score: 999, dtw_distance: 999, speed_cv: 999 }, feature_version: 'fv1', template_version: 'tv1', normalization_version: 'nv1' } });
    mockLaFindAll.mockResolvedValueOnce([...rows, older, newer]);
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    mockLmrCreate.mockResolvedValueOnce({ id: 1, ...PREDICTION_FIXTURE });

    await finalizeReassessment(params);

    const [{ smoothnessScore }] = mockPredict.mock.calls[0];
    // The newer duplicate (999) must have been the one selected, not the
    // original fixture row (50) or the older duplicate (1) — confirmed by
    // checking the aggregate shifted heavily toward 999.
    expect(smoothnessScore).toBeGreaterThan(90);
  });

  // 8. missing smoothness_score -> invalid_features
  it('Scenario 8 — a selected row missing smoothness_score returns invalid_features', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[3] = { ...rows[3], normalized_features: { ...rows[3].normalized_features, smoothness_score: null } };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('invalid_features');
    expect(res.invalidLetters.length).toBe(1);
  });

  // 9. non-finite dtw_distance -> invalid_features
  it('Scenario 9 — a selected row with a non-finite dtw_distance (NaN) returns invalid_features', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[7] = { ...rows[7], normalized_features: { ...rows[7].normalized_features, dtw_distance: NaN } };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('invalid_features');
  });

  // 10. missing speed_cv -> invalid_features
  it('Scenario 10 — a selected row missing speed_cv returns invalid_features', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[15] = { ...rows[15], normalized_features: { ...rows[15].normalized_features, speed_cv: undefined } };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('invalid_features');
  });

  // 11. feature_version mismatch -> version_mismatch, never averaged
  it('Scenario 11 — a feature_version mismatch across the 20 rows returns version_mismatch, never averages', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[0] = { ...rows[0], feature_version: 'fv2' };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('version_mismatch');
    expect(mockPredict).not.toHaveBeenCalled();
  });

  // 12. template_version mismatch
  it('Scenario 12 — a template_version mismatch returns version_mismatch', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[5] = { ...rows[5], template_version: 'tv2' };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('version_mismatch');
  });

  // 13. normalization_version mismatch
  it('Scenario 13 — a normalization_version mismatch returns version_mismatch', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[10] = { ...rows[10], normalization_version: 'nv2' };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('version_mismatch');
  });

  // 14. a null version field among otherwise-identical rows -> mismatch (never treated as "compatible")
  it('Scenario 14 — a null feature_version among otherwise-identical rows is treated as a mismatch, not silently compatible', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet();
    rows[0] = { ...rows[0], feature_version: null };
    mockLaFindAll.mockResolvedValueOnce(rows);
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('version_mismatch');
  });

  // 15. ML service call fails -> ml_service_unavailable, nothing persisted
  it('Scenario 15 — an ML service failure returns ml_service_unavailable and persists nothing', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    mockLaFindAll.mockResolvedValueOnce(fullFixtureSet());
    mockPredict.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('ml_service_unavailable');
    expect(mockLmrCreate).not.toHaveBeenCalled();
  });

  // 16. happy path -> finalized, correct persisted shape
  it('Scenario 16 — happy path: 20/20 valid, consistent versions -> finalized and persisted with the ML response verbatim', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    mockLaFindAll.mockResolvedValueOnce(fullFixtureSet());
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    const createdRow = { id: 77, ...PREDICTION_FIXTURE };
    mockLmrCreate.mockResolvedValueOnce(createdRow);

    const res = await finalizeReassessment(params);
    expect(res.status).toBe('finalized');
    expect(res.result).toBe(createdRow);

    const createArgs = mockLmrCreate.mock.calls[0][0];
    expect(createArgs.cluster_id).toBe(PREDICTION_FIXTURE.cluster_id);
    expect(createArgs.state_code).toBe(PREDICTION_FIXTURE.state_code);
    expect(createArgs.model_version).toBe(PREDICTION_FIXTURE.model_version);
    expect(createArgs.feature_version).toBe('fv1');
    expect(createArgs.template_version).toBe('tv1');
    expect(createArgs.normalization_version).toBe('nv1');
    expect(createArgs.student_id).toBe(STUDENT_ID);
    expect(createArgs.reassessment_session_id).toBe(SESSION_ID);
  });

  // 17. reference aggregation — exact known-value fixture
  it('Scenario 17 — reference aggregation: arithmetic mean over the 20 fixture rows matches an exact known value', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const rows = fullFixtureSet({ smoothnessBase: 50, dtwBase: 10, speedCvBase: 0.2 });
    mockLaFindAll.mockResolvedValueOnce(rows);
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    mockLmrCreate.mockResolvedValueOnce({ id: 1, ...PREDICTION_FIXTURE });

    await finalizeReassessment(params);

    const expectedSmoothness = average(Array.from({ length: 20 }, (_, i) => 50 + i));        // 59.5
    const expectedDtw        = average(Array.from({ length: 20 }, (_, i) => 10 + i * 0.5));   // 14.75
    const expectedSpeedCv    = average(Array.from({ length: 20 }, (_, i) => 0.2 + i * 0.01)); // 0.295

    const [{ smoothnessScore, dtwDistance, speedCv }] = mockPredict.mock.calls[0];
    expect(smoothnessScore).toBeCloseTo(expectedSmoothness, 10);
    expect(dtwDistance).toBeCloseTo(expectedDtw, 10);
    expect(speedCv).toBeCloseTo(expectedSpeedCv, 10);

    // Persisted row stores the same aggregated inputs actually sent to ML.
    const createArgs = mockLmrCreate.mock.calls[0][0];
    expect(createArgs.smoothness_score).toBeCloseTo(expectedSmoothness, 10);
    expect(createArgs.dtw_distance).toBeCloseTo(expectedDtw, 10);
    expect(createArgs.speed_cv).toBeCloseTo(expectedSpeedCv, 10);
  });

  // 18. race condition on create -> resolves to already_finalized via re-fetch
  it('Scenario 18 — a unique-constraint race on create() resolves to already_finalized via re-fetch, not an error', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null); // first idempotency check: nothing yet
    mockLaFindAll.mockResolvedValueOnce(fullFixtureSet());
    mockPredict.mockResolvedValueOnce(PREDICTION_FIXTURE);
    const raceErr = new Error('duplicate key');
    raceErr.name = 'SequelizeUniqueConstraintError';
    mockLmrCreate.mockRejectedValueOnce(raceErr);
    const raceWinner = { id: 55, ...PREDICTION_FIXTURE };
    mockLmrFindOne.mockResolvedValueOnce(raceWinner); // re-fetch after the race

    const res = await finalizeReassessment(params);
    expect(res.status).toBe('already_finalized');
    expect(res.result).toBe(raceWinner);
  });

  // 19. unexpected DB error -> save_failed, never throws
  it('Scenario 19 — an unexpected error during raw-row fetch returns save_failed, never throws', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    mockLaFindAll.mockRejectedValueOnce(new Error('connection reset'));
    const res = await finalizeReassessment(params);
    expect(res.status).toBe('save_failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// selectMostRecentPerLetter — direct unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('selectMostRecentPerLetter', () => {
  it('keeps only the newest row (by created_at) per (letter, caseType)', () => {
    const rows = [
      fixtureRow({ letter: 'A', caseType: 'uppercase', id: 1, createdAtMs: 100 }),
      fixtureRow({ letter: 'A', caseType: 'uppercase', id: 2, createdAtMs: 300 }),
      fixtureRow({ letter: 'A', caseType: 'uppercase', id: 3, createdAtMs: 200 }),
    ];
    const selected = selectMostRecentPerLetter(rows);
    expect(selected.get('A|uppercase').id).toBe(2);
  });

  it('uses id as a deterministic tiebreaker for equal created_at', () => {
    const rows = [
      fixtureRow({ letter: 'A', caseType: 'uppercase', id: 5, createdAtMs: 100 }),
      fixtureRow({ letter: 'A', caseType: 'uppercase', id: 9, createdAtMs: 100 }),
    ];
    const selected = selectMostRecentPerLetter(rows);
    expect(selected.get('A|uppercase').id).toBe(9);
  });

  it('does not mutate the input array', () => {
    const rows = [fixtureRow({ letter: 'A', caseType: 'uppercase', id: 1, createdAtMs: 100 })];
    const copy = [...rows];
    selectMostRecentPerLetter(rows);
    expect(rows).toEqual(copy);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getLatestReassessment / getReassessmentHistory — read-only, never call ML
// ═══════════════════════════════════════════════════════════════════════════

describe('getLatestReassessment', () => {
  it('returns found + the newest row, never touching predict', async () => {
    const row = { id: 1, student_id: STUDENT_ID };
    mockLmrFindOne.mockResolvedValueOnce(row);
    const res = await getLatestReassessment({ studentId: STUDENT_ID });
    expect(res.status).toBe('found');
    expect(res.result).toBe(row);
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('returns not_found when nothing exists yet', async () => {
    mockLmrFindOne.mockResolvedValueOnce(null);
    const res = await getLatestReassessment({ studentId: STUDENT_ID });
    expect(res.status).toBe('not_found');
  });

  it('returns invalid_input for a bad studentId, without querying', async () => {
    const res = await getLatestReassessment({ studentId: 'abc' });
    expect(res.status).toBe('invalid_input');
    expect(mockLmrFindOne).not.toHaveBeenCalled();
  });
});

describe('getReassessmentHistory', () => {
  it('returns found + ordered results, never touching predict', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    mockLmrFindAll.mockResolvedValueOnce(rows);
    const res = await getReassessmentHistory({ studentId: STUDENT_ID });
    expect(res.status).toBe('found');
    expect(res.results).toBe(rows);
    expect(mockPredict).not.toHaveBeenCalled();
  });

  it('orders chronologically ascending (oldest -> newest)', async () => {
    mockLmrFindAll.mockResolvedValueOnce([]);
    await getReassessmentHistory({ studentId: STUDENT_ID });
    const callArgs = mockLmrFindAll.mock.calls[0][0];
    expect(callArgs.order).toEqual([['completed_at', 'ASC'], ['id', 'ASC']]);
  });
});

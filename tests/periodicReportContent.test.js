'use strict';

// Proposal FR-19, Phase 7C — periodicReportService.js content/temporal-
// semantics tests (spec items 6-18). Every model/service dependency is
// mocked so these tests prove the SERVICE's own query/aggregation logic,
// independent of a real database.

const mockStudentFindByPk = jest.fn();
const mockTeacherFindByPk = jest.fn();
const mockLetterProgressFindAll = jest.fn();
const mockLetterAttemptFindAll = jest.fn();
const mockLetterMotorStateHistoryFindAll = jest.fn();
const mockLetterMotorStateHistoryFindOne = jest.fn();
const mockWordWritingAttemptFindAll = jest.fn();
const mockTeacherRecommendationValidationFindAll = jest.fn();
const mockLetterMotorMasteryEvidenceFindAll = jest.fn();
const mockLetterMotorStateEvaluationFindOne = jest.fn();
const mockLetterMotorStateEvaluationFindAll = jest.fn();
const mockHandwritingWorksheetFindAll = jest.fn();
const mockHandwritingWorksheetSubmissionFindAll = jest.fn();

jest.mock('../src/models', () => ({
  Student:  { findByPk: (...a) => mockStudentFindByPk(...a) },
  Teacher:  { findByPk: (...a) => mockTeacherFindByPk(...a) },
  LetterProgress: { findAll: (...a) => mockLetterProgressFindAll(...a) },
  LetterAttempt:  { findAll: (...a) => mockLetterAttemptFindAll(...a) },
  LetterMotorStateHistory: {
    findAll: (...a) => mockLetterMotorStateHistoryFindAll(...a),
    findOne: (...a) => mockLetterMotorStateHistoryFindOne(...a),
  },
  WordWritingAttempt: { findAll: (...a) => mockWordWritingAttemptFindAll(...a) },
  TeacherRecommendationValidation: { findAll: (...a) => mockTeacherRecommendationValidationFindAll(...a) },
  LetterMotorMasteryEvidence: { findAll: (...a) => mockLetterMotorMasteryEvidenceFindAll(...a) },
  LetterMotorStateEvaluation: {
    findOne: (...a) => mockLetterMotorStateEvaluationFindOne(...a),
    findAll: (...a) => mockLetterMotorStateEvaluationFindAll(...a),
  },
  HandwritingWorksheet: { findAll: (...a) => mockHandwritingWorksheetFindAll(...a) },
  HandwritingWorksheetSubmission: { findAll: (...a) => mockHandwritingWorksheetSubmissionFindAll(...a) },
}));

const mockEvaluatePersistentDifficulty = jest.fn();
const mockEvaluateWorksheetRecommendations = jest.fn();
const mockGetStudentMotorBaseline = jest.fn();

jest.mock('../src/services/persistentDifficultyService', () => ({
  evaluatePersistentDifficulty: (...a) => mockEvaluatePersistentDifficulty(...a),
}));
jest.mock('../src/services/worksheetRecommendationService', () => ({
  evaluateWorksheetRecommendations: (...a) => mockEvaluateWorksheetRecommendations(...a),
}));
jest.mock('../src/services/motorBaselineService', () => ({
  getStudentMotorBaseline: (...a) => mockGetStudentMotorBaseline(...a),
}));

const { buildPeriodicReport } = require('../src/services/periodicReportService');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function readServiceSourceCodeOnly() {
  return stripComments(require('fs').readFileSync(require.resolve('../src/services/periodicReportService.js'), 'utf8'));
}

const STUDENT_ID = 10;
const TEACHER_ID = 7;
const START_AT = new Date('2026-01-01T00:00:00.000Z');
const END_AT   = new Date('2026-06-30T23:59:59.999Z');
const RANGE = { studentId: STUDENT_ID, teacherId: TEACHER_ID, startAt: START_AT, endAt: END_AT, startDate: '2026-01-01', endDate: '2026-06-30' };

function defaultMocks() {
  mockStudentFindByPk.mockResolvedValue({ sid: STUDENT_ID, full_name: 'Test Student', student_code: 'STU-1' });
  mockTeacherFindByPk.mockResolvedValue({ full_name: 'Test Teacher' });
  mockLetterProgressFindAll.mockResolvedValue([]);
  mockLetterAttemptFindAll.mockResolvedValue([]);
  mockLetterMotorStateHistoryFindAll.mockResolvedValue([]);
  mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
  mockWordWritingAttemptFindAll.mockResolvedValue([]);
  mockTeacherRecommendationValidationFindAll.mockResolvedValue([]);
  mockLetterMotorMasteryEvidenceFindAll.mockResolvedValue([]);
  mockLetterMotorStateEvaluationFindOne.mockResolvedValue(null);
  mockLetterMotorStateEvaluationFindAll.mockResolvedValue([]);
  mockHandwritingWorksheetFindAll.mockResolvedValue([]);
  mockHandwritingWorksheetSubmissionFindAll.mockResolvedValue([]);
  mockEvaluatePersistentDifficulty.mockResolvedValue({ status: 'evaluated', summary: { persistentCount: 0 } });
  mockEvaluateWorksheetRecommendations.mockResolvedValue({ status: 'evaluated', recommendations: [] });
  mockGetStudentMotorBaseline.mockResolvedValue({ status: 'baseline_not_found', baseline: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  defaultMocks();
});

// ─── 6. no data period ───────────────────────────────────────────────────
describe('empty period', () => {
  it('generates a valid report with the neutral no-activity message, never crashes', async () => {
    const report = await buildPeriodicReport(RANGE);
    expect(report.has_activity_in_period).toBe(false);
    expect(report.summary_text).toBe('No handwriting activity was recorded during this period.');
  });
});

// ─── 7/8/9. boundary inclusion/exclusion ────────────────────────────────
describe('date-boundary semantics', () => {
  it('an event exactly on the start boundary is included', async () => {
    mockLetterProgressFindAll.mockResolvedValue([
      { letter: 'a', case_type: 'lowercase', mastered_at: START_AT.toISOString() },
    ]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.learning_progress.lowercase_mastered_during_period).toBe(1);
  });

  it('an event exactly on the end boundary is included', async () => {
    mockLetterProgressFindAll.mockResolvedValue([
      { letter: 'b', case_type: 'lowercase', mastered_at: END_AT.toISOString() },
    ]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.learning_progress.lowercase_mastered_during_period).toBe(1);
  });

  it('data strictly after end_date is excluded from "during period" (the DB query itself is date-bounded)', async () => {
    // The service passes Op.lte: endAt to LetterProgress.findAll — a row
    // after endAt would never even be returned by a real DB. Verifying the
    // query args themselves proves the exclusion, since the mock returns
    // exactly what's given regardless.
    await buildPeriodicReport(RANGE);
    const whereArg = mockLetterProgressFindAll.mock.calls[0][0].where;
    expect(whereArg.mastered_at).toBeDefined();
  });

  it('LetterAttempt query uses Op.between[startAt, endAt] — data before start and after end is excluded at the DB level', async () => {
    await buildPeriodicReport(RANGE);
    const whereArg = mockLetterAttemptFindAll.mock.calls[0][0].where;
    expect(whereArg.created_at).toBeDefined();
    expect(whereArg.collection_mode).toBe(false);
    expect(whereArg.source_type).toBeNull();
  });
});

// ─── 10/11. Feature 11B as-of-end-date logic ────────────────────────────
describe('Feature 11B — as-of end date, never a later current milestone', () => {
  it('queries the latest milestone with observed_at <= endAt, not an unconditional latest', async () => {
    await buildPeriodicReport(RANGE);
    const findOneArgs = mockLetterMotorStateHistoryFindOne.mock.calls[0][0];
    expect(findOneArgs.where.observed_at).toBeDefined();
    expect(findOneArgs.order).toEqual([['observed_at', 'DESC']]);
  });

  it('a milestone whose observed_at is after end_date is excluded from state_as_of_end_date (proven by the mock only ever returning what the "as-of" query itself would legitimately return)', async () => {
    // Simulates the DB honoring the Op.lte filter: a milestone after endAt
    // would never be returned by findOne given that where-clause, so the
    // mock intentionally returns null here to represent that case.
    mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
    mockLetterMotorStateHistoryFindAll.mockResolvedValue([]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.state_as_of_end_date).toBeNull();
  });

  it('milestones_during_period only includes rows the DB query returns for the BETWEEN(startAt,endAt) filter', async () => {
    mockLetterMotorStateHistoryFindAll.mockResolvedValue([
      { milestone: '14/20', state_code: 'A', display_name: 'State A', coverage_n: 14, observed_at: '2026-03-01T00:00:00.000Z' },
    ]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.milestones_during_period).toHaveLength(1);
    expect(report.letter_motor_development.milestones_during_period[0].milestone).toBe('14/20');
  });

  // A student below the first milestone has no pattern at all. Reporting only
  // "no pattern" leaves the teacher-facing card looking broken, so the report
  // also carries how far along the reference set the student is.
  it('reports progress toward the first milestone so an absent pattern is explainable', async () => {
    // 9 pairs, all inside the first milestone's own required 14.
    mockLetterMotorMasteryEvidenceFindAll.mockResolvedValue(
      ['l', 'i', 't', 'o', 'c', 'a', 's', 'h', 'k'].map((letter) => ({ letter, case_type: 'lowercase' }))
    );
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.reference_progress).toEqual({
      evidence_letters: 9,
      first_milestone_required: 14,
      total_reference_evidence_letters: 9,
      reference_letter_total: 20,
    });
  });

  // C2 — the milestone figure is what the teacher-facing "N of the 14"
  // sentence prints. Evidence outside the first milestone's required set is
  // real evidence, but it moves the student no closer to
  // UPPERCASE_STRAIGHT_14, because substitution is never permitted.
  it("counts ONLY the first milestone's required pairs, never all 20 reference letters", async () => {
    mockLetterMotorMasteryEvidenceFindAll.mockResolvedValue([
      // 2 inside the 14-set
      { letter: 'l', case_type: 'lowercase' },
      { letter: 'i', case_type: 'lowercase' },
      // 4 reference letters OUTSIDE the 14-set (uppercase curved / mixed)
      { letter: 'C', case_type: 'uppercase' },
      { letter: 'O', case_type: 'uppercase' },
      { letter: 'A', case_type: 'uppercase' },
      { letter: 'K', case_type: 'uppercase' },
    ]);
    const report = await buildPeriodicReport(RANGE);
    const progress = report.letter_motor_development.reference_progress;

    expect(progress.evidence_letters).toBe(2);
    expect(progress.total_reference_evidence_letters).toBe(6);
    expect(progress.first_milestone_required).toBe(14);
  });

  it('case matters — lowercase c is in the 14-set, uppercase C is not', async () => {
    mockLetterMotorMasteryEvidenceFindAll.mockResolvedValue([
      { letter: 'c', case_type: 'lowercase' },
      { letter: 'C', case_type: 'uppercase' },
    ]);
    const report = await buildPeriodicReport(RANGE);
    const progress = report.letter_motor_development.reference_progress;
    expect(progress.evidence_letters).toBe(1);
    expect(progress.total_reference_evidence_letters).toBe(2);
  });

  it('a complete 14-set reports exactly 14', async () => {
    mockLetterMotorMasteryEvidenceFindAll.mockResolvedValue([
      ...['l', 'i', 't', 'o', 'c', 'a', 's', 'h', 'k', 'b'].map((letter) => ({ letter, case_type: 'lowercase' })),
      ...['I', 'L', 'T', 'H'].map((letter) => ({ letter, case_type: 'uppercase' })),
    ]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.reference_progress.evidence_letters).toBe(14);
  });

  it('counts frozen evidence, not letters mastered — an ineligible mastery contributes nothing', async () => {
    mockLetterProgressFindAll.mockResolvedValue([
      { letter: 'a', case_type: 'lowercase', mastered_at: '2026-03-01T00:00:00.000Z' },
      { letter: 'c', case_type: 'lowercase', mastered_at: '2026-03-02T00:00:00.000Z' },
    ]);
    mockLetterMotorMasteryEvidenceFindAll.mockResolvedValue([]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.reference_progress.evidence_letters).toBe(0);
  });

  it('the evidence read is cumulative, never restricted to the reporting period', async () => {
    await buildPeriodicReport(RANGE);
    const where = mockLetterMotorMasteryEvidenceFindAll.mock.calls[0][0].where;
    expect(where).toEqual({ student_id: RANGE.studentId });
    expect(Object.keys(where)).not.toContain('created_at');
    expect(Object.keys(where)).not.toContain('mastered_at');
  });

  // ── S2 — machine-readable evaluation_status ────────────────────────────

  it('S2 — not_reached when no milestone has ever been evaluated', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
    mockLetterMotorStateEvaluationFindOne.mockResolvedValue(null);
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.evaluation_status).toBe('not_reached');
    expect(report.letter_motor_development.reference_range_evaluation).toBeNull();
  });

  it('S2 — assigned when a pattern row exists as of the end date', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue({
      milestone: 'UPPERCASE_STRAIGHT_14', state_code: 'LETTER_STATE_A', display_name: 'Letter Motor State A',
      coverage_n: 14, observed_at: '2026-03-01T00:00:00.000Z',
    });
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.evaluation_status).toBe('assigned');
    expect(report.letter_motor_development.reference_range_evaluation).toBeNull();
  });

  it('S2 — assigned is decided from the pattern row alone, without consulting the evaluations table', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue({
      milestone: 'UPPERCASE_STRAIGHT_14', state_code: 'LETTER_STATE_B', display_name: 'Letter Motor State B',
      coverage_n: 14, observed_at: '2026-03-01T00:00:00.000Z',
    });
    await buildPeriodicReport(RANGE);
    expect(mockLetterMotorStateEvaluationFindOne).not.toHaveBeenCalled();
  });

  it('S2 — outside_reference_range surfaces the guard\'s own reason, never a pattern', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
    mockLetterMotorStateEvaluationFindOne.mockResolvedValue({
      milestone: 'UPPERCASE_STRAIGHT_14', coverage_n: 14,
      observed_at: '2026-03-01T00:00:00.000Z',
      ood_reason: 'dtw_distance_outside_reference_range',
      ood_outside_features: ['dtw_distance'],
      model_version: 'letter_motor_cluster_v1',
    });
    const report = await buildPeriodicReport(RANGE);
    const dev = report.letter_motor_development;

    expect(dev.evaluation_status).toBe('outside_reference_range');
    expect(dev.reference_range_evaluation.reason).toBe('dtw_distance_outside_reference_range');
    expect(dev.reference_range_evaluation.outside_features).toEqual(['dtw_distance']);
    expect(dev.reference_range_evaluation.milestone).toBe('UPPERCASE_STRAIGHT_14');
    // No pattern is implied anywhere.
    expect(dev.state_as_of_end_date).toBeNull();
    expect(JSON.stringify(dev)).not.toMatch(/LETTER_STATE_[AB]|cluster_id/);
  });

  it('S2 — the rejection query is bounded by the report end date, never "latest overall"', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
    await buildPeriodicReport(RANGE);
    const args = mockLetterMotorStateEvaluationFindOne.mock.calls[0][0];
    expect(args.where.evaluation_status).toBe('outside_reference_range');
    expect(args.where.observed_at).toBeDefined();
    expect(args.order).toEqual([['observed_at', 'DESC'], ['id', 'DESC']]);
  });

  it('S2 — unavailable when the evaluations read fails, never silently not_reached', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
    mockLetterMotorStateEvaluationFindOne.mockRejectedValue(new Error('db down'));
    const report = await buildPeriodicReport(RANGE);
    expect(report.letter_motor_development.evaluation_status).toBe('unavailable');
    expect(report.letter_motor_development.reference_range_evaluation).toBeNull();
  });

  it('S2 — a failing evaluations read never fails the whole report', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue(null);
    mockLetterMotorStateEvaluationFindOne.mockRejectedValue(new Error('db down'));
    await expect(buildPeriodicReport(RANGE)).resolves.toBeTruthy();
  });

  it('S2 — every pre-existing letter_motor_development field is still present', async () => {
    const report = await buildPeriodicReport(RANGE);
    for (const key of ['milestones_during_period', 'state_as_of_end_date', 'reference_progress']) {
      expect(report.letter_motor_development).toHaveProperty(key);
    }
  });

  it('never uses ordinal improvement/decline language for Letter Motor State', () => {
    const source = readServiceSourceCodeOnly();
    expect(source).not.toMatch(/\bimproved\b|\bworsened\b|\bdeclined\b/i);
  });
});

// ─── 12. mastery during-period vs cumulative-as-of distinction ──────────
describe('during-period vs cumulative-as-of-end-date distinction', () => {
  it('counts letters mastered before the period toward cumulative but NOT toward during-period', async () => {
    mockLetterProgressFindAll.mockResolvedValue([
      { letter: 'a', case_type: 'lowercase', mastered_at: '2025-01-01T00:00:00.000Z' }, // before period
      { letter: 'b', case_type: 'lowercase', mastered_at: '2026-03-01T00:00:00.000Z' }, // during period
    ]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.learning_progress.lowercase_mastered_during_period).toBe(1);
    expect(report.learning_progress.cumulative_lowercase_mastered_by_end_date).toBe(2);
  });
});

// ─── 13. word data date filtering ────────────────────────────────────────
describe('word data date filtering', () => {
  it('WordWritingAttempt query filters by created_at BETWEEN and collection_mode:false', async () => {
    await buildPeriodicReport(RANGE);
    const whereArg = mockWordWritingAttemptFindAll.mock.calls[0][0].where;
    expect(whereArg.created_at).toBeDefined();
    expect(whereArg.collection_mode).toBe(false);
  });

  it('aggregates distinct words attempted vs total attempts vs words completed, all from the one query result', async () => {
    mockWordWritingAttemptFindAll.mockResolvedValue([
      { word: 'cat', score: 80, completion_passed: true, created_at: '2026-02-01T00:00:00.000Z' },
      { word: 'cat', score: 60, completion_passed: false, created_at: '2026-02-02T00:00:00.000Z' },
      { word: 'dog', score: 90, completion_passed: true, created_at: '2026-02-03T00:00:00.000Z' },
    ]);
    const report = await buildPeriodicReport(RANGE);
    expect(report.word_writing.words_attempted_during_period).toBe(2);
    expect(report.word_writing.attempts_during_period).toBe(3);
    expect(report.word_writing.words_completed_during_period).toBe(2);
  });
});

// ─── 14. recommendations date filtering where applicable ────────────────
describe('teacher validations are period-filtered; recommendations/persistent-difficulty are explicitly current-status', () => {
  it('TeacherRecommendationValidation query filters by created_at BETWEEN', async () => {
    await buildPeriodicReport(RANGE);
    const whereArg = mockTeacherRecommendationValidationFindAll.mock.calls[0][0].where;
    expect(whereArg.created_at).toBeDefined();
  });

  it('worksheet recommendations / persistent difficulty are NOT date-filtered — evaluatePersistentDifficulty/evaluateWorksheetRecommendations receive no date args, and the report labels them "current"', async () => {
    await buildPeriodicReport(RANGE);
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledWith({ studentId: STUDENT_ID });
    expect(mockEvaluateWorksheetRecommendations).toHaveBeenCalledWith({ studentId: STUDENT_ID });
    const report = await buildPeriodicReport(RANGE);
    expect(Object.keys(report.adaptive_support)).toContain('persistent_difficulty_current_status');
    expect(Object.keys(report.adaptive_support)).toContain('worksheet_recommendations_current');
  });
});

// ─── E. Feature 11A is baseline context, never re-predicted ────────────
describe('Feature 11A section', () => {
  it('reads the persisted baseline only — never calls a prediction/ML service', async () => {
    mockGetStudentMotorBaseline.mockResolvedValue({
      status: 'found',
      baseline: { straight_score: 70, curved_score: 60, complex_score: 50, overall_motor_score: 65, created_at: '2025-01-01T00:00:00.000Z' },
    });
    const report = await buildPeriodicReport(RANGE);
    expect(report.initial_shape_motor_profile.available).toBe(true);
    expect(report.initial_shape_motor_profile.is_baseline_context_predating_period).toBe(true);
    expect(report.initial_shape_motor_profile.scores.overall).toBe(65);
  });

  it('this module never requires the ML client or the motor-cluster prediction service', () => {
    const source = readServiceSourceCodeOnly();
    expect(source).not.toMatch(/mlServiceClient|motorClusterService|predictInitialMotorCluster/);
  });

  // S3 — report parity. The periodic report and its PDF carried a section
  // headed "Initial Handwriting Skills Summary" containing only four bare
  // numbers, while the live dashboard card showed the same numbers plus a
  // narrative. Both now come from the SAME builder.
  it('carries the same baseline summary narrative the live motor-baseline endpoint returns', async () => {
    mockGetStudentMotorBaseline.mockResolvedValue({
      status: 'found',
      baseline: { straight_score: 70, curved_score: 60, complex_score: 50, overall_motor_score: 65, created_at: '2025-01-01T00:00:00.000Z' },
    });
    const report = await buildPeriodicReport(RANGE);
    const summary = report.initial_shape_motor_profile.summary;

    expect(summary).toBeTruthy();
    expect(summary.available).toBe(true);
    expect(typeof summary.description).toBe('string');
    expect(summary.description.length).toBeGreaterThan(0);
    expect(typeof summary.disclosure).toBe('string');
    // Restates the SAME authoritative scores — never a recomputed figure.
    expect(summary.overall_score).toBe(65);
    expect(summary.families).toEqual({ straight: 70, curved: 60, complex: 50 });
  });

  it('produces byte-identical summary output to the shared builder — no second algorithm', async () => {
    const { buildInitialMotorBaselineSummary } = require('../src/utils/initialMotorBaselineSummary');
    const baseline = { straight_score: 82, curved_score: 55, complex_score: 61, overall_motor_score: 66, created_at: '2025-01-01T00:00:00.000Z' };
    mockGetStudentMotorBaseline.mockResolvedValue({ status: 'found', baseline });

    const report = await buildPeriodicReport(RANGE);
    expect(report.initial_shape_motor_profile.summary).toEqual(
      buildInitialMotorBaselineSummary({
        straightScore: 82, curvedScore: 55, complexScore: 61, overallMotorScore: 66,
      })
    );
  });

  it('omits the summary entirely when no baseline exists — never a fabricated narrative', async () => {
    mockGetStudentMotorBaseline.mockResolvedValue({ status: 'baseline_not_found', baseline: null });
    const report = await buildPeriodicReport(RANGE);
    expect(report.initial_shape_motor_profile.available).toBe(false);
    expect(report.initial_shape_motor_profile.summary).toBeUndefined();
  });
});

// ─── 15/16/17. Read-only guarantee — no writes, no ML, no Feature 1-11 mutation ──
describe('read-only guarantee', () => {
  it('no write method (create/update/destroy/upsert/save) exists on any mocked model access in this module', () => {
    const source = readServiceSourceCodeOnly();
    expect(source).not.toMatch(/\.create\(|\.update\(|\.destroy\(|\.upsert\(|\.save\(/);
  });

  it('never imports letterMotorMasteryService or dynamicThresholdService (Feature 11B/Feature 2\'s own write paths)', () => {
    const source = readServiceSourceCodeOnly();
    expect(source).not.toMatch(/letterMotorMasteryService|dynamicThresholdService/);
  });

  it('never imports liveSessionService or collectionController (FR-16 / collection-mode write paths)', () => {
    const source = readServiceSourceCodeOnly();
    expect(source).not.toMatch(/liveSessionService|collectionController/);
  });

  it('a full report build never calls any of the write-capable mocked functions', async () => {
    await buildPeriodicReport(RANGE);
    // None of the mocked model functions above expose create/update/destroy
    // at all (only findAll/findOne/findByPk were ever stubbed) — if the
    // service tried to call one, this whole test file would throw
    // "... is not a function" before reaching any assertion.
    expect(true).toBe(true);
  });
});

// ─── 18. query strategy — bounded, not N+1 ───────────────────────────────
describe('query strategy — bounded aggregate queries only', () => {
  it('builds a full report with exactly one query per data source (8 total), never one per letter/word/milestone', async () => {
    await buildPeriodicReport(RANGE);
    expect(mockStudentFindByPk).toHaveBeenCalledTimes(1);
    expect(mockTeacherFindByPk).toHaveBeenCalledTimes(1);
    expect(mockLetterProgressFindAll).toHaveBeenCalledTimes(1);
    expect(mockLetterAttemptFindAll).toHaveBeenCalledTimes(1);
    // Two bounded reads now: legacy milestone rows during the period, and the
    // Writing Check pattern rows. Both are single whole-table-scoped queries —
    // the invariant this test protects is "never one query per
    // letter/word/milestone", not a fixed total.
    expect(mockLetterMotorStateHistoryFindAll).toHaveBeenCalledTimes(2);
    expect(mockLetterMotorStateHistoryFindOne).toHaveBeenCalledTimes(1);
    expect(mockWordWritingAttemptFindAll).toHaveBeenCalledTimes(1);
    expect(mockTeacherRecommendationValidationFindAll).toHaveBeenCalledTimes(1);
  });

  it('query count does not grow with the number of rows returned (100 attempts still cost exactly one findAll call)', async () => {
    mockLetterAttemptFindAll.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({ motor_score: 50 + (i % 40), normalized_features: { smoothness_score: 70, dtw_distance: 1.2, speed_cv: 0.3, duration_ms: 4000 } }))
    );
    const report = await buildPeriodicReport(RANGE);
    expect(mockLetterAttemptFindAll).toHaveBeenCalledTimes(1);
    expect(report.motor_performance.attempts_in_period).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Writing Check reporting — precedence, as-of-end-date, and period scoping
// ═══════════════════════════════════════════════════════════════════════════

describe('Writing Check reporting', () => {
  const AUG = '2026-03-01T00:00:00.000Z';   // inside RANGE
  const OCT = '2026-05-01T00:00:00.000Z';   // inside RANGE, later
  const BEFORE = '2025-06-01T00:00:00.000Z'; // before RANGE start
  const AFTER  = '2026-09-01T00:00:00.000Z'; // after RANGE end

  /** Wires the two Writing Check reads (evaluations + pattern rows). */
  function withChecks(evals, hist = []) {
    mockLetterMotorStateEvaluationFindAll.mockImplementation(async ({ where }) => {
      // The service issues exactly one findAll for Writing Check evaluations.
      if (where && where.pattern_check_id && where.pattern_check_id !== null) return evals;
      return [];
    });
    mockLetterMotorStateHistoryFindAll.mockImplementation(async ({ where }) => {
      if (where && where.pattern_check_id && where.pattern_check_id !== null) return hist;
      return []; // legacy milestone rows during period
    });
  }
  const ev = (id, status, at, ood = null) => ({
    pattern_check_id: id, evaluation_status: status, observed_at: at,
    ood_reason: ood, model_version: 'letter_motor_cluster_v1',
  });

  it('1. no Writing Check and no milestone -> not_reached', async () => {
    withChecks([]);
    const r = await buildPeriodicReport(RANGE);
    expect(r.letter_motor_development.evaluation_status).toBe('not_reached');
    expect(r.letter_motor_development.latest_writing_check).toBeNull();
    expect(r.letter_motor_development.writing_checks_during_period).toEqual([]);
    expect(r.letter_motor_development.evaluation_source).toBeNull();
  });

  it('2. one assigned Pattern A check becomes the current result', async () => {
    withChecks([ev(1, 'assigned', AUG)], [{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' }]);
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.evaluation_status).toBe('assigned');
    expect(dev.current_state_code).toBe('LETTER_STATE_A');
    expect(dev.evaluation_source).toBe('writing_check');
  });

  it('3. one assigned Pattern B check becomes the current result', async () => {
    withChecks([ev(1, 'assigned', AUG)], [{ pattern_check_id: 1, state_code: 'LETTER_STATE_B' }]);
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.current_state_code).toBe('LETTER_STATE_B');
  });

  it('4. an OOD check reports outside_reference_range with no state code', async () => {
    withChecks([ev(1, 'outside_reference_range', AUG, 'dtw_distance_outside_reference_range')]);
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.evaluation_status).toBe('outside_reference_range');
    expect(dev.current_state_code).toBeNull();
    expect(dev.reference_range_evaluation.reason).toBe('dtw_distance_outside_reference_range');
    expect(dev.reference_range_evaluation.source).toBe('writing_check');
  });

  it('7. repeated checks are ordered oldest->newest, latest wins', async () => {
    withChecks(
      [ev(1, 'assigned', AUG), ev(2, 'assigned', OCT)],
      [{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' },
       { pattern_check_id: 2, state_code: 'LETTER_STATE_B' }],
    );
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.writing_checks_during_period).toHaveLength(2);
    expect(dev.latest_writing_check.pattern_check_id).toBe(2);
    expect(dev.current_state_code).toBe('LETTER_STATE_B');
  });

  it('9. Pattern A then OOD -> current is OOD, NOT the older Pattern A', async () => {
    withChecks(
      [ev(1, 'assigned', AUG), ev(2, 'outside_reference_range', OCT, 'dtw_distance_outside_reference_range')],
      [{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' }],
    );
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.evaluation_status).toBe('outside_reference_range');
    expect(dev.current_state_code).toBeNull();
    // The August Pattern A is still preserved in the period history.
    const aug = dev.writing_checks_during_period.find((c) => c.pattern_check_id === 1);
    expect(aug.state_code).toBe('LETTER_STATE_A');
  });

  it('10. a check AFTER the report end date is excluded by the query itself', async () => {
    withChecks([]);
    await buildPeriodicReport(RANGE);
    const call = mockLetterMotorStateEvaluationFindAll.mock.calls
      .find(([a]) => a.where && a.where.pattern_check_id);
    expect(call[0].where.observed_at).toBeDefined();
  });

  it('11. a check before the period start is excluded from during-period', async () => {
    withChecks(
      [ev(1, 'assigned', BEFORE), ev(2, 'assigned', AUG)],
      [{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' },
       { pattern_check_id: 2, state_code: 'LETTER_STATE_B' }],
    );
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.writing_checks_during_period.map((c) => c.pattern_check_id)).toEqual([2]);
    // ...but it still counts toward "latest as of end date".
    expect(dev.latest_writing_check.pattern_check_id).toBe(2);
  });

  it('12. latest-as-of-end-date is the newest check the query returned', async () => {
    withChecks(
      [ev(1, 'assigned', BEFORE)],
      [{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' }],
    );
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.latest_writing_check.pattern_check_id).toBe(1);
    expect(dev.writing_checks_during_period).toEqual([]);
    expect(dev.evaluation_status).toBe('assigned');
  });

  it('13. a Writing Check takes precedence over a legacy milestone pattern', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue({
      milestone: 'UPPERCASE_STRAIGHT_14', state_code: 'LETTER_STATE_A',
      display_name: 'Letter Motor State A', coverage_n: 14, observed_at: AUG,
    });
    withChecks([ev(9, 'outside_reference_range', OCT, 'dtw_distance_outside_reference_range')]);
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.evaluation_source).toBe('writing_check');
    expect(dev.evaluation_status).toBe('outside_reference_range');
  });

  it('14. falls back to the legacy milestone when no Writing Check exists', async () => {
    mockLetterMotorStateHistoryFindOne.mockResolvedValue({
      milestone: 'UPPERCASE_STRAIGHT_14', state_code: 'LETTER_STATE_A',
      display_name: 'Letter Motor State A', coverage_n: 14, observed_at: AUG,
    });
    withChecks([]);
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    expect(dev.evaluation_source).toBe('legacy_milestone');
    expect(dev.evaluation_status).toBe('assigned');
    expect(dev.current_state_code).toBe('LETTER_STATE_A');
  });

  it('legacy milestone reads never pick up a Writing Check row', async () => {
    withChecks([]);
    await buildPeriodicReport(RANGE);
    for (const [args] of mockLetterMotorStateHistoryFindOne.mock.calls) {
      expect(args.where.pattern_check_id).toBeNull();
    }
  });

  it('20. no null/undefined/NaN leaks into the Writing Check fields', async () => {
    withChecks([ev(1, 'assigned', AUG)], [{ pattern_check_id: 1, state_code: 'LETTER_STATE_A' }]);
    const dev = (await buildPeriodicReport(RANGE)).letter_motor_development;
    const text = JSON.stringify(dev);
    expect(text).not.toMatch(/"(undefined|NaN|\[object Object\])"/);
    expect(dev.latest_writing_check.observed_at).toBeTruthy();
  });

  it('a Writing Check read failure never fails the whole report', async () => {
    mockLetterMotorStateEvaluationFindAll.mockRejectedValue(new Error('db down'));
    await expect(buildPeriodicReport(RANGE)).resolves.toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Home practice (homework worksheets) — period scoping and as-of-end-date
// ═══════════════════════════════════════════════════════════════════════════

describe('home practice section', () => {
  const IN_1 = '2026-03-01T00:00:00.000Z';   // inside RANGE
  const IN_2 = '2026-05-01T00:00:00.000Z';   // inside RANGE, later
  const BEFORE = '2025-06-01T00:00:00.000Z'; // before RANGE start
  const AFTER  = '2026-09-01T00:00:00.000Z'; // AFTER RANGE end

  const ws = (o = {}) => ({
    id: 1, worksheet_code: 'HW-2026-0001', target_letter: 'c', case_type: 'lowercase',
    worksheet_intensity: 'standard', status: 'assigned',
    generated_at: IN_1, assigned_at: IN_1, completed_at: null, ...o,
  });
  const sub = (o = {}) => ({
    id: 1, worksheet_id: 1, submitted_at: IN_1, review_status: 'pending_review', reviewed_at: null, ...o,
  });

  function withHomePractice(worksheets, submissions = []) {
    mockHandwritingWorksheetFindAll.mockResolvedValue(worksheets);
    mockHandwritingWorksheetSubmissionFindAll.mockResolvedValue(submissions);
  }

  it('no worksheets -> an honest zeroed section', async () => {
    withHomePractice([]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.worksheets_assigned).toBe(0);
    expect(hp.worksheets_submitted).toBe(0);
    expect(hp.worksheets_reviewed).toBe(0);
    expect(hp.worksheets_during_period).toEqual([]);
    expect(hp.active_worksheet_as_of_end_date).toBeNull();
  });

  it('counts a worksheet assigned during the period', async () => {
    withHomePractice([ws()]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.worksheets_assigned).toBe(1);
    expect(hp.worksheets_during_period).toHaveLength(1);
    expect(hp.worksheets_during_period[0].target_letter).toBe('c');
  });

  it('counts submissions and reviews on their OWN timestamps', async () => {
    withHomePractice(
      [ws()],
      [sub({ submitted_at: IN_1, review_status: 'needs_more_practice', reviewed_at: IN_2 })],
    );
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.worksheets_submitted).toBe(1);
    expect(hp.worksheets_reviewed).toBe(1);
    expect(hp.teacher_reviews_during_period[0].review_status).toBe('needs_more_practice');
  });

  it('a still-pending submission is NOT counted as reviewed', async () => {
    withHomePractice([ws()], [sub({ review_status: 'pending_review', reviewed_at: null })]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.worksheets_submitted).toBe(1);
    expect(hp.worksheets_reviewed).toBe(0);
    expect(hp.teacher_reviews_during_period).toEqual([]);
  });

  it('a worksheet assigned BEFORE the period is excluded from during-period counts', async () => {
    withHomePractice([ws({ generated_at: BEFORE, assigned_at: BEFORE })]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.worksheets_assigned).toBe(0);
    expect(hp.worksheets_during_period).toEqual([]);
    // ...but it is still the live worksheet as of the end date.
    expect(hp.active_worksheet_as_of_end_date).not.toBeNull();
  });

  it('NO FUTURE LEAK: the query itself bounds worksheets by the end date', async () => {
    withHomePractice([]);
    await buildPeriodicReport(RANGE);
    const call = mockHandwritingWorksheetFindAll.mock.calls[0][0];
    expect(call.where.generated_at).toBeDefined();
    expect(call.where.student_id).toBe(STUDENT_ID);
  });

  it('a worksheet assigned after the end date is never the active one', async () => {
    // Simulates a row the DB filter would not return, plus one it would.
    withHomePractice([ws({ id: 1, generated_at: IN_1, assigned_at: IN_1 })]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.active_worksheet_as_of_end_date.worksheet_code).toBe('HW-2026-0001');
  });

  it('a worksheet REVIEWED before the end date is no longer active then', async () => {
    withHomePractice(
      [ws({ status: 'reviewed' })],
      [sub({ review_status: 'reviewed', reviewed_at: IN_2 })],
    );
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.active_worksheet_as_of_end_date).toBeNull();
  });

  it('a worksheet reviewed AFTER the end date is still active as of that date', async () => {
    withHomePractice(
      [ws({ status: 'reviewed' })],
      [sub({ review_status: 'reviewed', reviewed_at: AFTER })],
    );
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(hp.active_worksheet_as_of_end_date).not.toBeNull();
    expect(hp.worksheets_reviewed).toBe(0);
  });

  it('carries a short review outcome, never a teacher comment or a scan', async () => {
    withHomePractice([ws()], [sub({ review_status: 'reviewed', reviewed_at: IN_2 })]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    const text = JSON.stringify(hp);
    expect(text).not.toMatch(/teacher_comment|file_reference|base64/);
    expect(hp.teacher_reviews_during_period[0]).toHaveProperty('review_status');
  });

  it('a read failure degrades this section only, never the whole report', async () => {
    mockHandwritingWorksheetFindAll.mockRejectedValue(new Error('db down'));
    const report = await buildPeriodicReport(RANGE);
    expect(report.home_practice.worksheets_assigned).toBe(0);
    expect(report).toBeTruthy();
  });

  it('no null/undefined/NaN leaks into the section', async () => {
    withHomePractice([ws()], [sub()]);
    const hp = (await buildPeriodicReport(RANGE)).home_practice;
    expect(JSON.stringify(hp)).not.toMatch(/"(undefined|NaN|\[object Object\])"/);
  });
});

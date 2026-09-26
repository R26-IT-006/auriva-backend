'use strict';

// Feature 11B Phase 5 — the 5 new handwritingController read endpoints
// verified in isolation. teacherService, letterMotorMasteryService, and
// letterCategoryCompletionService are mocked, mirroring
// tests/getPersistentDifficultyEndpoint.test.js's exact convention.

const mockGetOwnStudentById = jest.fn();
const mockGetLatestState  = jest.fn();
const mockGetStateHistory = jest.fn();
const mockGetTrend        = jest.fn();
const mockGetMastered     = jest.fn();
const mockGetCategoryStatus = jest.fn();
const mockGetEvaluations = jest.fn();
const mockGetLatestEvaluation = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/letterMotorMasteryService', () => ({
  getLatestLetterMotorState:  (...a) => mockGetLatestState(...a),
  getLetterMotorStateHistory: (...a) => mockGetStateHistory(...a),
  getMasteryEvidenceTrend:    (...a) => mockGetTrend(...a),
  getLetterMotorEvaluations:  (...a) => mockGetEvaluations(...a),
  getLatestLetterMotorEvaluation: (...a) => mockGetLatestEvaluation(...a),
}));

jest.mock('../src/services/letterCategoryCompletionService', () => ({
  getMasteredLetterPairs:          (...a) => mockGetMastered(...a),
  getAllCategoryCompletionStatus:  (...a) => mockGetCategoryStatus(...a),
}));

const {
  getLatestLetterMotorState, getLetterMotorStateHistory, getLetterMotorEvidenceTrend,
  getMasteredLetters, getCategoryCompletionStatus, getLetterMotorEvaluations,
} = require('../src/controllers/handwritingController');
const ApiError = require('../src/utils/ApiError');

const STUDENT_ID = 9;

function makeReq(studentId = String(STUDENT_ID)) {
  return { user: { id: 7 }, params: { studentId } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_ID, teacher_id: 7 });
});

describe('getLatestLetterMotorState', () => {
  it('200s with the found result', async () => {
    mockGetLatestState.mockResolvedValueOnce({ status: 'found', result: { id: 1 } });
    const res = makeRes();
    await getLatestLetterMotorState(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', result: { id: 1 } });
  });

  it('404s when not found', async () => {
    mockGetLatestState.mockResolvedValueOnce({ status: 'not_found', result: null });
    const res = makeRes();
    await getLatestLetterMotorState(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('422s on invalid student id, before ownership check', async () => {
    await expect(getLatestLetterMotorState(makeReq('abc'), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('404s on unowned student, service never runs', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(getLatestLetterMotorState(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetLatestState).not.toHaveBeenCalled();
  });

  it('500s on read_failed', async () => {
    mockGetLatestState.mockResolvedValueOnce({ status: 'read_failed', result: null });
    await expect(getLatestLetterMotorState(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe('getLetterMotorStateHistory — Teacher-report read never triggers prediction', () => {
  it('200s with results, and the service call is the ONLY thing invoked (no milestone-check import exists in this controller path)', async () => {
    mockGetStateHistory.mockResolvedValueOnce({ status: 'found', results: [{ id: 1 }, { id: 2 }] });
    const res = makeRes();
    await getLetterMotorStateHistory(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', results: [{ id: 1 }, { id: 2 }] });
    expect(mockGetStateHistory).toHaveBeenCalledTimes(1);
  });

  it('the controller source for this handler never references checkAndTriggerMilestones or predictLetterMotorState', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getLetterMotorStateHistory[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/checkAndTriggerMilestones|predictLetterMotorState|onLetterMastered/);
  });

  it('422s on invalid student id', async () => {
    await expect(getLetterMotorStateHistory(makeReq('0'), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('getLetterMotorEvidenceTrend', () => {
  it('200s with the descriptive trend fields', async () => {
    mockGetTrend.mockResolvedValueOnce({ status: 'found', coverageN: 7, meanSmoothness: 65, meanDtw: 12, meanSpeedCv: 0.3 });
    const res = makeRes();
    await getLetterMotorEvidenceTrend(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', coverageN: 7, meanSmoothness: 65, meanDtw: 12, meanSpeedCv: 0.3 });
  });
});

describe('getMasteredLetters — normal-progression fix endpoint', () => {
  it('200s with the authoritative mastered pairs', async () => {
    mockGetMastered.mockResolvedValueOnce({ status: 'found', pairs: [{ letter: 'l', caseType: 'lowercase' }] });
    const res = makeRes();
    await getMasteredLetters(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', pairs: [{ letter: 'l', caseType: 'lowercase' }] });
  });

  it('is ownership-protected like every other student-scoped endpoint', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(getMasteredLetters(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetMastered).not.toHaveBeenCalled();
  });
});

describe('getCategoryCompletionStatus', () => {
  it('200s with the 6-category rollup', async () => {
    const categories = [{ caseType: 'lowercase', category: 'straight', complete: true }];
    mockGetCategoryStatus.mockResolvedValueOnce({ status: 'found', categories });
    const res = makeRes();
    await getCategoryCompletionStatus(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', categories });
  });
});

// ─── S2 — milestone evaluation log endpoint ────────────────────────────────

describe('getLetterMotorEvaluations', () => {
  it('200s with the evaluation log and the latest event', async () => {
    const rows = [{ id: 1, milestone: 'UPPERCASE_STRAIGHT_14', evaluation_status: 'outside_reference_range' }];
    mockGetEvaluations.mockResolvedValueOnce({ status: 'found', results: rows });
    mockGetLatestEvaluation.mockResolvedValueOnce({ status: 'found', result: rows[0] });
    const res = makeRes();
    await getLetterMotorEvaluations(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', results: rows, latest: rows[0] });
  });

  it('200s with an empty log and a null latest for a student with no evaluations', async () => {
    mockGetEvaluations.mockResolvedValueOnce({ status: 'found', results: [] });
    mockGetLatestEvaluation.mockResolvedValueOnce({ status: 'not_found', result: null });
    const res = makeRes();
    await getLetterMotorEvaluations(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', results: [], latest: null });
  });

  it('enforces teacher ownership before reading anything', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(403, 'Not your student'));
    await expect(getLetterMotorEvaluations(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 403 });
    expect(mockGetEvaluations).not.toHaveBeenCalled();
  });

  it('422s on an invalid student id', async () => {
    await expect(getLetterMotorEvaluations(makeReq('0'), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });

  it('500s rather than reporting a read failure as "no evaluations"', async () => {
    mockGetEvaluations.mockResolvedValueOnce({ status: 'read_failed', results: [] });
    mockGetLatestEvaluation.mockResolvedValueOnce({ status: 'read_failed', result: null });
    await expect(getLetterMotorEvaluations(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 500 });
  });

  it('never triggers a prediction — the controller only calls read services', () => {
    const src = require('fs').readFileSync(
      require.resolve('../src/controllers/handwritingController.js'), 'utf8');
    const fn = src.slice(
      src.indexOf('async function getLetterMotorEvaluations('),
      src.indexOf('async function getLetterMotorEvidenceTrend('),
    );
    expect(fn).not.toMatch(/predict|checkAndTriggerMilestones|onLetterMastered/);
  });
});

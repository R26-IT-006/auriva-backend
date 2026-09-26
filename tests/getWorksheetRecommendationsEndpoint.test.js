'use strict';

// Feature 8 Step 3 — GET /handwriting/worksheet-recommendations/:studentId
// (handwritingController.getWorksheetRecommendations) verified in
// isolation. teacherService and worksheetRecommendationService are mocked
// — the controller itself duplicates none of evaluateWorksheetRecommendations'
// logic. Mirrors tests/getPersistentDifficultyEndpoint.test.js's exact
// convention.
const mockGetOwnStudentById = jest.fn();
const mockEvaluateWorksheetRecommendations = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/worksheetRecommendationService', () => ({
  evaluateWorksheetRecommendations: (...a) => mockEvaluateWorksheetRecommendations(...a),
}));

const { getWorksheetRecommendations } = require('../src/controllers/handwritingController');

function makeReq({ studentId = '13', userId = 14 } = {}) {
  return { params: { studentId }, user: { id: userId } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeRecommendation(overrides = {}) {
  return {
    recommendationType: 'motor_family_practice',
    caseType: 'lowercase', family: 'curved',
    title: 'Curved Movement Practice',
    focusLetters: ['c', 'o'],
    rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods. The pattern was observed in both the earlier and recent practice periods.',
    suggestedActivities: ['Circle tracing exercises', 'Half-circle tracing with visual guides', 'Slow curved-stroke repetition', 'Guided tracing of focus letters', 'Independent writing of focus letters'],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    status: 'evaluated', studentId: 13, evaluatedAt: '2026-08-14T00:00:00.000Z',
    recommendations: [],
    summary: { evaluatedStreamCount: 6, persistentStreamCount: 0, notPersistentCount: 0, insufficientDataCount: 6, recommendationCount: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  // mockReset (not clearAllMocks): Item 25 queues a mockImplementationOnce
  // that is deliberately never consumed (ownership rejects before the
  // service is ever called) — clearAllMocks() would leave that queued
  // "Once" implementation to leak into whichever later test next calls the
  // mock. mockReset() also discards any queued implementation, not just
  // the call-history, so every test starts from a clean queue.
  mockGetOwnStudentById.mockReset();
  mockEvaluateWorksheetRecommendations.mockReset();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

// ─── Item 23 — owned student -> 200 ─────────────────────────────────────────

describe('Item 23 — owned student returns 200 with the service result', () => {
  it('passes through status/studentId/evaluatedAt/recommendations/summary', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'evaluated', studentId: 13 }));
  });
});

// ─── Item 24 — unowned -> 404 ────────────────────────────────────────────────

describe('Item 24 — unowned student -> 404', () => {
  it('rejects a student not owned by the requesting teacher, before the service is ever called', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getWorksheetRecommendations(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockEvaluateWorksheetRecommendations).not.toHaveBeenCalled();
  });
});

// ─── Item 25 — ownership checked before service ────────────────────────────

describe('Item 25 — ownership checked before the service call', () => {
  it('getOwnStudentById runs before evaluateWorksheetRecommendations', async () => {
    const ApiError = require('../src/utils/ApiError');
    const callOrder = [];
    mockGetOwnStudentById.mockImplementationOnce(async () => { callOrder.push('ownership'); throw new ApiError(404, 'not found'); });
    mockEvaluateWorksheetRecommendations.mockImplementationOnce(async () => { callOrder.push('service'); return makeResult(); });

    const res = makeRes();
    await expect(getWorksheetRecommendations(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(callOrder).toEqual(['ownership']);
  });
});

// ─── Item 26 — invalid student id -> 422 ────────────────────────────────────

describe('Item 26 — invalid student id -> 422', () => {
  it.each(['abc', '0', '-1', '1.5', ''])('rejects studentId=%p before the ownership check even runs', async (bad) => {
    const res = makeRes();
    await expect(getWorksheetRecommendations(makeReq({ studentId: bad }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });
});

// ─── Item 27 — read_failed -> 500 ───────────────────────────────────────────

describe('Item 27 — read_failed -> 500', () => {
  it('a service read_failed status becomes a 500 ApiError, never fabricated zero recommendations', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, evaluatedAt: null, recommendations: null, summary: null });
    const res = makeRes();
    await expect(getWorksheetRecommendations(makeReq(), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Item 28 — one recommendation response shape ───────────────────────────

describe('Item 28 — one-recommendation response shape', () => {
  it('carries the full recommendation object through unchanged', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({
      recommendations: [makeRecommendation()],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 0, insufficientDataCount: 5, recommendationCount: 1 },
    }));
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.recommendations).toHaveLength(1);
    expect(payload.recommendations[0]).toEqual(makeRecommendation());
  });
});

// ─── Item 29 — zero recommendation response shape ──────────────────────────

describe('Item 29 — zero-recommendation response shape', () => {
  it('recommendations=[], summary.recommendationCount=0', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.recommendations).toEqual([]);
    expect(payload.summary.recommendationCount).toBe(0);
  });
});

// ─── Item 30 — two recommendation response shape ───────────────────────────

describe('Item 30 — two-recommendation response shape', () => {
  it('both recommendations pass through, correctly ordered', async () => {
    const second = makeRecommendation({ caseType: 'uppercase', family: 'straight', title: 'Straight Movement Practice', focusLetters: ['I'] });
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({
      recommendations: [makeRecommendation(), second],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 2, notPersistentCount: 0, insufficientDataCount: 4, recommendationCount: 2 },
    }));
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.recommendations).toHaveLength(2);
    expect(payload.recommendations[0].family).toBe('curved');
    expect(payload.recommendations[1].family).toBe('straight');
  });
});

// ─── Item 31 — summary correct ──────────────────────────────────────────────

describe('Item 31 — summary passed through unchanged', () => {
  it('summary counts match the service result exactly', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 2, notPersistentCount: 1, insufficientDataCount: 3, recommendationCount: 2 },
    }));
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.summary).toEqual({ evaluatedStreamCount: 6, persistentStreamCount: 2, notPersistentCount: 1, insufficientDataCount: 3, recommendationCount: 2 });
  });
});

// ─── Item 32 — no raw Feature 7 diagnostics leaked ─────────────────────────

describe('Item 32 — no raw Feature 7 diagnostics leaked', () => {
  it('the response never contains separationMs, windowSize, validCycleCount, or a raw streams object', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({ recommendations: [makeRecommendation()] }));
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('streams');
    const blob = JSON.stringify(payload);
    expect(blob).not.toMatch(/separationMs|windowSize|validCycleCount|usableCycleCount|requiredSeparationMs/i);
  });
});

// ─── Item 33 — no raw attempt fields ────────────────────────────────────────

describe('Item 33 — no raw attempt fields', () => {
  it('the response never contains stroke_points, normalized_features, features, session_key, attempt_number, threshold, or best_score', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({ recommendations: [makeRecommendation()] }));
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const blob = JSON.stringify(res.json.mock.calls[0][0]);
    expect(blob).not.toMatch(/stroke_points|normalized_features|"features"|session_key|attempt_number|"threshold"|best_score/i);
  });
});

// ─── Item 34 — service invoked once ─────────────────────────────────────────

describe('Item 34 — service invoked once', () => {
  it('evaluateWorksheetRecommendations is called exactly once, with exactly {studentId}', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    expect(mockEvaluateWorksheetRecommendations).toHaveBeenCalledTimes(1);
    expect(mockEvaluateWorksheetRecommendations).toHaveBeenCalledWith({ studentId: 13 });
  });
});

// ─── Item 35 — controller contains no mapping/building logic ──────────────

describe('Item 35 — controller contains no recommendation-building logic', () => {
  it('the handler source (comment-stripped) never references buildWorksheetRecommendation/getWorksheetRecommendationTemplate/evaluatePersistentDifficulty directly', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getWorksheetRecommendations[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/buildWorksheetRecommendation|getWorksheetRecommendationTemplate|evaluatePersistentDifficulty\(/);
  });
});

// ─── Item 36 — no writes ────────────────────────────────────────────────────

describe('Item 36 — endpoint performs no writes', () => {
  it('the handler source (comment-stripped) has zero write-method references', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getWorksheetRecommendations[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(/);
  });
});

// ─── Top-level response shape ───────────────────────────────────────────────

describe('Top-level response shape', () => {
  it('has exactly the 5 documented fields', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getWorksheetRecommendations(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['evaluatedAt', 'recommendations', 'status', 'studentId', 'summary'].sort());
  });
});

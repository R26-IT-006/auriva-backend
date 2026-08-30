'use strict';

// Feature 7 Step 3 — GET /handwriting/persistent-difficulty/:studentId
// (handwritingController.getPersistentDifficulty) verified in isolation.
// teacherService and persistentDifficultyService are mocked — the
// controller itself duplicates none of evaluatePersistentDifficulty's
// logic. Mirrors tests/getDemoSpeedRecommendationEndpoint.test.js's exact
// convention.
const mockGetOwnStudentById = jest.fn();
const mockEvaluatePersistentDifficulty = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/persistentDifficultyService', () => ({
  evaluatePersistentDifficulty: (...a) => mockEvaluatePersistentDifficulty(...a),
}));

const { getPersistentDifficulty } = require('../src/controllers/handwritingController');

function makeReq({ studentId = '13', userId = 14 } = {}) {
  return { params: { studentId }, user: { id: userId } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeStream(overrides = {}) {
  return {
    caseType: 'lowercase', family: 'straight',
    status: 'insufficient_data', reason: 'insufficient_cycles',
    validCycleCount: 2, usableCycleCount: 2, windowSize: 5, requiredSeparationMs: 86400000,
    earlierWindow: null, recentWindow: null, separationMs: null,
    affectedLetters: [],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    status: 'evaluated', studentId: 13, evaluatedAt: '2026-08-13T00:00:00.000Z',
    streams: {
      lowercase: { straight: makeStream(), curved: makeStream({ family: 'curved' }), complex: makeStream({ family: 'complex' }) },
      uppercase: { straight: makeStream({ caseType: 'uppercase' }), curved: makeStream({ caseType: 'uppercase', family: 'curved' }), complex: makeStream({ caseType: 'uppercase', family: 'complex' }) },
    },
    summary: { evaluatedStreamCount: 6, persistentCount: 0, notPersistentCount: 0, insufficientDataCount: 6, persistentStreams: [] },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

// ─── Test 1 — owned student -> 200 ──────────────────────────────────────────

describe('Test 1 — owned student returns 200 with the service result', () => {
  it('passes through status/studentId/evaluatedAt/streams/summary', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'evaluated', studentId: 13 }));
  });
});

// ─── Test 2 — unowned -> 404 ─────────────────────────────────────────────────

describe('Test 2 — unowned student -> 404', () => {
  it('rejects a student not owned by the requesting teacher, before the service is ever called', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getPersistentDifficulty(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockEvaluatePersistentDifficulty).not.toHaveBeenCalled();
  });
});

// ─── Test 3 — invalid student id -> 422 ─────────────────────────────────────

describe('Test 3 — invalid student id -> 422', () => {
  it.each(['abc', '0', '-1', '1.5', ''])('rejects studentId=%p before the ownership check even runs', async (bad) => {
    const res = makeRes();
    await expect(getPersistentDifficulty(makeReq({ studentId: bad }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });
});

// ─── Test 4 — service read_failed -> 500 ────────────────────────────────────

describe('Test 4 — read_failed -> 500', () => {
  it('a service read_failed status becomes a 500 ApiError, never an unhandled crash or fabricated streams', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, evaluatedAt: null, streams: null, summary: null });
    const res = makeRes();
    await expect(getPersistentDifficulty(makeReq(), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Test 5 — persistent response schema ────────────────────────────────────

describe('Test 5 — persistent response schema', () => {
  it('a persistent stream is passed through with its full window/affectedLetters shape', async () => {
    const persistentStream = makeStream({
      family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      validCycleCount: 10, usableCycleCount: 10,
      earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' },
      separationMs: 172800000,
      affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 5 }, { letter: 'o', totalCycles: 4, failedCycles: 4 }],
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult({
      streams: { lowercase: { straight: makeStream(), curved: persistentStream, complex: makeStream({ family: 'complex' }) },
                 uppercase: { straight: makeStream({ caseType: 'uppercase' }), curved: makeStream({ caseType: 'uppercase', family: 'curved' }), complex: makeStream({ caseType: 'uppercase', family: 'complex' }) } },
      summary: { evaluatedStreamCount: 6, persistentCount: 1, notPersistentCount: 0, insufficientDataCount: 5, persistentStreams: [{ caseType: 'lowercase', family: 'curved' }] },
    }));
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.streams.lowercase.curved.status).toBe('persistent');
    expect(payload.streams.lowercase.curved.affectedLetters).toEqual([
      { letter: 'c', totalCycles: 6, failedCycles: 5 }, { letter: 'o', totalCycles: 4, failedCycles: 4 },
    ]);
    expect(payload.summary.persistentStreams).toEqual([{ caseType: 'lowercase', family: 'curved' }]);
  });
});

// ─── Test 6 — insufficient response schema ──────────────────────────────────

describe('Test 6 — insufficient response schema', () => {
  it('an insufficient_cycles stream carries validCycleCount/usableCycleCount and null windows', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    const stream = payload.streams.lowercase.straight;
    expect(stream.status).toBe('insufficient_data');
    expect(stream.reason).toBe('insufficient_cycles');
    expect(stream.earlierWindow).toBeNull();
    expect(stream.recentWindow).toBeNull();
    expect(stream.validCycleCount).toBe(2);
  });
});

// ─── Test 7 — summary counts correct ────────────────────────────────────────

describe('Test 7 — summary counts correct', () => {
  it('summary counts pass through unchanged from the service result', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult({
      summary: { evaluatedStreamCount: 6, persistentCount: 2, notPersistentCount: 1, insufficientDataCount: 3, persistentStreams: [] },
    }));
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.summary).toEqual({ evaluatedStreamCount: 6, persistentCount: 2, notPersistentCount: 1, insufficientDataCount: 3, persistentStreams: [] });
  });
});

// ─── Test 8 — no raw attempts leaked ────────────────────────────────────────

describe('Test 8 — no raw attempts leaked', () => {
  it('the response never contains stroke_points, raw features JSON, session keys, or database attempt IDs', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    const payloadJson = JSON.stringify(res.json.mock.calls[0][0]);
    expect(payloadJson).not.toMatch(/stroke_points|normalized_features|session_key|sessionKey|attemptId/i);
  });

  it('the top-level response has exactly the 5 documented fields', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['evaluatedAt', 'status', 'streams', 'studentId', 'summary'].sort());
  });
});

// ─── Test 9 — service invoked once ──────────────────────────────────────────

describe('Test 9 — service invoked once', () => {
  it('evaluatePersistentDifficulty is called exactly once, with exactly {studentId}', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPersistentDifficulty(makeReq(), res);
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledTimes(1);
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledWith({ studentId: 13 });
  });
});

// ─── Test 10 — ownership check before service ───────────────────────────────

describe('Test 10 — ownership check happens before the service call', () => {
  it('getOwnStudentById is called before evaluatePersistentDifficulty, and the service never runs if ownership fails', async () => {
    const ApiError = require('../src/utils/ApiError');
    const callOrder = [];
    mockGetOwnStudentById.mockImplementationOnce(async () => { callOrder.push('ownership'); throw new ApiError(404, 'not found'); });
    mockEvaluatePersistentDifficulty.mockImplementationOnce(async () => { callOrder.push('service'); return makeResult(); });

    const res = makeRes();
    await expect(getPersistentDifficulty(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(callOrder).toEqual(['ownership']);
  });
});

// ─── Read-only / no-write source-scan (mirrors Feature 6's own precedent) ──

describe('Endpoint performs no writes', () => {
  it('the controller source (excluding comments) never references a write call for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getPersistentDifficulty[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(/);
  });

  it('the controller source (excluding comments) never duplicates evidence/decision logic directly for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getPersistentDifficulty[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/buildFamilyCaseEvidence|splitLongitudinalWindows|evaluatePersistentDifficultyWindows|getBaselineFamily/);
  });
});

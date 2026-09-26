'use strict';

// Feature 5 Step 3 — GET /handwriting/repetition-recommendation/:studentId/:letter/:caseType
// (handwritingController.getRepetitionRecommendation) verified in
// isolation. teacherService and repetitionRecommendationService are
// mocked — the controller itself duplicates none of
// evaluateRepetitionRecommendation's logic. Mirrors
// tests/getPreWritingRecommendationEndpoint.test.js's exact convention.
const mockGetOwnStudentById = jest.fn();
const mockEvaluateRepetitionRecommendation = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/repetitionRecommendationService', () => ({
  evaluateRepetitionRecommendation: (...a) => mockEvaluateRepetitionRecommendation(...a),
}));

const { getRepetitionRecommendation } = require('../src/controllers/handwritingController');

function makeReq({ studentId = '13', letter = 'c', caseType = 'lowercase', userId = 14, query = {} } = {}) {
  return { params: { studentId, letter, caseType }, query, user: { id: userId } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13, letter: 'c', caseType: 'lowercase',
    family: 'curved', shouldRepeat: false, reason: 'insufficient_data',
    signals: { feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' },
    policy: { maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 0, remainingAdaptiveRepetitions: 1 },
    history: { totalCycles: 1, cleanCycles: 1, malformedCycles: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

// ─── Test 1/2/3 — mapped families ──────────────────────────────────────────

describe('Test 1 — reviewed straight letter', () => {
  it('passes family=straight through', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({ letter: 'l', family: 'straight' }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'l' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'straight' }));
  });
});

describe('Test 2 — reviewed curved letter', () => {
  it('passes family=curved through', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'curved' }));
  });
});

describe('Test 3 — reviewed complex letter', () => {
  it('passes family=complex through', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({ letter: 'v', family: 'complex' }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'v' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'complex' }));
  });
});

// ─── Test 4 — ambiguous ──────────────────────────────────────────────────────

describe('Test 4 — ambiguous letter -> not_applicable', () => {
  it('passes through not_applicable with null family/signals/policy/history', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      letter: 'a', family: null, shouldRepeat: false, reason: 'not_applicable', signals: null, policy: null, history: null,
    }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'a' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: null, reason: 'not_applicable', policy: null, history: null }));
  });
});

// ─── Test 5/6 — no-trigger reasons ──────────────────────────────────────────

describe('Test 5 — insufficient_data', () => {
  it('shouldRepeat=false', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({ reason: 'insufficient_data' }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ shouldRepeat: false, reason: 'insufficient_data' }));
  });
});

describe('Test 6 — no_persistent_difficulty', () => {
  it('shouldRepeat=false even though both signals completed', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      reason: 'no_persistent_difficulty',
      signals: { feature2Decision: 'hold', feature3Decision: 'recommend_high' },
    }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ shouldRepeat: false, reason: 'no_persistent_difficulty' }));
  });
});

// ─── Test 7/8/9 — trigger signals ───────────────────────────────────────────

describe('Test 7 — Feature 2 support_review', () => {
  it('shouldRepeat=true, reason=feature2_support_review', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      shouldRepeat: true, reason: 'feature2_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'insufficient_data' },
    }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ shouldRepeat: true, reason: 'feature2_support_review' }));
  });
});

describe('Test 8 — Feature 3 support_review', () => {
  it('shouldRepeat=true, reason=feature3_support_review', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      shouldRepeat: true, reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ shouldRepeat: true, reason: 'feature3_support_review' }));
  });
});

describe('Test 9 — both review, Feature 3 reason passed through as-is', () => {
  it('never recomputes priority in the controller — trusts the service result verbatim', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      shouldRepeat: true, reason: 'feature3_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'support_review' },
    }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'feature3_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'support_review' },
    }));
  });
});

// ─── Test 10 — cap_reached ───────────────────────────────────────────────────

describe('Test 10 — cap_reached', () => {
  it('shouldRepeat=false, signals/history null, policy shows the used/remaining counts', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      shouldRepeat: false, reason: 'cap_reached', signals: null, history: null,
      policy: { maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 1, remainingAdaptiveRepetitions: 0 },
    }));
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c', query: { adaptiveRepetitionsUsed: '1' } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cap_reached', signals: null, history: null }));
  });
});

// ─── Test 11/12/13 — adaptiveRepetitionsUsed query parsing ─────────────────

describe('Test 11 — adaptiveRepetitionsUsed query parsing', () => {
  it('parses a valid query value and forwards it to the service', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c', query: { adaptiveRepetitionsUsed: '1' } }), res);
    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledWith(expect.objectContaining({ adaptiveRepetitionsUsed: 1 }));
  });

  it('defaults to 0 when the query parameter is omitted', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);
    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledWith(expect.objectContaining({ adaptiveRepetitionsUsed: 0 }));
  });
});

describe('Test 12 — invalid negative adaptiveRepetitionsUsed', () => {
  it('rejects a negative value with a 422 ApiError', async () => {
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ letter: 'c', query: { adaptiveRepetitionsUsed: '-1' } }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockEvaluateRepetitionRecommendation).not.toHaveBeenCalled();
  });
});

describe('Test 13 — invalid fractional adaptiveRepetitionsUsed', () => {
  it.each(['1.5', 'abc', ''])('rejects a non-integer value %p with a 422 ApiError', async (badValue) => {
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ letter: 'c', query: { adaptiveRepetitionsUsed: badValue } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

// ─── Test 14 — ownership ────────────────────────────────────────────────────

describe('Test 14 — ownership', () => {
  it('rejects a student not owned by the requesting teacher with the ownership-check error (404)', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockEvaluateRepetitionRecommendation).not.toHaveBeenCalled();
  });

  it('calls getOwnStudentById with the requesting teacher and target student', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ userId: 14, studentId: '13' }), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(14, 13);
  });
});

// ─── Test 15 — read failure ──────────────────────────────────────────────────

describe('Test 15 — read_failed safe response', () => {
  it('a service read_failed status becomes a 500 ApiError, never an unhandled crash or a fabricated recommendation', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: null, shouldRepeat: false, reason: null, signals: null, policy: null, history: null,
    });
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Test 16 — read-only guarantee ──────────────────────────────────────────

describe('Test 16 — read-only guarantee', () => {
  it('never calls anything beyond the ownership check and evaluateRepetitionRecommendation', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getRepetitionRecommendation(makeReq({ letter: 'c' }), res);

    expect(mockGetOwnStudentById).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledWith({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
  });

  it('the controller source (excluding comments) never references a write call for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getRepetitionRecommendation[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(/);
  });
});

// ─── Invalid input (letter/caseType/studentId) ──────────────────────────────

describe('Invalid input', () => {
  it.each(['abc', '0', '-1', '1.5'])('rejects studentId=%p with a 422 ApiError', async (badId) => {
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ studentId: badId }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it.each(['', 'ab'])('rejects a malformed letter %p with a 422 ApiError', async (badLetter) => {
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ letter: badLetter }), res)).rejects.toMatchObject({ statusCode: 422 });
  });

  it.each(['mixedcase', ''])('rejects a malformed caseType %p with a 422 ApiError', async (badCaseType) => {
    const res = makeRes();
    await expect(getRepetitionRecommendation(makeReq({ caseType: badCaseType }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

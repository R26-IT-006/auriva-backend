'use strict';

// Feature 4 Step 5 — GET /handwriting/pre-writing-recommendation/:studentId/:letter/:caseType
// (handwritingController.getPreWritingRecommendation) verified in isolation.
// teacherService and adaptivePreWritingService are mocked — the controller
// itself duplicates none of evaluatePreWritingRecommendation's logic, so
// these tests only prove the thin wrapper (validation, ownership,
// status-code mapping, pass-through shape). Mirrors
// tests/getSupportRecommendationEndpoint.test.js's exact convention.
const mockGetOwnStudentById = jest.fn();
const mockEvaluatePreWritingRecommendation = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/adaptivePreWritingService', () => ({
  evaluatePreWritingRecommendation: (...a) => mockEvaluatePreWritingRecommendation(...a),
}));

const { getPreWritingRecommendation } = require('../src/controllers/handwritingController');

function makeReq({ studentId = '13', letter = 'c', caseType = 'lowercase', userId = 14 } = {}) {
  return { params: { studentId, letter, caseType }, user: { id: userId } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13, letter: 'c', caseType: 'lowercase',
    family: 'curved', primitiveGroup: 'curved',
    recommended: false, activityId: null, reason: 'insufficient_data',
    signals: { feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

// ─── Test 1/2/3 — mapped families ──────────────────────────────────────────

describe('Test 1 — straight reviewed letter', () => {
  it('passes family=straight/primitiveGroup=vertical_horizontal through', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      letter: 'l', family: 'straight', primitiveGroup: 'vertical_horizontal',
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'l' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'straight', primitiveGroup: 'vertical_horizontal', letter: 'l' }));
  });
});

describe('Test 2 — curved reviewed letter', () => {
  it('passes family=curved/primitiveGroup=curved through', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'curved', primitiveGroup: 'curved' }));
  });
});

describe('Test 3 — complex diagonal letter (v)', () => {
  it('passes family=complex/primitiveGroup=diagonal through', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      letter: 'v', family: 'complex', primitiveGroup: 'diagonal',
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'v' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'complex', primitiveGroup: 'diagonal' }));
  });
});

describe('Test 4 — complex curved letter (s/S)', () => {
  it('passes family=complex/primitiveGroup=curved through for s and S', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      letter: 's', family: 'complex', primitiveGroup: 'curved',
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 's' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'complex', primitiveGroup: 'curved' }));
  });
});

// ─── Test 5 — u/U no_activity_available ────────────────────────────────────

describe('Test 5 — u/U resolves no_activity_available', () => {
  it('recommended=false, activityId=null, reason=no_activity_available', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      letter: 'u', family: 'complex', primitiveGroup: 'mixed',
      recommended: false, activityId: null, reason: 'no_activity_available', signals: null,
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'u' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      recommended: false, activityId: null, reason: 'no_activity_available',
    }));
  });
});

// ─── Test 6 — ambiguous letter ──────────────────────────────────────────────

describe('Test 6 — ambiguous letter → not_applicable', () => {
  it('passes through not_applicable with null family/primitiveGroup', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      letter: 'a', family: null, primitiveGroup: null, reason: 'not_applicable', signals: null,
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'a' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: null, primitiveGroup: null, reason: 'not_applicable' }));
  });
});

// ─── Test 7/8/9 — trigger signals ───────────────────────────────────────────

describe('Test 7 — recommended via Feature 2', () => {
  it('passes recommended=true, reason=feature2_support_review through', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      recommended: true, activityId: 'connect_curve_dots', reason: 'feature2_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'insufficient_data' },
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommended: true, reason: 'feature2_support_review', activityId: 'connect_curve_dots' }));
  });
});

describe('Test 8 — recommended via Feature 3', () => {
  it('passes recommended=true, reason=feature3_support_review through', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      recommended: true, activityId: 'connect_curve_dots', reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommended: true, reason: 'feature3_support_review' }));
  });
});

describe('Test 9 — both signals support_review — Feature 3 reason priority passed through as-is', () => {
  it('never recomputes priority in the controller — trusts the service result verbatim', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      recommended: true, activityId: 'connect_curve_dots', reason: 'feature3_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'support_review' },
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'feature3_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'support_review' },
    }));
  });
});

// ─── Test 10/11/12 — no-recommendation reasons ─────────────────────────────

describe('Test 10 — insufficient_data', () => {
  it('recommended=false, activityId=null', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({ reason: 'insufficient_data' }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommended: false, reason: 'insufficient_data', activityId: null }));
  });
});

describe('Test 11 — no_persistent_difficulty', () => {
  it('recommended=false even though both signals completed', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      reason: 'no_persistent_difficulty',
      signals: { feature2Decision: 'hold', feature3Decision: 'recommend_high' },
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommended: false, reason: 'no_persistent_difficulty' }));
  });
});

describe('Test 12 — insufficient_target', () => {
  it('recommended=false, no fallback target used', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      reason: 'insufficient_target',
      signals: { feature2Decision: 'no_target', feature3Decision: 'insufficient_target' },
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommended: false, reason: 'insufficient_target' }));
  });
});

// ─── Test 13 — read failure ─────────────────────────────────────────────────

describe('Test 13 — read_failed safe response', () => {
  it('a Step 4 read_failed status becomes a 500 ApiError, never an unhandled crash or a fabricated recommendation', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: null, primitiveGroup: null, recommended: false, activityId: null, reason: null, signals: null,
    });
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Test 14 — ownership ────────────────────────────────────────────────────

describe('Test 14 — ownership', () => {
  it('rejects a student not owned by the requesting teacher with the ownership-check error (404)', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockEvaluatePreWritingRecommendation).not.toHaveBeenCalled();
  });

  it('calls getOwnStudentById with the requesting teacher and target student', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ userId: 14, studentId: '13' }), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(14, 13);
  });
});

// ─── Test 15 — invalid input ────────────────────────────────────────────────

describe('Test 15 — invalid input', () => {
  it.each(['abc', '0', '-1', '1.5'])('rejects studentId=%p with a 422 ApiError', async (badId) => {
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq({ studentId: badId }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it.each(['', 'ab'])('rejects a malformed letter %p with a 422 ApiError', async (badLetter) => {
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq({ letter: badLetter }), res)).rejects.toMatchObject({ statusCode: 422 });
  });

  it.each(['mixedcase', 'Lowercase', '', 'upper'])('rejects a malformed caseType %p with a 422 ApiError', async (badCaseType) => {
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq({ caseType: badCaseType }), res)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('a syntactically-valid single character that maps to no letter (e.g. "3") is NOT a 422 — the service resolves it, not the controller', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      letter: '3', family: null, primitiveGroup: null, reason: 'not_applicable', signals: null,
    }));
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: '3' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'not_applicable' }));
  });

  it('a service-level invalid_input (defensive/unreachable path) becomes a 422, never a crash', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce({
      status: 'invalid_input', studentId: null, letter: null, caseType: null,
      family: null, primitiveGroup: null, recommended: false, activityId: null, reason: null, signals: null,
    });
    const res = makeRes();
    await expect(getPreWritingRecommendation(makeReq(), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

// ─── Test 16 — read-only guarantee ──────────────────────────────────────────

describe('Test 16 — read-only guarantee', () => {
  it('never calls anything beyond the ownership check and evaluatePreWritingRecommendation', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);

    expect(mockGetOwnStudentById).toHaveBeenCalledTimes(1);
    expect(mockEvaluatePreWritingRecommendation).toHaveBeenCalledTimes(1);
    expect(mockEvaluatePreWritingRecommendation).toHaveBeenCalledWith({ studentId: 13, letter: 'c', caseType: 'lowercase' });
  });

  it('the controller source (excluding comments) never references a write call for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getPreWritingRecommendation[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|student_pre_writing_history|\.update\(|\.create\(|\.destroy\(/);
  });
});

// ─── Response shape — no raw scores/trajectory data ────────────────────────

describe('Response shape', () => {
  it('never leaks evidence arrays, raw scores, or trajectory data — only the minimal child-facing fields', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getPreWritingRecommendation(makeReq({ letter: 'c' }), res);
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      'activityId', 'caseType', 'family', 'letter', 'primitiveGroup',
      'reason', 'recommended', 'signals', 'status', 'studentId',
    ].sort());
  });
});

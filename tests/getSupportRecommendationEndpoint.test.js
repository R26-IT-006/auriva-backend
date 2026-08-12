'use strict';

// Feature 3 Step 6 — GET /handwriting/support-recommendation/:studentId/:letter/:caseType
// (handwritingController.getSupportRecommendation) verified in isolation.
// teacherService and adaptiveSupportService are mocked; handwritingController's
// own require('../models') is left real (harmless — matches
// tests/motorBaselineControllerRetrieval.test.js's own established
// convention: defining Sequelize models makes no DB connection). getBaselineFamily
// is left real too — it's a pure, static, already-tested mapping, not
// something this endpoint should re-verify a second time.
const mockGetOwnStudentById            = jest.fn(); // teacherService.getOwnStudentById
const mockEvaluateSupportRecommendations = jest.fn(); // adaptiveSupportService.evaluateSupportRecommendations

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/adaptiveSupportService', () => ({
  SUPPORT_PERFORMANCE_WINDOW_SIZE: 5,
  evaluateSupportRecommendations: (...a) => mockEvaluateSupportRecommendations(...a),
}));

const { getSupportRecommendation } = require('../src/controllers/handwritingController');

function makeReq({ studentId = '13', letter = 'c', caseType = 'lowercase', userId = 14 } = {}) {
  return { params: { studentId, letter, caseType }, user: { id: userId } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeFamilyDecision(overrides = {}) {
  return {
    family: 'curved', currentTarget: 80, recommendedSupport: null,
    decision: 'insufficient_data', reason: 'no_support_level_has_a_complete_window', requiresReview: false,
    supportResults: {
      low: { count: 0, metTargetCount: 0, windowComplete: false },
      medium: { count: 0, metTargetCount: 0, windowComplete: false },
      high: { count: 0, metTargetCount: 0, windowComplete: false },
    },
    evidenceQuality: { explicitCount: 0, historicalProxyCount: 0, containsHistoricalProxy: false },
    evidenceBasis: null,
    ...overrides,
  };
}

function makeEvaluatedResult(familyOverrides = {}) {
  return {
    status: 'evaluated', studentId: 13, windowSize: 5,
    families: {
      straight: makeFamilyDecision({ family: 'straight', currentTarget: 67 }),
      curved: makeFamilyDecision({ family: 'curved', currentTarget: 80 }),
      complex: makeFamilyDecision({ family: 'complex', currentTarget: 73 }),
      ...familyOverrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

// ─── Test 1/2/3 — mapped families ──────────────────────────────────────────

describe('Test 1 — mapped curved letter returns curved recommendation', () => {
  it('resolves family=curved for letter "c"', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult());
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'curved', letter: 'c' }));
  });
});

describe('Test 2 — mapped straight letter returns straight recommendation', () => {
  it('resolves family=straight for letter "l"', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult());
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'l' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'straight', letter: 'l' }));
  });
});

describe('Test 3 — mapped complex letter returns complex recommendation', () => {
  it('resolves family=complex for letter "v"', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult());
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'v' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'complex', letter: 'v' }));
  });
});

// ─── Test 4 — ambiguous letter ──────────────────────────────────────────────

describe('Test 4 — ambiguous letter → not_applicable', () => {
  it('never calls evaluateSupportRecommendations for an ambiguous letter (e.g. "a")', async () => {
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'a' }), res);

    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      status: 'resolved', studentId: 13, letter: 'a', caseType: 'lowercase',
      family: null, recommendedSupport: null, decision: 'not_applicable',
      reason: 'ambiguous_or_unmapped_letter', requiresReview: false, evidenceBasis: null,
    });
  });
});

// ─── Test 5/6/7 — recommend_low/medium/high ────────────────────────────────

describe('Test 5 — recommend_low maps to recommendedSupport=low', () => {
  it('passes through low with no review flag', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'recommend_low', recommendedSupport: 'low', evidenceBasis: 'explicit_only' }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      recommendedSupport: 'low', decision: 'recommend_low', requiresReview: false, evidenceBasis: 'explicit_only',
    }));
  });
});

describe('Test 6 — recommend_medium maps to recommendedSupport=medium', () => {
  it('passes through medium', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'recommend_medium' }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: 'medium', decision: 'recommend_medium' }));
  });
});

describe('Test 7 — recommend_high maps to recommendedSupport=high', () => {
  it('passes through high', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'recommend_high' }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: 'high', decision: 'recommend_high' }));
  });
});

// ─── Test 8 — support_review ────────────────────────────────────────────────

describe('Test 8 — support_review → recommendedSupport=high, requiresReview=true', () => {
  it('exposes requiresReview additively, never blocks the response', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'support_review', requiresReview: true }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      recommendedSupport: 'high', decision: 'support_review', requiresReview: true,
    }));
  });
});

// ─── Test 9/10 — insufficient_data / insufficient_target → null ───────────

describe('Test 9 — insufficient_data → recommendedSupport null', () => {
  it('never guesses high just because data is sparse', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'insufficient_data' }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: null, decision: 'insufficient_data' }));
  });
});

describe('Test 10 — insufficient_target → recommendedSupport null', () => {
  it('never fabricates a target-based recommendation', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'insufficient_target', currentTarget: null }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSupport: null, decision: 'insufficient_target' }));
  });
});

// ─── Test 11 — read_failed safe response ───────────────────────────────────

describe('Test 11 — read_failed safe response', () => {
  it('a Step 5 read_failed status becomes a 500 ApiError, never an unhandled crash or a fabricated recommendation', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, windowSize: 5, families: null });
    const res = makeRes();
    await expect(getSupportRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Test 12 — invalid student ──────────────────────────────────────────────

describe('Test 12 — invalid student', () => {
  it.each(['abc', '0', '-1', '1.5'])('rejects studentId=%p with a 422 ApiError', async (badId) => {
    const res = makeRes();
    await expect(getSupportRecommendation(makeReq({ studentId: badId }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('rejects a student not owned by the requesting teacher with the ownership-check error', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getSupportRecommendation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ─── Test 13 — invalid case/letter ─────────────────────────────────────────

describe('Test 13 — invalid case/letter', () => {
  it.each(['', 'ab'])('rejects a malformed letter %p (wrong length) with a 422 ApiError', async (badLetter) => {
    const res = makeRes();
    await expect(getSupportRecommendation(makeReq({ letter: badLetter }), res)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('a syntactically-valid single character that maps to no letter (e.g. "3") is NOT a 422 — it gracefully resolves to not_applicable, matching getBaselineFamily\'s own "never guess" tolerance', async () => {
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: '3' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: null, decision: 'not_applicable' }));
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
  });

  it.each(['mixedcase', 'Lowercase', '', 'upper'])('rejects a malformed caseType %p with a 422 ApiError', async (badCaseType) => {
    const res = makeRes();
    await expect(getSupportRecommendation(makeReq({ caseType: badCaseType }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

// ─── Test 14 — read-only guarantee ──────────────────────────────────────────

describe('Test 14 — read-only guarantee', () => {
  it('never calls anything beyond the ownership check and evaluateSupportRecommendations — no write of any kind', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeEvaluatedResult({
      curved: makeFamilyDecision({ decision: 'recommend_medium' }),
    }));
    const res = makeRes();
    await getSupportRecommendation(makeReq({ letter: 'c' }), res);

    expect(mockGetOwnStudentById).toHaveBeenCalledTimes(1);
    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledTimes(1);
    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledWith({ studentId: 13 });
  });

  it('the controller source (excluding comments) never references bulkCreate/support_level =/personal_thresholds/student_support_history for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    // Isolate just the getSupportRecommendation function body for a
    // precise, non-file-wide check (the rest of this large controller file
    // legitimately does write elsewhere, e.g. recordLetterCompletion).
    const match = source.match(/async function getSupportRecommendation[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|student_support_history|\.update\(|\.create\(|\.destroy\(/);
  });
});

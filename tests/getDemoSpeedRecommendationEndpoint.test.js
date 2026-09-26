'use strict';

// Feature 6 Step 3 — GET /handwriting/demo-speed-recommendation/:studentId/:letter/:caseType
// (handwritingController.getDemoSpeedRecommendation) verified in isolation.
// teacherService and demoSpeedRecommendationService are mocked — the
// controller itself duplicates none of evaluateDemoSpeedRecommendation's
// logic. Mirrors tests/getRepetitionRecommendationEndpoint.test.js's exact
// convention.
const mockGetOwnStudentById = jest.fn();
const mockEvaluateDemoSpeedRecommendation = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/demoSpeedRecommendationService', () => ({
  evaluateDemoSpeedRecommendation: (...a) => mockEvaluateDemoSpeedRecommendation(...a),
}));

const { getDemoSpeedRecommendation } = require('../src/controllers/handwritingController');

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
    family: 'curved', recommendedSpeedLevel: 'standard', reason: 'insufficient_data',
    signals: { feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

// ─── Test 23 — owned student -> 200 ─────────────────────────────────────────

describe('Test 23 — owned student returns 200 with the service result', () => {
  it('resolves family=curved for letter "c"', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: 'curved', letter: 'c' }));
  });
});

// ─── Test 24 — unowned -> 404 ────────────────────────────────────────────────

describe('Test 24 — unowned student -> 404', () => {
  it('rejects a student not owned by the requesting teacher with the ownership-check error', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getDemoSpeedRecommendation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockEvaluateDemoSpeedRecommendation).not.toHaveBeenCalled();
  });
});

// ─── Test 25/26 — invalid letter/case -> 422 ────────────────────────────────

describe('Test 25 — invalid letter -> 422', () => {
  it.each(['', 'ab'])('rejects a malformed letter %p', async (badLetter) => {
    const res = makeRes();
    await expect(getDemoSpeedRecommendation(makeReq({ letter: badLetter }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('Test 26 — invalid case -> 422', () => {
  it.each(['mixedcase', 'Lowercase', '', 'upper'])('rejects a malformed caseType %p', async (badCaseType) => {
    const res = makeRes();
    await expect(getDemoSpeedRecommendation(makeReq({ caseType: badCaseType }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('Invalid studentId -> 422', () => {
  it.each(['abc', '0', '-1', '1.5'])('rejects studentId=%p', async (badId) => {
    const res = makeRes();
    await expect(getDemoSpeedRecommendation(makeReq({ studentId: badId }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });
});

// ─── Test 27 — read failure -> 500 ──────────────────────────────────────────

describe('Test 27 — read_failed -> 500', () => {
  it('a service read_failed status becomes a 500 ApiError, never an unhandled crash or a fabricated recommendation', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: null, recommendedSpeedLevel: 'standard', reason: null, signals: null,
    });
    const res = makeRes();
    await expect(getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res)).rejects.toMatchObject({ statusCode: 500 });
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Test 28/29 — Feature 3/Feature 2 trigger responses ────────────────────

describe('Test 28 — Feature 3 trigger response passed through as-is', () => {
  it('recommendedSpeedLevel=slow, reason=feature3_support_review', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult({
      recommendedSpeedLevel: 'slow', reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    }));
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSpeedLevel: 'slow', reason: 'feature3_support_review' }));
  });
});

describe('Test 29 — Feature 2 trigger response passed through as-is', () => {
  it('recommendedSpeedLevel=slow, reason=feature2_support_review', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult({
      recommendedSpeedLevel: 'slow', reason: 'feature2_support_review',
      signals: { feature2Decision: 'support_review', feature3Decision: 'insufficient_data' },
    }));
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSpeedLevel: 'slow', reason: 'feature2_support_review' }));
  });
});

// ─── Test 30 — insufficient-data response ──────────────────────────────────

describe('Test 30 — insufficient-data response', () => {
  it('recommendedSpeedLevel=standard, reason=insufficient_data', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult({ reason: 'insufficient_data' }));
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ recommendedSpeedLevel: 'standard', reason: 'insufficient_data' }));
  });
});

// ─── Test 31 — not-applicable response ─────────────────────────────────────

describe('Test 31 — not-applicable response', () => {
  it('family=null, recommendedSpeedLevel=standard, reason=not_applicable', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult({
      letter: 'a', family: null, reason: 'not_applicable', signals: null,
    }));
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'a' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ family: null, reason: 'not_applicable', signals: null }));
  });
});

// ─── Test 32 — no duplicate business logic in controller ──────────────────

describe('Test 32 — no duplicate business logic in the controller', () => {
  it('the controller source (excluding comments) never references support_review/family-decision logic directly for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getDemoSpeedRecommendation[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/support_review|getBaselineFamily|evaluateDynamicThresholds|evaluateSupportRecommendations/);
  });
});

// ─── Test 33 — endpoint no writes / read-only guarantee ────────────────────

describe('Test 33 — endpoint performs no writes', () => {
  it('never calls anything beyond the ownership check and evaluateDemoSpeedRecommendation', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);

    expect(mockGetOwnStudentById).toHaveBeenCalledTimes(1);
    expect(mockEvaluateDemoSpeedRecommendation).toHaveBeenCalledTimes(1);
    expect(mockEvaluateDemoSpeedRecommendation).toHaveBeenCalledWith({ studentId: 13, letter: 'c', caseType: 'lowercase' });
  });

  it('the controller source (excluding comments) never references a write call for this handler', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/controllers/handwritingController.js'), 'utf8');
    const match = source.match(/async function getDemoSpeedRecommendation[\s\S]*?\n}\n/);
    expect(match).not.toBeNull();
    const codeOnly = match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(/);
  });
});

// ─── Response shape — no raw timing/scores ─────────────────────────────────

describe('Response shape', () => {
  it('never leaks raw timing metrics, evidence arrays, or trajectory data — only the minimal categorical fields', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult());
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      'caseType', 'family', 'letter', 'reason', 'recommendedSpeedLevel', 'signals', 'status', 'studentId',
    ].sort());
  });
});

// ─── Feature 6 Step 5 — final orchestration items 13-14 ────────────────────
// (final acceptance re-statement of Test 24 / "Response shape" above,
// numbered to match the Step 5 spec's own final orchestration checklist —
// not new coverage, the same assertions restated as explicit acceptance
// items so the Step 5 report can point at concrete, named tests.)

describe('Item 13 — recommendation endpoint ownership (final orchestration)', () => {
  it('an unowned student is rejected with 404 before the recommendation service is ever called', async () => {
    const ApiError = require('../src/utils/ApiError');
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getDemoSpeedRecommendation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockEvaluateDemoSpeedRecommendation).not.toHaveBeenCalled();
  });
});

describe('Item 14 — response schema stable across Step 3 -> Step 5 (final orchestration)', () => {
  it('exactly the same 8 documented fields as Step 3 defined, unchanged by Step 4/5 frontend activation and persistence work', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult({ recommendedSpeedLevel: 'slow', reason: 'feature3_support_review' }));
    const res = makeRes();
    await getDemoSpeedRecommendation(makeReq({ letter: 'c' }), res);
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      'status', 'studentId', 'letter', 'caseType', 'family', 'recommendedSpeedLevel', 'reason', 'signals',
    ].sort());
    // No demo_speed_level (persistence field) ever leaks into the READ
    // recommendation response — persistence and recommendation are two
    // deliberately separate concepts (Step 3's persistence-semantics split).
    expect(payload).not.toHaveProperty('demo_speed_level');
  });
});

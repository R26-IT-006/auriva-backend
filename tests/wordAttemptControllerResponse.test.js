'use strict';

// Final-completion-pass task (section 40.3) — verifies POST
// /handwriting/word-attempt (handwritingController.postWordAttempt) in
// isolation: the response includes child_feedback, defaults to null when
// absent (duplicate-replay branch), and never leaks raw strokes/
// normalized_features. Mirrors familyThresholdsControllerRetrieval.test.js's
// exact convention: teacherService and wordWritingService are mocked;
// handwritingController's own require('../models') is left real (harmless,
// no DB connection).
const mockGetOwnStudentById = jest.fn();
const mockSaveAttempt = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: mockGetOwnStudentById,
}));

jest.mock('../src/services/wordWritingService', () => ({
  saveAttempt: (...args) => mockSaveAttempt(...args),
  upsertActivity: jest.fn(),
  getProgress: jest.fn(),
  getAttempts: jest.fn(),
  getReport: jest.fn(),
}));

const { postWordAttempt } = require('../src/controllers/handwritingController');

function makeReq(body, userId = 5) {
  return { body, user: { id: userId, role: 'teacher' } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
async function callRoute(body, userId = 5) {
  const res = makeRes();
  await postWordAttempt(makeReq(body, userId), res);
  return res;
}

const baseBody = { student_id: 40, action_id: 'a-1', word: 'cat', stage: 'guided_word_writing', attempt_number: 1, strokes: [[{ x: 1, y: 1 }]], canvas_width: 490, canvas_height: 220 };

function fakeAttempt(overrides = {}) {
  const row = {
    id: 7, score: 82, threshold_used: 50, passed: true, completion_passed: true,
    expected_letter_count: 3, covered_letter_count: 3, word_score_version: 'word_v1',
    strokes: [[{ x: 1, y: 1 }]],
    normalized_features: { dtw_distance: 3, smoothness: 0.2, word_layout: { version: 'word_layout_v1', status: 'available' } },
    ...overrides,
  };
  return { ...row, get: () => row };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 40, teacher_id: 5 });
});

test('a saved attempt returns duplicate:false, 201, and the real child_feedback value', async () => {
  mockSaveAttempt.mockResolvedValueOnce({ status: 'saved', duplicate: false, attempt: fakeAttempt(), childFeedback: 'size' });
  const res = await callRoute(baseBody);
  expect(res.status).toHaveBeenCalledWith(201);
  const payload = res.json.mock.calls[0][0];
  expect(payload.duplicate).toBe(false);
  expect(payload.child_feedback).toBe('size');
});

test.each(['spacing', 'both'])('child_feedback %p passes through unchanged', async childFeedback => {
  mockSaveAttempt.mockResolvedValueOnce({ status: 'saved', duplicate: false, attempt: fakeAttempt(), childFeedback });
  const res = await callRoute(baseBody);
  expect(res.json.mock.calls[0][0].child_feedback).toBe(childFeedback);
});

test('a duplicate/replayed request has no childFeedback field at all and still responds with child_feedback: null, not undefined', async () => {
  mockSaveAttempt.mockResolvedValueOnce({ status: 'saved', duplicate: true, attempt: fakeAttempt() }); // no childFeedback key
  const res = await callRoute(baseBody);
  expect(res.status).toHaveBeenCalledWith(200);
  const payload = res.json.mock.calls[0][0];
  expect(payload.duplicate).toBe(true);
  expect(payload.child_feedback).toBeNull();
});

test('a null childFeedback value (no advisory) passes through as null', async () => {
  mockSaveAttempt.mockResolvedValueOnce({ status: 'saved', duplicate: false, attempt: fakeAttempt(), childFeedback: null });
  const res = await callRoute(baseBody);
  expect(res.json.mock.calls[0][0].child_feedback).toBeNull();
});

test('the response never includes raw strokes or normalized_features (only the whitelisted attempt summary fields)', async () => {
  mockSaveAttempt.mockResolvedValueOnce({ status: 'saved', duplicate: false, attempt: fakeAttempt(), childFeedback: null });
  const res = await callRoute(baseBody);
  const payload = res.json.mock.calls[0][0];
  expect(payload.attempt).not.toHaveProperty('strokes');
  expect(payload.attempt).not.toHaveProperty('normalized_features');
  expect(payload.attempt).toEqual({
    id: 7, score: 82, threshold: 50, passed: true, completion_passed: true,
    expected_letter_count: 3, covered_letter_count: 3, score_version: 'word_v1',
  });
});

test('an invalid-input result throws a 422 ApiError rather than saving anything misleading', async () => {
  mockSaveAttempt.mockResolvedValueOnce({ status: 'unsupported_word' });
  await expect(callRoute(baseBody)).rejects.toMatchObject({ statusCode: 422 });
});

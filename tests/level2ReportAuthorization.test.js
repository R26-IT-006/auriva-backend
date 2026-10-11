'use strict';

// The Level 2 teacher-report endpoints read one child's records (and the new
// activity view includes what the app heard the child say), so each must
// confirm the teacher owns that child. The router's isTeacher check alone let
// any teacher read any student's Level 2 data.
const ApiError = require('../src/utils/ApiError');

const mockAssertOwns = jest.fn();
const mockGetReport = jest.fn();
const mockGetModuleTimeline = jest.fn();
const mockGetTopicTimeline = jest.fn();
const mockGetTopicActivity = jest.fn();

jest.mock('../src/services/level2Service', () => ({
  assertStudentBelongsToTeacher: (...a) => mockAssertOwns(...a),
}));
jest.mock('../src/services/level2AnalyticsService', () => ({
  getLevel2Report:   (...a) => mockGetReport(...a),
  getModuleTimeline: (...a) => mockGetModuleTimeline(...a),
  getTopicTimeline:  (...a) => mockGetTopicTimeline(...a),
  getTopicActivity:  (...a) => mockGetTopicActivity(...a),
}));
// validate() reads express-validator's result; no validators run in a unit test.
jest.mock('express-validator', () => ({
  validationResult: () => ({ isEmpty: () => true, array: () => [] }),
}));

const ctrl = require('../src/controllers/level2Controller');

const TEACHER_ID = 7;
const OWN_STUDENT = '10';
const OTHER_STUDENT = '55';
const NOT_OWNED = new ApiError(404, 'Student not found or not assigned to you');

function makeReq(studentId, extra = {}) {
  return { user: { id: TEACHER_ID }, params: { studentId, topic: 'self_introduction' }, query: {}, ...extra };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertOwns.mockImplementation(async (teacherId, studentId) => {
    if (studentId !== OWN_STUDENT) throw NOT_OWNED;
    return { sid: Number(studentId), teacher_id: teacherId };
  });
  mockGetReport.mockResolvedValue({ totals: {}, topics: [] });
  mockGetModuleTimeline.mockResolvedValue({ points: [] });
  mockGetTopicTimeline.mockResolvedValue({ points: [] });
  mockGetTopicActivity.mockResolvedValue({ topic: 'self_introduction', limited: false, sessions: [] });
});

const CASES = [
  ['getReport',        () => mockGetReport],
  ['getTimeline',      () => mockGetModuleTimeline],
  ['getTopicTimeline', () => mockGetTopicTimeline],
  ['getTopicActivity', () => mockGetTopicActivity],
];

describe.each(CASES)('%s', (handler, serviceMock) => {
  it('serves the teacher\'s own student', async () => {
    const res = makeRes();
    await ctrl[handler](makeReq(OWN_STUDENT), res);
    expect(mockAssertOwns).toHaveBeenCalledWith(TEACHER_ID, OWN_STUDENT);
    expect(serviceMock()).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('rejects another teacher\'s student with 404, before reading any data', async () => {
    const res = makeRes();
    await expect(ctrl[handler](makeReq(OTHER_STUDENT), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(serviceMock()).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

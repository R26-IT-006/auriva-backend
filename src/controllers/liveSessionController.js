'use strict';

// Proposal FR-16, Phase 7B — thin controller over liveSessionService. Both
// handlers sit on the SAME teacher-authenticated router as every other
// handwriting endpoint (routes/handwriting.js already applies
// verifyToken+isTeacher to the whole router) — the child-side app runs
// under the teacher's own login, exactly like recordLetterCompletion etc.,
// so ownership is enforced identically for both the child-side PUT and the
// teacher-side GET (spec §5): a request for a student not owned by
// req.user.id is rejected with the same 404 teacherService.getOwnStudentById
// already uses everywhere else in this codebase.
const ApiError = require('../utils/ApiError');
const liveSessionService = require('../services/liveSessionService');

function parseStudentId(req) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }
  return studentId;
}

// PUT /handwriting/live-session/:studentId
async function putLiveSession(req, res) {
  const studentId = parseStudentId(req);
  const snapshot = await liveSessionService.upsertLiveSession(req.user.id, studentId, req.body);
  res.json({ status: 'ok', session: snapshot });
}

// GET /handwriting/live-session/:studentId
async function getLiveSession(req, res) {
  const studentId = parseStudentId(req);
  const snapshot = await liveSessionService.getLiveSession(req.user.id, studentId);
  res.json(snapshot);
}

module.exports = { putLiveSession, getLiveSession };

'use strict';

// Proposal FR-19, Phase 7C — periodic progress report endpoint. Thin
// controller: parses/validates the date range, verifies ownership, then
// delegates entirely to periodicReportService.js (which is the sole owner
// of every read/aggregation — see that module's own READ-ONLY GUARANTEE
// header). Sits on the same teacher-authenticated router as every other
// handwriting endpoint (routes/handwriting.js already applies
// verifyToken+isTeacher to the whole router).
const ApiError = require('../utils/ApiError');
const teacherService = require('../services/teacherService');
const { resolveReportDateRange } = require('../utils/reportDateRange');
const { buildPeriodicReport } = require('../services/periodicReportService');

// GET /handwriting/report/:studentId?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
async function getPeriodicReport(req, res) {
  const studentId = Number(req.params.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  const range = resolveReportDateRange(req.query.start_date, req.query.end_date);
  if (!range.ok) {
    throw new ApiError(422, range.error);
  }

  // Ownership check BEFORE any report data is read — identical pattern to
  // every other handwriting endpoint (teacherService.getOwnStudentById).
  await teacherService.getOwnStudentById(req.user.id, studentId);

  const report = await buildPeriodicReport({
    studentId,
    teacherId: req.user.id,
    startAt: range.startAt,
    endAt: range.endAt,
    startDate: range.startDate,
    endDate: range.endDate,
  });

  res.json(report);
}

module.exports = { getPeriodicReport };

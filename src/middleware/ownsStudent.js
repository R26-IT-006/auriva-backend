'use strict';

const { Student } = require('../models');
const ApiError = require('../utils/ApiError');

/**
 * Asserts the authenticated teacher owns the student named in the request.
 *
 * Written as middleware rather than 20 call-site checks on purpose: the concept
 * router mounts it once, so an endpoint added later is covered by default rather
 * than by whoever remembers. Every endpoint under /api/teacher/concepts took
 * student_id straight from the request and acted on it, which let any
 * authenticated teacher read and write any child's progress by changing one
 * integer — minors' disability-linked data held under ethics clearance.
 *
 * 404 rather than 403, matching assertOwnedStudent in conceptAnalyticsService:
 * a 403 confirms the id exists and turns the endpoint into an id enumerator.
 *
 * The id arrives in three shapes across the router, so all three are checked:
 *   req.body.student_id     most POSTs
 *   req.query.student_id    /:category/items, /distractors, /activity/status
 *   req.params.studentId    /coloring/:studentId
 *
 * The params case needs care. Mounted via router.use() this middleware runs
 * BEFORE route matching, so req.params is empty and a path-segment id is
 * invisible — /coloring/:studentId sailed through the mounted copy. Routes that
 * name the student in the path must therefore also attach this guard directly,
 * where Express has populated req.params. Keep both: the mounted copy is what
 * covers a new body/query route added by someone who never reads this file.
 */

/** The student id this request is about, or null when it names none. */
function studentIdFrom(req) {
  const raw = req.body?.student_id
    ?? req.query?.student_id
    ?? req.params?.studentId
    ?? req.params?.student_id;

  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function ownsStudent(req, res, next) {
  const studentId = studentIdFrom(req);

  // No student in the request: nothing to authorise here. The route's own
  // validators still reject a genuinely missing required id with 422, so this
  // is not a bypass — it is the guard declining to invent an error that the
  // validator reports more precisely.
  if (studentId === null) return next();

  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: req.user.id },
    attributes: ['sid'],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  // Cached for handlers that would otherwise re-query. Not used as the id to act
  // on — handlers keep reading their own validated field, so this cannot change
  // behaviour if the guard is ever removed.
  req.ownedStudentId = studentId;
  next();
}

module.exports = { ownsStudent, studentIdFrom };

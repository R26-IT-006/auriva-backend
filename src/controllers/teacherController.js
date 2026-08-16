'use strict';

const { validationResult } = require('express-validator');
const teacherService = require('../services/teacherService');
const { setTeacherFamilyThreshold } = require('../services/dynamicThresholdService');
const ApiError       = require('../utils/ApiError');

async function getDashboard(req, res) {
  const data = await teacherService.getDashboardStats(req.user.id);
  res.json(data);
}

async function getStudents(req, res) {
  const students = await teacherService.getOwnStudents(req.user.id);
  res.json(students);
}

async function getStudentById(req, res) {
  const student = await teacherService.getOwnStudentById(req.user.id, req.params.id);
  res.json(student);
}

async function setAvatar(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const record = await teacherService.setAvatar(req.user.id, req.params.id, req.body.avatar_key);
  res.status(201).json(record);
}

async function setThreshold(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await teacherService.setThreshold(
    req.user.id,
    req.params.id,
    req.body.letter,
    req.body.value,
  );
  res.json(result);
}

// Feature 2 Step 6A — Family-level teacher override. Deliberately a
// SEPARATE endpoint from setThreshold (legacy per-letter
// students.personal_thresholds) — this one only ever writes an append-only
// student_threshold_history row, never personal_thresholds. See
// dynamicThresholdService.setTeacherFamilyThreshold() for the full
// ownership/validation/provenance contract; this controller only maps its
// status result onto an HTTP response, never a raw Sequelize object.
async function setFamilyThreshold(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  // Same strict parse convention as handwritingController.getMotorBaseline —
  // Number(...) + Number.isInteger, never a bare parseInt('10abc') that
  // would silently accept trailing garbage.
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    throw new ApiError(422, 'Invalid student ID');
  }

  const result = await setTeacherFamilyThreshold({
    teacherId: req.user.id,
    studentId,
    family: req.body.family,
    value:  req.body.value,
  });

  switch (result.status) {
    case 'updated':
      return res.json({
        status:       'updated',
        studentId:    result.studentId,
        family:       result.family,
        oldThreshold: result.oldThreshold,
        newThreshold: result.newThreshold,
        source:       result.source,
      });
    case 'student_not_found':
      // Same message as the legacy /threshold endpoint — never reveals
      // whether another teacher owns this student.
      throw new ApiError(404, 'Student not found or not assigned to you');
    case 'threshold_not_initialized':
      throw new ApiError(409, 'This student has no initialized Feature 2 family threshold yet — a teacher override changes an initialized target, it cannot originate one');
    case 'invalid_family':
      throw new ApiError(422, 'family must be one of: straight, curved, complex');
    case 'invalid_value':
      throw new ApiError(422, 'value must be a finite number between 0 and 100');
    case 'invalid_input':
      throw new ApiError(422, 'Invalid teacher family threshold request');
    default: // 'read_failed' / 'save_failed' — an unexpected DB error, already logged inside the service
      throw new ApiError(500, 'Failed to set family threshold');
  }
}

module.exports = { getDashboard, getStudents, getStudentById, setAvatar, setThreshold, setFamilyThreshold };

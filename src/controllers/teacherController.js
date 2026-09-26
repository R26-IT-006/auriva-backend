'use strict';

const { validationResult } = require('express-validator');
const teacherService = require('../services/teacherService');
const { setTeacherFamilyThreshold } = require('../services/dynamicThresholdService');
const ApiError       = require('../utils/ApiError');
const { sendAudioBufferResponse } = require('../utils/audioResponse');

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

async function getStudentNotes(req, res) {
  const notes = await teacherService.getStudentNotes(req.user.id, req.params.id);
  res.json(notes);
}

async function addStudentNote(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const note = await teacherService.addStudentNote(req.user.id, req.params.id, req.body.body);
  res.status(201).json(note);
}

async function deleteStudentNote(req, res) {
  await teacherService.deleteStudentNote(req.user.id, req.params.id, req.params.noteId);
  res.status(204).send();
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

async function setSensorySettings(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const record = await teacherService.setSensorySettings(
    req.user.id,
    req.params.id,
    req.body.reduce_stimulation
  );
  res.json(record);
}

async function savePronunciationResult(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await teacherService.savePronunciationResult(
    req.user.id,
    req.params.id,
    req.body
  );
  res.status(201).json(result);
}

async function scorePronunciationAttempt(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await teacherService.scorePronunciationAttempt(
    req.user.id,
    req.params.id,
    req.body
  );
  res.json(result);
}

async function getPronunciationResults(req, res) {
  const results = await teacherService.getPronunciationResults(req.user.id, req.params.id, req.query.limit);
  res.json(results);
}

async function getPronunciationReviewQueue(req, res) {
  const queue = await teacherService.getPronunciationReviewQueue(req.user.id, req.query.limit);
  res.json(queue);
}

async function submitPronunciationReview(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const result = await teacherService.submitPronunciationReview(
    req.user.id,
    req.params.resultId,
    req.body.teacher_reviewed_score
  );
  res.json(result);
}

async function getPronunciationResultAudio(req, res) {
  const audio = await teacherService.getPronunciationResultAudio(
    req.user.id,
    req.params.resultId
  );

  if (req.query.stream === '1') {
    const buffer = Buffer.from(audio.raw_audio_base64, 'base64');
    const mimeType = audio.raw_audio_mime_type || 'audio/mp4';
    sendAudioBufferResponse({ req, res, buffer, mimeType });
    return;
  }

  res.json(audio);
}

// Session management was removed from this branch in commit 7311516 and is
// restored here because the pronunciation module's client brackets its flow
// with these two calls (see pronunciationSessionLifecycle.js). Without them
// both requests 404 and no `sessions` row is ever written for a pronunciation
// session, so the dashboard's session counts and Recent Activity silently omit
// the entire module.
async function startSession(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const session = await teacherService.startSession(req.user.id, req.body.student_id);
  res.status(201).json(session);
}

async function endSession(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const session = await teacherService.endSession(req.user.id, req.body.student_id);
  res.json(session);
}

module.exports = {
  startSession,
  endSession,
  getDashboard,
  getStudents,
  getStudentById,
  setAvatar,
  getStudentNotes,
  addStudentNote,
  deleteStudentNote,
  setThreshold,
  setFamilyThreshold,
  setSensorySettings,
  scorePronunciationAttempt,
  savePronunciationResult,
  getPronunciationResults,
  getPronunciationResultAudio,
  submitPronunciationReview,
  getPronunciationReviewQueue,
};

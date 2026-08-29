'use strict';

const { validationResult } = require('express-validator');
const teacherService = require('../services/teacherService');
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
  const results = await teacherService.getPronunciationResults(req.user.id, req.params.id);
  res.json(results);
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

// startSession/endSession are deliberately absent: session management was removed
// from this branch (commit 7311516). The incoming branch's export list still named
// them, which would throw a ReferenceError the moment this module is required.

module.exports = {
  getDashboard,
  getStudents,
  getStudentById,
  setAvatar,
  getStudentNotes,
  addStudentNote,
  deleteStudentNote,
  setThreshold,
  setSensorySettings,
  scorePronunciationAttempt,
  savePronunciationResult,
  getPronunciationResults,
  getPronunciationResultAudio,
};

'use strict';

const { validationResult } = require('express-validator');
const teacherService = require('../services/teacherService');
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

async function setAvatar(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());

  const record = await teacherService.setAvatar(req.user.id, req.params.id, req.body.avatar_key);
  res.status(201).json(record);
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
    const totalSize = buffer.length;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const requestedStart = match?.[1] ? Number.parseInt(match[1], 10) : 0;
      const requestedEnd = match?.[2]
        ? Number.parseInt(match[2], 10)
        : totalSize - 1;
      const start = Math.max(0, Math.min(requestedStart, totalSize - 1));
      const end = Math.max(start, Math.min(requestedEnd, totalSize - 1));
      const chunk = buffer.subarray(start, end + 1);

      res.status(206);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', String(chunk.length));
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.send(chunk);
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(totalSize));
    res.send(buffer);
    return;
  }

  res.json(audio);
}

module.exports = {
  getDashboard,
  getStudents,
  getStudentById,
  startSession,
  endSession,
  setAvatar,
  savePronunciationResult,
  getPronunciationResults,
  getPronunciationResultAudio,
};

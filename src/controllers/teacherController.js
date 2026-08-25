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

module.exports = {
  getDashboard,
  getStudents,
  getStudentById,
  setAvatar,
  getStudentNotes,
  addStudentNote,
  deleteStudentNote,
};

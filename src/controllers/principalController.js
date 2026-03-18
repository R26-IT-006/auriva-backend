'use strict';

const { validationResult } = require('express-validator');
const principalService = require('../services/principalService');
const ApiError         = require('../utils/ApiError');

function validate(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw new ApiError(422, 'Validation failed', errors.array());
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function getDashboard(req, res) {
  const stats = await principalService.getDashboardStats();
  res.json(stats);
}

// ─── Teachers ─────────────────────────────────────────────────────────────────

async function createTeacher(req, res) {
  validate(req);
  const teacher = await principalService.createTeacher(req.body, req.file, req.user.id);
  res.status(201).json(teacher);
}

async function getTeachers(req, res) {
  const teachers = await principalService.getTeachers();
  res.json(teachers);
}

async function getTeacherById(req, res) {
  const teacher = await principalService.getTeacherById(req.params.id);
  res.json(teacher);
}

async function updateTeacher(req, res) {
  validate(req);
  const teacher = await principalService.updateTeacher(req.params.id, req.body, req.file);
  res.json(teacher);
}

async function deleteTeacher(req, res) {
  await principalService.deleteTeacher(req.params.id);
  res.json({ message: 'Teacher deleted successfully' });
}

// ─── Students ─────────────────────────────────────────────────────────────────

async function createStudent(req, res) {
  validate(req);
  const student = await principalService.createStudent(req.body, req.file);
  res.status(201).json(student);
}

async function getStudents(req, res) {
  const students = await principalService.getStudents();
  res.json(students);
}

async function getStudentById(req, res) {
  const student = await principalService.getStudentById(req.params.id);
  res.json(student);
}

async function updateStudent(req, res) {
  validate(req);
  const student = await principalService.updateStudent(req.params.id, req.body, req.file);
  res.json(student);
}

async function deleteStudent(req, res) {
  await principalService.deleteStudent(req.params.id);
  res.json({ message: 'Student deleted successfully' });
}

async function assignStudent(req, res) {
  validate(req);
  const { teacher_id } = req.body;
  const student = await principalService.assignStudent(
    req.params.id,
    teacher_id !== undefined ? teacher_id : null
  );
  res.json(student);
}

module.exports = {
  getDashboard,
  createTeacher, getTeachers, getTeacherById, updateTeacher, deleteTeacher,
  createStudent, getStudents, getStudentById, updateStudent, deleteStudent, assignStudent,
};

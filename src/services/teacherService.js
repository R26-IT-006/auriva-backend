'use strict';

const { Op } = require('sequelize');
const { Teacher, Student, Session } = require('../models');
const ApiError = require('../utils/ApiError');

async function getDashboardStats(teacherId) {
  const startOfWeek = new Date();
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Sunday

  const [profile, totalSessions, weeklySessions, lastSession] = await Promise.all([
    Teacher.findByPk(teacherId, { attributes: { exclude: ['password_hash'] } }),
    Session.count({ where: { teacher_id: teacherId } }),
    Session.count({ where: { teacher_id: teacherId, started_at: { [Op.gte]: startOfWeek } } }),
    Session.findOne({
      where: { teacher_id: teacherId },
      order: [['started_at', 'DESC']],
      include: [{ model: Student, as: 'student', attributes: ['sid', 'full_name', 'student_code'] }],
    }),
  ]);

  if (!profile) throw new ApiError(404, 'Teacher not found');

  return {
    profile,
    stats: {
      totalSessions,
      weeklySessions,
      lastSession: lastSession
        ? {
            studentName: lastSession.student?.full_name,
            studentCode: lastSession.student?.student_code,
            date: lastSession.started_at,
          }
        : null,
    },
  };
}

async function getOwnStudents(teacherId) {
  return Student.findAll({
    where: { teacher_id: teacherId },
    order: [['student_code', 'ASC']],
  });
}

async function getOwnStudentById(teacherId, studentId) {
  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: teacherId },
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return student;
}

async function startSession(teacherId, studentId) {
  // Verify student belongs to this teacher
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  // Prevent duplicate active sessions
  const existing = await Session.findOne({
    where: { teacher_id: teacherId, student_id: studentId, is_active: true },
  });
  if (existing) throw new ApiError(409, 'A session is already active for this student');

  return Session.create({ teacher_id: teacherId, student_id: studentId });
}

async function endSession(teacherId, studentId) {
  const session = await Session.findOne({
    where: { teacher_id: teacherId, student_id: studentId, is_active: true },
  });
  if (!session) throw new ApiError(404, 'No active session found for this student');

  await session.update({ ended_at: new Date(), is_active: false });
  return session;
}

module.exports = {
  getDashboardStats,
  getOwnStudents,
  getOwnStudentById,
  startSession,
  endSession,
};

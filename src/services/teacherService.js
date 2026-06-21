'use strict';

const axios  = require('axios');
const { Teacher, Student, StudentConceptProgress, StudentAvatar } = require('../models');
const ApiError = require('../utils/ApiError');

const GNN_BASE = process.env.GNN_SERVICE_URL || 'http://localhost:8000';

async function getDashboardStats(teacherId) {
  const [profile, students] = await Promise.all([
    Teacher.findByPk(teacherId, { attributes: { exclude: ['password_hash'] } }),
    Student.findAll({ where: { teacher_id: teacherId }, attributes: ['sid'] }),
  ]);

  if (!profile) throw new ApiError(404, 'Teacher not found');

  const studentIds = students.map((s) => s.sid);
  const totalStudents = studentIds.length;

  const [conceptsMastered, avgEngagement] = await Promise.all([
    totalStudents > 0
      ? StudentConceptProgress.count({
          where: { tier1_status: 'passed', student_id: studentIds },
        })
      : 0,
    totalStudents > 0
      ? axios
          .get(`${GNN_BASE}/gkb/teacher/engagement`, {
            params: { student_ids: studentIds.join(',') },
            timeout: 4000,
          })
          .then((r) => r.data.avg_engagement)
          .catch(() => null)
      : null,
  ]);

  return {
    profile,
    stats: {
      totalStudents,
      conceptsMastered,
      avgEngagement,
    },
  };
}

async function getOwnStudents(teacherId) {
  const students = await Student.findAll({
    where: { teacher_id: teacherId },
    order: [['student_code', 'ASC']],
    include: [{ model: StudentAvatar, as: 'avatarRecord', attributes: ['avatar_key'] }],
  });
  return students.map(flattenAvatar);
}

async function getOwnStudentById(teacherId, studentId) {
  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: teacherId },
    include: [{ model: StudentAvatar, as: 'avatarRecord', attributes: ['avatar_key'] }],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  return flattenAvatar(student);
}

async function setAvatar(teacherId, studentId, avatarKey) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const [record] = await StudentAvatar.upsert({
    student_id:  studentId,
    avatar_key:  avatarKey,
    selected_by: teacherId,
    selected_at: new Date(),
  });
  return record;
}

function flattenAvatar(student) {
  const plain = student.get({ plain: true });
  plain.avatar_key = plain.avatarRecord?.avatar_key ?? null;
  delete plain.avatarRecord;
  return plain;
}

module.exports = {
  getDashboardStats,
  getOwnStudents,
  getOwnStudentById,
  setAvatar,
};

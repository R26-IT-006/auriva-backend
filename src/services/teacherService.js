'use strict';

const axios  = require('axios');
const { Teacher, Student, Session, StudentConceptProgress, StudentAvatar } = require('../models');
const { isMastered } = require('./conceptService');
const ApiError = require('../utils/ApiError');

const GNN_BASE = process.env.GNN_SERVICE_URL || 'http://localhost:8000';

async function getDashboardStats(teacherId) {
  const [profile, students] = await Promise.all([
    Teacher.findByPk(teacherId, { attributes: { exclude: ['password_hash'] } }),
    Student.findAll({
      where: { teacher_id: teacherId },
      attributes: ['sid', 'full_name', 'profile_photo_url'],
      order: [['student_code', 'ASC']],
    }),
  ]);

  if (!profile) throw new ApiError(404, 'Teacher not found');

  const studentIds = students.map((s) => s.sid);
  const totalStudents = studentIds.length;

  const [conceptsMastered, avgEngagement, recentSessions, recentAchievements, allProgress, allSessions] = await Promise.all([
    // "Mastered" means tier 1 AND tier 2, matching activityService and the concept
    // analytics report. This counts fewer concepts than the old tier-1-only rule.
    totalStudents > 0
      ? StudentConceptProgress.count({
          where: { tier1_status: 'passed', tier2_status: 'passed', student_id: studentIds },
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
    totalStudents > 0
      ? Session.findAll({
          where: { student_id: studentIds },
          include: [{ model: Student, as: 'student', attributes: ['full_name'] }],
          order: [['started_at', 'DESC']],
          limit: 5,
        })
      : [],
    totalStudents > 0
      ? StudentConceptProgress.findAll({
          where: { tier1_status: 'passed', student_id: studentIds },
          include: [{ model: Student, as: 'student', attributes: ['full_name'] }],
          order: [['tier1_passed_at', 'DESC']],
          limit: 5,
        })
      : [],
    totalStudents > 0
      ? StudentConceptProgress.findAll({
          where: { student_id: studentIds },
          // tier2_status is required by isMastered — without it the predicate reads
          // undefined and silently counts nothing.
          attributes: ['student_id', 'tier1_status', 'tier2_status', 'tier1_score'],
        })
      : [],
    totalStudents > 0
      ? Session.findAll({
          where: { student_id: studentIds },
          attributes: ['student_id', 'started_at'],
          order: [['started_at', 'DESC']],
        })
      : [],
  ]);

  const proficiency = students.map((s) => {
    const progress = allProgress.filter((p) => p.student_id === s.sid);
    const scores = progress.filter((p) => p.tier1_score != null).map((p) => p.tier1_score);
    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const mastered = progress.filter(isMastered).length;
    const lastSession = allSessions.find((sess) => sess.student_id === s.sid);

    return {
      studentId: s.sid,
      fullName: s.full_name,
      profilePhotoUrl: s.profile_photo_url,
      conceptsAssigned: progress.length,
      conceptsMastered: mastered,
      avgScore,
      lastSessionAt: lastSession?.started_at ?? null,
    };
  });

  return {
    profile,
    stats: {
      totalStudents,
      conceptsMastered,
      avgEngagement,
    },
    proficiency,
    recentSessions: recentSessions.map((s) => ({
      studentName: s.student?.full_name ?? 'Student',
      startedAt: s.started_at,
      endedAt: s.ended_at,
      isActive: s.is_active,
    })),
    recentAchievements: recentAchievements.map((p) => ({
      studentName: p.student?.full_name ?? 'Student',
      conceptKey: p.concept_key,
      categoryKey: p.category_key,
      passedAt: p.tier1_passed_at,
    })),
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

async function setThreshold(teacherId, studentId, letter, value) {
  const student = await Student.findOne({
    where: { sid: studentId, teacher_id: teacherId },
    attributes: ['sid', 'personal_thresholds'],
  });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const updated = { ...student.personal_thresholds, [letter]: value };
  await student.update({ personal_thresholds: updated });
  return { student_id: student.sid, letter, value, personal_thresholds: updated };
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
  setThreshold,
  setAvatar,
};

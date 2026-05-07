'use strict';

const { Op } = require('sequelize');
const {
  Teacher,
  Student,
  Session,
  StudentAvatar,
  PronunciationSessionResult,
} = require('../models');
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
  // Verify the student belongs to this teacher
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

async function startSession(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

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

async function savePronunciationResult(teacherId, studentId, data) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');
  const rawAudioBuffer = data.raw_audio_base64
    ? Buffer.from(data.raw_audio_base64, 'base64')
    : null;

  return PronunciationSessionResult.create({
    teacher_id: teacherId,
    student_id: studentId,
    mode: data.mode,
    category_id: data.category_id || null,
    word_id: data.word_id,
    word_label: data.word_label,
    overall_score: data.overall_score,
    phoneme_scores: data.phoneme_scores || [],
    response_duration: data.response_duration ?? null,
    hesitation_time: data.hesitation_time ?? null,
    recommendation_type: data.recommendation_type || null,
    recommendation_message: data.recommendation_message || null,
    next_word_id: data.next_word_id || null,
    attempt_number: data.attempt_number || 1,
    recording_uri: data.recording_uri || null,
    raw_audio_data: rawAudioBuffer,
    raw_audio_mime_type: data.raw_audio_mime_type || null,
    raw_audio_size: rawAudioBuffer?.length || data.raw_audio_size || null,
  });
}

async function getPronunciationResults(teacherId, studentId) {
  const student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId } });
  if (!student) throw new ApiError(404, 'Student not found or not assigned to you');

  const results = await PronunciationSessionResult.findAll({
    where: { teacher_id: teacherId, student_id: studentId },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });

  return results
    .map((result, index) => {
      const plain = result.get({ plain: true });
      const hasRawAudio = Boolean(plain.raw_audio_data);
      delete plain.raw_audio_data;

      return {
        ...plain,
        has_raw_audio: hasRawAudio,
        session_number: index + 1,
      };
    })
    .reverse();
}

async function getPronunciationResultAudio(teacherId, resultId) {
  const result = await PronunciationSessionResult.findOne({
    where: { id: resultId, teacher_id: teacherId },
    attributes: [
      'id',
      'raw_audio_data',
      'raw_audio_mime_type',
      'raw_audio_size',
    ],
  });

  if (!result) throw new ApiError(404, 'Pronunciation result not found');
  if (!result.raw_audio_data) throw new ApiError(404, 'No audio saved for this session');

  return {
    id: result.id,
    raw_audio_base64: Buffer.from(result.raw_audio_data).toString('base64'),
    raw_audio_mime_type: result.raw_audio_mime_type || 'audio/mp4',
    raw_audio_size: result.raw_audio_size || result.raw_audio_data.length,
  };
}

// Flatten avatarRecord association into a plain avatar_key field
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
  startSession,
  endSession,
  savePronunciationResult,
  getPronunciationResults,
  getPronunciationResultAudio,
};

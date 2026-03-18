'use strict';

const { sequelize, Teacher, Student, Session, Principal } = require('../models');
const { generateCode } = require('../utils/codeGenerator');
const { uploadBuffer, deleteBlob, extractBlobPath, buildBlobPath } = require('./blobService');
const { hashPassword } = require('./authService');
const ApiError = require('../utils/ApiError');

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function getDashboardStats() {
  const [teacherCount, studentCount, activeSessionCount] = await Promise.all([
    Teacher.count(),
    Student.count(),
    Session.count({ where: { is_active: true } }),
  ]);
  return { teacherCount, studentCount, activeSessionCount };
}

// ─── Teachers ────────────────────────────────────────────────────────────────

async function createTeacher(data, file, principalId) {
  const t = await sequelize.transaction();
  try {
    const teacher_code = await generateCode(Teacher, 'teacher_code', 'TCH', t);
    const password_hash = await hashPassword(data.password);

    let profile_photo_url = null;
    if (file) {
      const blobPath = buildBlobPath('teachers', teacher_code, file.originalname);
      profile_photo_url = await uploadBuffer(file.buffer, blobPath, file.mimetype);
    }

    const teacher = await Teacher.create({
      teacher_code,
      full_name: data.full_name,
      email: data.email,
      password_hash,
      profile_photo_url,
      created_by: principalId,
    }, { transaction: t });

    await t.commit();
    const { password_hash: _, ...safeTeacher } = teacher.toJSON();
    return safeTeacher;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function getTeachers() {
  const teachers = await Teacher.findAll({
    attributes: { exclude: ['password_hash'] },
    include: [{ model: Student, as: 'students', attributes: ['sid', 'full_name', 'student_code'] }],
    order: [['teacher_code', 'ASC']],
  });
  return teachers;
}

async function getTeacherById(id) {
  const teacher = await Teacher.findByPk(id, {
    attributes: { exclude: ['password_hash'] },
    include: [{ model: Student, as: 'students', attributes: { exclude: [] } }],
  });
  if (!teacher) throw new ApiError(404, 'Teacher not found');
  return teacher;
}

async function updateTeacher(id, data, file) {
  const teacher = await Teacher.findByPk(id);
  if (!teacher) throw new ApiError(404, 'Teacher not found');

  let profile_photo_url = teacher.profile_photo_url;
  if (file) {
    // Delete old blob if exists
    const oldPath = extractBlobPath(teacher.profile_photo_url);
    if (oldPath) await deleteBlob(oldPath);

    const blobPath = buildBlobPath('teachers', teacher.teacher_code, file.originalname);
    profile_photo_url = await uploadBuffer(file.buffer, blobPath, file.mimetype);
  }

  const updates = {};
  if (data.full_name)  updates.full_name = data.full_name;
  if (data.email)      updates.email = data.email;
  if (file)            updates.profile_photo_url = profile_photo_url;

  await teacher.update(updates);
  const { password_hash: _, ...safeTeacher } = teacher.toJSON();
  return safeTeacher;
}

async function deleteTeacher(id) {
  const teacher = await Teacher.findByPk(id);
  if (!teacher) throw new ApiError(404, 'Teacher not found');

  const activeSessions = await Session.count({ where: { teacher_id: id, is_active: true } });
  if (activeSessions > 0) {
    throw new ApiError(409, 'Cannot delete teacher with active sessions');
  }

  // Unassign students
  await Student.update({ teacher_id: null }, { where: { teacher_id: id } });

  // Clean up profile photo from blob storage
  const oldPath = extractBlobPath(teacher.profile_photo_url);
  if (oldPath) await deleteBlob(oldPath);

  await teacher.destroy();
}

// ─── Students ────────────────────────────────────────────────────────────────

async function createStudent(data, file) {
  const t = await sequelize.transaction();
  try {
    const student_code = await generateCode(Student, 'student_code', 'STU', t);

    let profile_photo_url = null;
    if (file) {
      const blobPath = buildBlobPath('students', student_code, file.originalname);
      profile_photo_url = await uploadBuffer(file.buffer, blobPath, file.mimetype);
    }

    const student = await Student.create({
      student_code,
      full_name:      data.full_name,
      date_of_birth:  data.date_of_birth,
      disability:     data.disability,
      father_name:    data.father_name    || null,
      mother_name:    data.mother_name    || null,
      address:        data.address        || null,
      marital_status: data.marital_status || null,
      mobile_number:  data.mobile_number  || null,
      home_number:    data.home_number    || null,
      profile_photo_url,
    }, { transaction: t });

    await t.commit();
    return student;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function getStudents() {
  return Student.findAll({
    include: [{ model: Teacher, as: 'teacher', attributes: ['tid', 'full_name', 'teacher_code'] }],
    order: [['student_code', 'ASC']],
  });
}

async function getStudentById(id) {
  const student = await Student.findByPk(id, {
    include: [{ model: Teacher, as: 'teacher', attributes: ['tid', 'full_name', 'teacher_code'] }],
  });
  if (!student) throw new ApiError(404, 'Student not found');
  return student;
}

async function updateStudent(id, data, file) {
  const student = await Student.findByPk(id);
  if (!student) throw new ApiError(404, 'Student not found');

  let profile_photo_url = student.profile_photo_url;
  if (file) {
    const oldPath = extractBlobPath(student.profile_photo_url);
    if (oldPath) await deleteBlob(oldPath);
    const blobPath = buildBlobPath('students', student.student_code, file.originalname);
    profile_photo_url = await uploadBuffer(file.buffer, blobPath, file.mimetype);
  }

  const fields = ['full_name', 'date_of_birth', 'disability', 'father_name',
                  'mother_name', 'address', 'marital_status', 'mobile_number', 'home_number'];
  const updates = {};
  fields.forEach((f) => { if (data[f] !== undefined) updates[f] = data[f]; });
  if (file) updates.profile_photo_url = profile_photo_url;

  await student.update(updates);
  return student;
}

async function deleteStudent(id) {
  const student = await Student.findByPk(id);
  if (!student) throw new ApiError(404, 'Student not found');

  const oldPath = extractBlobPath(student.profile_photo_url);
  if (oldPath) await deleteBlob(oldPath);

  await student.destroy();
}

async function assignStudent(studentId, teacherId) {
  // teacherId can be null to unassign
  if (teacherId !== null && teacherId !== undefined) {
    const teacher = await Teacher.findByPk(teacherId);
    if (!teacher) throw new ApiError(404, 'Teacher not found');

    const t = await sequelize.transaction();
    try {
      const count = await Student.count({
        where: { teacher_id: teacherId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (count >= 3) {
        await t.rollback();
        throw new ApiError(400, 'Teacher already has the maximum of 3 students assigned');
      }
      await Student.update(
        { teacher_id: teacherId },
        { where: { sid: studentId }, transaction: t }
      );
      await t.commit();
    } catch (err) {
      // Only rollback if transaction hasn't already been rolled back/committed
      if (!err.statusCode) await t.rollback();
      throw err;
    }
  } else {
    // Unassign
    const student = await Student.findByPk(studentId);
    if (!student) throw new ApiError(404, 'Student not found');
    await student.update({ teacher_id: null });
  }

  return getStudentById(studentId);
}

module.exports = {
  getDashboardStats,
  createTeacher, getTeachers, getTeacherById, updateTeacher, deleteTeacher,
  createStudent, getStudents, getStudentById, updateStudent, deleteStudent, assignStudent,
};

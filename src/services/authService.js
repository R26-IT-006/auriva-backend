'use strict';

const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Principal, Teacher } = require('../models');
const ApiError = require('../utils/ApiError');

const SALT_ROUNDS = 12;

async function loginPrincipal(username, password) {
  const principal = await Principal.findOne({ where: { username } });
  if (!principal) throw new ApiError(401, 'Invalid credentials');

  const valid = await bcrypt.compare(password, principal.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  return jwt.sign(
    { id: principal.id, role: 'principal' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

async function loginTeacher(email, password) {
  const teacher = await Teacher.findOne({ where: { email } });
  if (!teacher) throw new ApiError(401, 'Invalid credentials');

  const valid = await bcrypt.compare(password, teacher.password_hash);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  return jwt.sign(
    { id: teacher.tid, role: 'teacher', is_first_login: teacher.is_first_login },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

/**
 * Set a new password for a teacher on first login.
 * Returns a fresh JWT with is_first_login: false.
 */
async function setTeacherPassword(teacherId, newPassword) {
  const teacher = await Teacher.findByPk(teacherId);
  if (!teacher) throw new ApiError(404, 'Teacher not found');
  if (!teacher.is_first_login) throw new ApiError(400, 'Password has already been set');

  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await teacher.update({ password_hash: hash, is_first_login: false });

  return jwt.sign(
    { id: teacher.tid, role: 'teacher', is_first_login: false },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

async function hashPassword(plainText) {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

module.exports = { loginPrincipal, loginTeacher, setTeacherPassword, hashPassword };

'use strict';

const sequelize          = require('../config/database');
const Principal          = require('./Principal');
const Teacher            = require('./Teacher');
const Student            = require('./Student');
const Session            = require('./Session');
const StudentAvatar      = require('./StudentAvatar');
const PasswordResetOtp   = require('./PasswordResetOtp');
const PronunciationSessionResult = require('./PronunciationSessionResult');

// Principal → Teacher
Principal.hasMany(Teacher, { foreignKey: 'created_by', as: 'teachers' });
Teacher.belongsTo(Principal, { foreignKey: 'created_by', as: 'creator' });

// Teacher → Student (max 5 enforced at service layer)
Teacher.hasMany(Student, { foreignKey: 'teacher_id', as: 'students' });
Student.belongsTo(Teacher, { foreignKey: 'teacher_id', as: 'teacher' });

// Teacher → Session
Teacher.hasMany(Session, { foreignKey: 'teacher_id', as: 'sessions' });
Session.belongsTo(Teacher, { foreignKey: 'teacher_id', as: 'teacher' });

// Student → Session
Student.hasMany(Session, { foreignKey: 'student_id', as: 'sessions' });
Session.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student ↔ StudentAvatar (one-to-one)
Student.hasOne(StudentAvatar, { foreignKey: 'student_id', as: 'avatarRecord' });
StudentAvatar.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Teacher → PronunciationSessionResult
Teacher.hasMany(PronunciationSessionResult, {
  foreignKey: 'teacher_id',
  as: 'pronunciationResults',
});
PronunciationSessionResult.belongsTo(Teacher, { foreignKey: 'teacher_id', as: 'teacher' });

// Student → PronunciationSessionResult
Student.hasMany(PronunciationSessionResult, {
  foreignKey: 'student_id',
  as: 'pronunciationResults',
});
PronunciationSessionResult.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

module.exports = {
  sequelize,
  Principal,
  Teacher,
  Student,
  Session,
  StudentAvatar,
  PasswordResetOtp,
  PronunciationSessionResult,
};

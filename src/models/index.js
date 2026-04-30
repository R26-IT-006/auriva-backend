'use strict';

const sequelize              = require('../config/database');
const Principal              = require('./Principal');
const Teacher                = require('./Teacher');
const Student                = require('./Student');
const Session                = require('./Session');
const StudentAvatar          = require('./StudentAvatar');
const PasswordResetOtp       = require('./PasswordResetOtp');
const DialogueWord           = require('./DialogueWord');
const DialogueWordProgress   = require('./DialogueWordProgress');
const DialogueWordAttempt    = require('./DialogueWordAttempt');

// Principal → Teacher
Principal.hasMany(Teacher, { foreignKey: 'created_by', as: 'teachers' });
Teacher.belongsTo(Principal, { foreignKey: 'created_by', as: 'creator' });

// Teacher → Student (max 3 enforced at service layer)
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

// DialogueWord ↔ DialogueWordProgress
DialogueWord.hasMany(DialogueWordProgress, { foreignKey: 'word_id', as: 'progress' });
DialogueWordProgress.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'word' });

// Student ↔ DialogueWordProgress
Student.hasMany(DialogueWordProgress, { foreignKey: 'student_id', as: 'dialogueProgress' });
DialogueWordProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// DialogueWord ↔ DialogueWordAttempt
DialogueWord.hasMany(DialogueWordAttempt, { foreignKey: 'word_id', as: 'attempts' });
DialogueWordAttempt.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'word' });

// Student ↔ DialogueWordAttempt
Student.hasMany(DialogueWordAttempt, { foreignKey: 'student_id', as: 'dialogueAttempts' });
DialogueWordAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Session ↔ DialogueWordAttempt
Session.hasMany(DialogueWordAttempt, { foreignKey: 'session_id', as: 'wordAttempts' });
DialogueWordAttempt.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

module.exports = {
  sequelize,
  Principal,
  Teacher,
  Student,
  Session,
  StudentAvatar,
  PasswordResetOtp,
  DialogueWord,
  DialogueWordProgress,
  DialogueWordAttempt,
};
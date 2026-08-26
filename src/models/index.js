'use strict';

const sequelize                = require('../config/database');
const Principal                = require('./Principal');
const Teacher                  = require('./Teacher');
const Student                  = require('./Student');
const Session                  = require('./Session');
const StudentAvatar            = require('./StudentAvatar');
const PasswordResetOtp         = require('./PasswordResetOtp');
const StudentConceptProgress   = require('./StudentConceptProgress');
const ConceptInteractionLog    = require('./ConceptInteractionLog');
const StudentActivity          = require('./StudentActivity');
const ColoringArtwork          = require('./ColoringArtwork');
const StudentNote              = require('./StudentNote');
const AiSummary                = require('./AiSummary');

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

// Student → concept learning
Student.hasMany(StudentConceptProgress, { foreignKey: 'student_id', as: 'conceptProgress' });
StudentConceptProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

Student.hasMany(ConceptInteractionLog, { foreignKey: 'student_id', as: 'conceptLogs' });
ConceptInteractionLog.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → cross-concept activities
Student.hasMany(StudentActivity, { foreignKey: 'student_id', as: 'activities' });
StudentActivity.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → tier 3 colouring artwork
Student.hasMany(ColoringArtwork, { foreignKey: 'student_id', as: 'coloringArtworks' });
ColoringArtwork.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → teacher notes/reminders
Student.hasMany(StudentNote, { foreignKey: 'student_id', as: 'notes' });
StudentNote.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Teacher.hasMany(StudentNote, { foreignKey: 'teacher_id', as: 'studentNotes' });
StudentNote.belongsTo(Teacher, { foreignKey: 'teacher_id', as: 'teacher' });

// AiSummary has no association on purpose — subject_id addresses either a student
// or a teacher depending on scope, so there is no single relation to declare.

module.exports = {
  sequelize,
  Principal,
  Teacher,
  Student,
  Session,
  StudentAvatar,
  PasswordResetOtp,
  StudentConceptProgress,
  ConceptInteractionLog,
  StudentActivity,
  ColoringArtwork,
  StudentNote,
  AiSummary,
};
'use strict';

const sequelize               = require('../config/database');
const Principal               = require('./Principal');
const Teacher                 = require('./Teacher');
const Student                 = require('./Student');
const Session                 = require('./Session');
const StudentAvatar           = require('./StudentAvatar');
const PasswordResetOtp        = require('./PasswordResetOtp');
const HandwritingAssessment   = require('./HandwritingAssessment');
const LetterProgress          = require('./LetterProgress');
const Stroke                  = require('./Stroke');
const ExplanationResult       = require('./ExplanationResult');
const RecommendationHistory   = require('./RecommendationHistory');
const StudentMotorFeature     = require('./StudentMotorFeature');

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

// Student → HandwritingAssessment
Student.hasMany(HandwritingAssessment, { foreignKey: 'student_id', as: 'handwritingAssessments' });
HandwritingAssessment.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

Student.hasMany(StudentMotorFeature, { foreignKey: 'student_id', as: 'motorFeatures' });
StudentMotorFeature.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

HandwritingAssessment.hasOne(StudentMotorFeature, { foreignKey: 'assessment_id', as: 'motorFeature' });
StudentMotorFeature.belongsTo(HandwritingAssessment, { foreignKey: 'assessment_id', as: 'assessment' });

// Student → LetterProgress
Student.hasMany(LetterProgress, { foreignKey: 'student_id', as: 'letterProgress' });
LetterProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// HandwritingAssessment → Stroke (one assessment has many strokes)
HandwritingAssessment.hasMany(Stroke, { foreignKey: 'assessment_id', as: 'strokes' });
Stroke.belongsTo(HandwritingAssessment, { foreignKey: 'assessment_id', as: 'assessment' });

// Student → Stroke
Student.hasMany(Stroke, { foreignKey: 'student_id', as: 'strokes' });
Stroke.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → ExplanationResult
Student.hasMany(ExplanationResult, { foreignKey: 'student_id', as: 'explanationResults' });
ExplanationResult.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// HandwritingAssessment → ExplanationResult
HandwritingAssessment.hasOne(ExplanationResult, { foreignKey: 'assessment_id', as: 'explanation' });
ExplanationResult.belongsTo(HandwritingAssessment, { foreignKey: 'assessment_id', as: 'assessment' });

// Student → RecommendationHistory
Student.hasMany(RecommendationHistory, { foreignKey: 'student_id', as: 'recommendationHistory' });
RecommendationHistory.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

module.exports = {
  sequelize, Principal, Teacher, Student, Session, StudentAvatar, PasswordResetOtp,
  HandwritingAssessment, LetterProgress, Stroke,
  ExplanationResult, RecommendationHistory, StudentMotorFeature,
};

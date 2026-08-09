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
const ShapeFeature            = require('./ShapeFeature');
const LetterAttempt           = require('./LetterAttempt');
const CollectionSession       = require('./CollectionSession');
const TeacherValidation       = require('./TeacherValidation');
const StudentMotorBaseline    = require('./StudentMotorBaseline');
const ThresholdHistory        = require('./ThresholdHistory');

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

// HandwritingAssessment → ShapeFeature (one row per shape per assessment)
HandwritingAssessment.hasMany(ShapeFeature, { foreignKey: 'assessment_id', as: 'shapeFeatures' });
ShapeFeature.belongsTo(HandwritingAssessment, { foreignKey: 'assessment_id', as: 'assessment' });

// Student → ShapeFeature
Student.hasMany(ShapeFeature, { foreignKey: 'student_id', as: 'shapeFeatures' });
ShapeFeature.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → LetterAttempt (append-only; one row per attempt per POST call)
Student.hasMany(LetterAttempt, { foreignKey: 'student_id', as: 'letterAttempts' });
LetterAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → CollectionSession
Student.hasMany(CollectionSession, { foreignKey: 'student_id', as: 'collectionSessions' });
CollectionSession.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → TeacherValidation
Student.hasMany(TeacherValidation, { foreignKey: 'student_id', as: 'teacherValidations' });
TeacherValidation.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → StudentMotorBaseline (one immutable baseline per source assessment;
// a student could in principle have more than one over time — see Decision 7 —
// so this is hasMany, not hasOne)
Student.hasMany(StudentMotorBaseline, { foreignKey: 'student_id', as: 'motorBaselines' });
StudentMotorBaseline.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// HandwritingAssessment → StudentMotorBaseline (one baseline per source assessment,
// enforced by the UNIQUE(source_assessment_id) index)
HandwritingAssessment.hasOne(StudentMotorBaseline, { foreignKey: 'source_assessment_id', as: 'motorBaseline' });
StudentMotorBaseline.belongsTo(HandwritingAssessment, { foreignKey: 'source_assessment_id', as: 'sourceAssessment' });

// Feature 2 Step 1: Student → ThresholdHistory (append-only threshold
// change/provenance log — see src/models/ThresholdHistory.js)
Student.hasMany(ThresholdHistory, { foreignKey: 'student_id', as: 'thresholdHistory' });
ThresholdHistory.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// StudentMotorBaseline → ThresholdHistory (conceptual link only, app-layer —
// which baseline a given threshold event was derived from, if any)
StudentMotorBaseline.hasMany(ThresholdHistory, { foreignKey: 'baseline_id', as: 'thresholdHistoryEntries' });
ThresholdHistory.belongsTo(StudentMotorBaseline, { foreignKey: 'baseline_id', as: 'baseline' });

module.exports = {
  sequelize, Principal, Teacher, Student, Session, StudentAvatar, PasswordResetOtp,
  HandwritingAssessment, LetterProgress, Stroke, ShapeFeature, LetterAttempt,
  ExplanationResult, RecommendationHistory, StudentMotorFeature,
  CollectionSession, TeacherValidation, StudentMotorBaseline, ThresholdHistory,
};

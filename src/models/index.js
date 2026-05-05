'use strict';

const sequelize                  = require('../config/database');
const Principal                  = require('./Principal');
const Teacher                    = require('./Teacher');
const Student                    = require('./Student');
const Session                    = require('./Session');
const StudentAvatar              = require('./StudentAvatar');
const PasswordResetOtp           = require('./PasswordResetOtp');
const DialogueWord               = require('./DialogueWord');
const DialogueWordProgress       = require('./DialogueWordProgress');
const DialogueWordAttempt        = require('./DialogueWordAttempt');
const DaysWheelAttempt           = require('./DaysWheelAttempt');
const SentenceQuestionnaire      = require('./SentenceQuestionnaire');
const Level2TopicProgress        = require('./Level2TopicProgress');
const Level2Session              = require('./Level2Session');
const Level2SentenceAttempt      = require('./Level2SentenceAttempt');
const Level2GenderSelectionLog   = require('./Level2GenderSelectionLog');
const Level2ActivitySelectionLog = require('./Level2ActivitySelectionLog');
const Level2ProductionAttempt    = require('./Level2ProductionAttempt');
const Level2NonVerbalAttempt     = require('./Level2NonVerbalAttempt');

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

// DaysWheelAttempt associations
Student.hasMany(DaysWheelAttempt, { foreignKey: 'student_id', as: 'wheelAttempts' });
DaysWheelAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

Session.hasMany(DaysWheelAttempt, { foreignKey: 'session_id', as: 'wheelAttempts' });
DaysWheelAttempt.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

DialogueWord.hasMany(DaysWheelAttempt, { foreignKey: 'target_word_id', as: 'wheelTargetAttempts' });
DaysWheelAttempt.belongsTo(DialogueWord, { foreignKey: 'target_word_id', as: 'targetWord' });

// ── Level 2 associations ─────────────────────────────────────────────────

// SentenceQuestionnaire: one per student, authored by a teacher
Student.hasOne(SentenceQuestionnaire, { foreignKey: 'student_id', as: 'questionnaire' });
SentenceQuestionnaire.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Teacher.hasMany(SentenceQuestionnaire, { foreignKey: 'teacher_id', as: 'questionnaires' });
SentenceQuestionnaire.belongsTo(Teacher, { foreignKey: 'teacher_id', as: 'teacher' });

// Level2TopicProgress: one record per student+topic
Student.hasMany(Level2TopicProgress, { foreignKey: 'student_id', as: 'level2Progress' });
Level2TopicProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Level2Session
Student.hasMany(Level2Session, { foreignKey: 'student_id', as: 'level2Sessions' });
Level2Session.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Teacher.hasMany(Level2Session, { foreignKey: 'teacher_id', as: 'level2Sessions' });
Level2Session.belongsTo(Teacher, { foreignKey: 'teacher_id', as: 'teacher' });
Session.hasMany(Level2Session, { foreignKey: 'session_id', as: 'level2Sessions' });
Level2Session.belongsTo(Session, { foreignKey: 'session_id', as: 'parentSession' });

// Level2SentenceAttempt
Level2Session.hasMany(Level2SentenceAttempt, { foreignKey: 'level2_session_id', as: 'sentenceAttempts' });
Level2SentenceAttempt.belongsTo(Level2Session, { foreignKey: 'level2_session_id', as: 'level2Session' });

// Level2GenderSelectionLog
Level2Session.hasOne(Level2GenderSelectionLog, { foreignKey: 'level2_session_id', as: 'genderSelection' });
Level2GenderSelectionLog.belongsTo(Level2Session, { foreignKey: 'level2_session_id', as: 'level2Session' });

// Level2ActivitySelectionLog
Level2Session.hasOne(Level2ActivitySelectionLog, { foreignKey: 'level2_session_id', as: 'activitySelection' });
Level2ActivitySelectionLog.belongsTo(Level2Session, { foreignKey: 'level2_session_id', as: 'level2Session' });

// Level2ProductionAttempt
Level2Session.hasMany(Level2ProductionAttempt, { foreignKey: 'level2_session_id', as: 'productionAttempts' });
Level2ProductionAttempt.belongsTo(Level2Session, { foreignKey: 'level2_session_id', as: 'level2Session' });

// Level2NonVerbalAttempt
Level2Session.hasMany(Level2NonVerbalAttempt, { foreignKey: 'level2_session_id', as: 'nonVerbalAttempts' });
Level2NonVerbalAttempt.belongsTo(Level2Session, { foreignKey: 'level2_session_id', as: 'level2Session' });

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
  DaysWheelAttempt,
  SentenceQuestionnaire,
  Level2TopicProgress,
  Level2Session,
  Level2SentenceAttempt,
  Level2GenderSelectionLog,
  Level2ActivitySelectionLog,
  Level2ProductionAttempt,
  Level2NonVerbalAttempt,
};
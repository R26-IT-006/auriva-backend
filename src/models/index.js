'use strict';

const DialogueWord               = require('./DialogueWord');
const DialogueWordProgress       = require('./DialogueWordProgress');
const DialogueWordAttempt        = require('./DialogueWordAttempt');
const DialoguePhase3Attempt      = require('./DialoguePhase3Attempt');
const DaysWheelAttempt           = require('./DaysWheelAttempt');
const SentenceQuestionnaire      = require('./SentenceQuestionnaire');
const Level2TopicProgress        = require('./Level2TopicProgress');
const Level2Session              = require('./Level2Session');
const Level2SentenceAttempt      = require('./Level2SentenceAttempt');
const Level2GenderSelectionLog   = require('./Level2GenderSelectionLog');
const Level2ActivitySelectionLog = require('./Level2ActivitySelectionLog');
const Level2ProductionAttempt    = require('./Level2ProductionAttempt');
const Level2NonVerbalAttempt     = require('./Level2NonVerbalAttempt');
const ActionWordAttempt          = require('./ActionWordAttempt');
const CanYouGameRound            = require('./CanYouGameRound');
const ActionIdentificationRound  = require('./ActionIdentificationRound');
const VerbQAProductionRound      = require('./VerbQAProductionRound');
const DialogueEvaluationAttempt  = require('./DialogueEvaluationAttempt');
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
const StudentConceptProgress   = require('./StudentConceptProgress');
const ConceptInteractionLog    = require('./ConceptInteractionLog');
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

// DialogueWord ↔ DialogueWordProgress
DialogueWord.hasMany(DialogueWordProgress, { foreignKey: 'word_id', as: 'progress' });
DialogueWordProgress.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'word' });

// Student ↔ DialogueWordProgress
Student.hasMany(DialogueWordProgress, { foreignKey: 'student_id', as: 'dialogueProgress' });
DialogueWordProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// DialogueWordProgress cat3Progress aliases (used by category3Service.js)
DialogueWord.hasMany(DialogueWordProgress, { foreignKey: 'word_id', as: 'cat3Progress' });
DialogueWordProgress.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'cat3ProgressWord' });
Student.hasMany(DialogueWordProgress, { foreignKey: 'student_id', as: 'cat3ProgressRecords' });

// DialogueWord ↔ DialogueWordAttempt
DialogueWord.hasMany(DialogueWordAttempt, { foreignKey: 'word_id', as: 'attempts' });
DialogueWordAttempt.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'word' });

// Student ↔ DialogueWordAttempt
Student.hasMany(DialogueWordAttempt, { foreignKey: 'student_id', as: 'dialogueAttempts' });
DialogueWordAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Session ↔ DialogueWordAttempt
Session.hasMany(DialogueWordAttempt, { foreignKey: 'session_id', as: 'wordAttempts' });
DialogueWordAttempt.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

// DialogueWord ↔ DialoguePhase3Attempt
DialogueWord.hasMany(DialoguePhase3Attempt, { foreignKey: 'word_id', as: 'phase3Attempts' });
DialoguePhase3Attempt.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'word' });

// Student ↔ DialoguePhase3Attempt
Student.hasMany(DialoguePhase3Attempt, { foreignKey: 'student_id', as: 'phase3Attempts' });
DialoguePhase3Attempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Session ↔ DialoguePhase3Attempt
Session.hasMany(DialoguePhase3Attempt, { foreignKey: 'session_id', as: 'phase3WordAttempts' });
DialoguePhase3Attempt.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

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

// ── Category 3 associations ───────────────────────────────────────────────
// All Cat3 word lookups use DialogueWord (category='abilities').
// Yes and No standalone words are seeded into dialogue_words alongside Clap–Sing.

// DialogueWord ↔ ActionWordAttempt
DialogueWord.hasMany(ActionWordAttempt, { foreignKey: 'word_id', as: 'cat3Attempts' });
ActionWordAttempt.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'dialogueWord' });

// Student ↔ ActionWordAttempt
Student.hasMany(ActionWordAttempt, { foreignKey: 'student_id', as: 'actionWordAttempts' });
ActionWordAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Session ↔ ActionWordAttempt
Session.hasMany(ActionWordAttempt, { foreignKey: 'session_id', as: 'actionWordAttempts' });
ActionWordAttempt.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

// CanYouGameRound associations
DialogueWord.hasMany(CanYouGameRound, { foreignKey: 'word_id', as: 'canYouRounds' });
CanYouGameRound.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'dialogueWord' });
Student.hasMany(CanYouGameRound, { foreignKey: 'student_id', as: 'canYouRounds' });
CanYouGameRound.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Session.hasMany(CanYouGameRound, { foreignKey: 'session_id', as: 'canYouRounds' });
CanYouGameRound.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

// ActionIdentificationRound associations
DialogueWord.hasMany(ActionIdentificationRound, { foreignKey: 'word_id', as: 'identificationRounds' });
ActionIdentificationRound.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'dialogueWord' });
Student.hasMany(ActionIdentificationRound, { foreignKey: 'student_id', as: 'identificationRounds' });
ActionIdentificationRound.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Session.hasMany(ActionIdentificationRound, { foreignKey: 'session_id', as: 'identificationRounds' });
ActionIdentificationRound.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

// VerbQAProductionRound associations
DialogueWord.hasMany(VerbQAProductionRound, { foreignKey: 'word_id', as: 'verbQARounds' });
VerbQAProductionRound.belongsTo(DialogueWord, { foreignKey: 'word_id', as: 'dialogueWord' });
Student.hasMany(VerbQAProductionRound, { foreignKey: 'student_id', as: 'verbQARounds' });
VerbQAProductionRound.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Session.hasMany(VerbQAProductionRound, { foreignKey: 'session_id', as: 'verbQARounds' });
VerbQAProductionRound.belongsTo(Session, { foreignKey: 'session_id', as: 'session' });

// DialogueEvaluationAttempt associations (Level 1 evaluations, TASK-14)
Student.hasMany(DialogueEvaluationAttempt, { foreignKey: 'student_id', as: 'evaluationAttempts' });
DialogueEvaluationAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
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

// Student → concept learning
Student.hasMany(StudentConceptProgress, { foreignKey: 'student_id', as: 'conceptProgress' });
StudentConceptProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

Student.hasMany(ConceptInteractionLog, { foreignKey: 'student_id', as: 'conceptLogs' });
ConceptInteractionLog.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

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
  DialoguePhase3Attempt,
  DaysWheelAttempt,
  SentenceQuestionnaire,
  Level2TopicProgress,
  Level2Session,
  Level2SentenceAttempt,
  Level2GenderSelectionLog,
  Level2ActivitySelectionLog,
  Level2ProductionAttempt,
  Level2NonVerbalAttempt,
  ActionWordAttempt,
  CanYouGameRound,
  ActionIdentificationRound,
  VerbQAProductionRound,
  DialogueEvaluationAttempt,
  StudentConceptProgress,
  ConceptInteractionLog,
  HandwritingAssessment,
  LetterProgress,
  Stroke,
  ShapeFeature,
  LetterAttempt,
  ExplanationResult,
  RecommendationHistory,
  StudentMotorFeature,
  CollectionSession,
  TeacherValidation,
  PronunciationSessionResult,
};

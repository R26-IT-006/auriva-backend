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
const DialogueEvaluationAttempt  = require('./DialogueEvaluationAttempt');
const StudentConceptProgress     = require('./StudentConceptProgress');
const ConceptInteractionLog      = require('./ConceptInteractionLog');
const StudentActivity            = require('./StudentActivity');
const ColoringArtwork            = require('./ColoringArtwork');
const StudentNote                = require('./StudentNote');
const AiSummary                  = require('./AiSummary');
const ConceptReport              = require('./ConceptReport');
const PronunciationSessionResult = require('./PronunciationSessionResult');
const HandwritingAssessment      = require('./HandwritingAssessment');
const LetterProgress             = require('./LetterProgress');
const Stroke                     = require('./Stroke');
const ExplanationResult          = require('./ExplanationResult');
const RecommendationHistory      = require('./RecommendationHistory');
const StudentMotorFeature        = require('./StudentMotorFeature');
const ShapeFeature               = require('./ShapeFeature');
const LetterAttempt              = require('./LetterAttempt');
const CollectionSession          = require('./CollectionSession');
const TeacherValidation          = require('./TeacherValidation');
const StudentMotorBaseline       = require('./StudentMotorBaseline');
const ThresholdHistory           = require('./ThresholdHistory');
const TeacherRecommendationValidation = require('./TeacherRecommendationValidation');
const WordWritingAttempt         = require('./WordWritingAttempt');
const WordActivityProgress       = require('./WordActivityProgress');
const LetterMotorMasteryEvidence = require('./LetterMotorMasteryEvidence');
const LetterMotorStateHistory    = require('./LetterMotorStateHistory');
const LetterMotorStateEvaluation = require('./LetterMotorStateEvaluation');
const LetterMotorPatternCheck    = require('./LetterMotorPatternCheck');
const HandwritingWorksheet       = require('./HandwritingWorksheet');
const HandwritingWorksheetSubmission = require('./HandwritingWorksheetSubmission');
// Proposal FR-16, Phase 7B — current live-session snapshot (see
// src/services/liveSessionService.js). One row per student.
const StudentLiveHandwritingSession  = require('./StudentLiveHandwritingSession');

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

// Student → frozen concept reports. Cascades: a deleted child takes their saved
// reports with them, which is what a data-protection request means in practice.
Student.hasMany(ConceptReport, { foreignKey: 'student_id', as: 'conceptReports' });
ConceptReport.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// AiSummary has no association on purpose — subject_id addresses either a student
// or a teacher depending on scope, so there is no single relation to declare.

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

// Feature 9 Step 3: Student → TeacherRecommendationValidation (append-only
// teacher-judgement history for Feature 8 worksheet recommendations — see
// src/models/TeacherRecommendationValidation.js). No association to Teacher
// is declared here — teacher_id is recorded and read the same
// application-layer-only way every other student_id/teacher_id pair in
// this schema already is (no FK constraint convention, Step 1 audit §52).
Student.hasMany(TeacherRecommendationValidation, { foreignKey: 'student_id', as: 'recommendationValidations' });
TeacherRecommendationValidation.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Student → word writing / word activity progress
Student.hasMany(WordWritingAttempt, { foreignKey: 'student_id', as: 'wordWritingAttempts' });
WordWritingAttempt.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
Student.hasMany(WordActivityProgress, { foreignKey: 'student_id', as: 'wordActivityProgress' });
WordActivityProgress.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Feature 11B Phase 5 — Student → LetterMotorMasteryEvidence (append-only,
// immutable frozen evidence — see src/models/LetterMotorMasteryEvidence.js
// and src/services/letterMotorMasteryService.js). No association to
// LetterAttempt is declared (matches this schema's no-FK convention) —
// letter_attempt_id is recorded for auditability only.
Student.hasMany(LetterMotorMasteryEvidence, { foreignKey: 'student_id', as: 'letterMotorMasteryEvidence' });
LetterMotorMasteryEvidence.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Feature 11B Phase 5 — Student → LetterMotorStateHistory (append-only,
// idempotent milestone snapshots).
Student.hasMany(LetterMotorStateHistory, { foreignKey: 'student_id', as: 'letterMotorStateHistory' });
LetterMotorStateHistory.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Feature 11B S2 — Student -> LetterMotorStateEvaluation (append-only,
// immutable milestone-evaluation events, including reference-range
// rejections — see src/models/LetterMotorStateEvaluation.js).
Student.hasMany(LetterMotorStateEvaluation, { foreignKey: 'student_id', as: 'letterMotorStateEvaluations' });
LetterMotorStateEvaluation.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Writing Check sessions (descriptive assessment only - never mastery).
Student.hasMany(LetterMotorPatternCheck, { foreignKey: 'student_id', as: 'letterMotorPatternChecks' });
LetterMotorPatternCheck.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

// Homework worksheets - teacher-directed support material, never mastery.
Student.hasMany(HandwritingWorksheet, { foreignKey: 'student_id', as: 'handwritingWorksheets' });
HandwritingWorksheet.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });
HandwritingWorksheet.hasMany(HandwritingWorksheetSubmission, { foreignKey: 'worksheet_id', as: 'submissions' });
HandwritingWorksheetSubmission.belongsTo(HandwritingWorksheet, { foreignKey: 'worksheet_id', as: 'worksheet' });

// Proposal FR-16, Phase 7B — Student ↔ StudentLiveHandwritingSession
// (one-to-one: student_id is the live-session table's own primary key).
Student.hasOne(StudentLiveHandwritingSession, { foreignKey: 'student_id', as: 'liveHandwritingSession' });
StudentLiveHandwritingSession.belongsTo(Student, { foreignKey: 'student_id', as: 'student' });

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
  DialogueEvaluationAttempt,
  StudentConceptProgress,
  ConceptInteractionLog,
  StudentActivity,
  ColoringArtwork,
  StudentNote,
  AiSummary,
  ConceptReport,
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
  StudentMotorBaseline,
  ThresholdHistory,
  TeacherRecommendationValidation,
  WordWritingAttempt,
  WordActivityProgress,
  LetterMotorMasteryEvidence,
  LetterMotorStateHistory,
  LetterMotorStateEvaluation,
  LetterMotorPatternCheck,
  HandwritingWorksheet,
  HandwritingWorksheetSubmission,
  StudentLiveHandwritingSession,
};

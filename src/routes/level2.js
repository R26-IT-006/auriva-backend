'use strict';

const router          = require('express').Router();
const { verifyToken } = require('../middleware/auth');
const { isTeacher }   = require('../middleware/roleGuard');
const { body, param, query } = require('express-validator');
const ctrl            = require('../controllers/level2Controller');

router.use(verifyToken, isTeacher);

const VALID_ACTIVITIES = ['Singing', 'Dancing', 'Art', 'Cricket', 'Games', 'Reading'];
const sentenceIndexParam = param('sentenceIndex').isInt({ min: 1, max: 5 }).withMessage('sentenceIndex must be 1–5');

// ── Questionnaire ─────────────────────────────────────────────────────────

router.get('/student/:studentId/level2/questionnaire', ctrl.getQuestionnaire);

router.put('/student/:studentId/level2/questionnaire', [
  body('child_first_name').isString().notEmpty().trim().withMessage('child_first_name is required'),
  body('child_age').isInt({ min: 1, max: 18 }).withMessage('child_age must be a whole number between 1 and 18'),
  body('child_hometown').isString().notEmpty().trim().withMessage('child_hometown is required'),
  body('child_gender').isIn(['boy', 'girl']).withMessage('child_gender must be boy or girl'),
  body('favourite_activities')
    .isArray({ min: 1, max: 3 })
    .withMessage('favourite_activities must be an array of 1–3 items')
    .custom((arr) => arr.every((a) => VALID_ACTIVITIES.includes(a)))
    .withMessage(`favourite_activities items must be one of: ${VALID_ACTIVITIES.join(', ')}`),
], ctrl.saveQuestionnaire);

// Partial update for friend/pet fields (FriendNameStep.js, PetPicker.js).
// Unlike PUT above, no self-introduction fields are required — business-rule
// validation (pet_type closed set, friend_gender pairing, etc.) happens
// inside saveQuestionnaire's own validateFriendPet(), not here, so this
// route doesn't duplicate those closed-set constants from level2Service.js.
router.patch('/student/:studentId/level2/questionnaire', ctrl.patchQuestionnaire);

// ── Portrait (self-portrait drawing, TASK-17 Fix 2) ──────────────────────

router.patch('/level2/questionnaire/:studentId/portrait', [
  body('portrait_strokes').optional({ nullable: true }).isObject().withMessage('portrait_strokes must be an object'),
], ctrl.savePortraitStrokes);

// ── Session management ────────────────────────────────────────────────────

router.get('/student/:studentId/level2/progress', [
  query('topic').optional().isIn(['self_introduction', 'describe_friend', 'describe_pet'])
    .withMessage('topic must be one of: self_introduction, describe_friend, describe_pet'),
], ctrl.getProgress);

router.post('/student/:studentId/level2/session/start', [
  body('session_id').optional().isInt({ min: 1 }).withMessage('session_id must be a positive integer'),
  body('topic').optional().isIn(['self_introduction', 'describe_friend', 'describe_pet'])
    .withMessage('topic must be one of: self_introduction, describe_friend, describe_pet'),
], ctrl.startSession);

router.post('/student/:studentId/level2/session/:sessionId/complete', ctrl.completeSession);

// ── Teaching flow – Step 3 (drag-and-drop discrimination) ────────────────

router.post('/student/:studentId/level2/session/:sessionId/sentence/:sentenceIndex/step3', [
  sentenceIndexParam,
  body('result')
    .isIn(['first_attempt', 'required_hint', 'auto_advanced'])
    .withMessage('result must be first_attempt, required_hint, or auto_advanced'),
], ctrl.recordStep3);

// ── Teaching flow – Step 4 (spoken repetition) ───────────────────────────

router.post('/student/:studentId/level2/session/:sessionId/sentence/:sentenceIndex/step4', [
  sentenceIndexParam,
  body('audio_base64').isString().notEmpty().withMessage('audio_base64 is required'),
  body('mime_type').isString().notEmpty().withMessage('mime_type is required'),
], ctrl.assessStep4);

// ── Teaching flow – non-verbal fallback (Step 4 timeout) ─────────────────

router.post('/student/:studentId/level2/session/:sessionId/sentence/:sentenceIndex/nonverbal-teaching', [
  sentenceIndexParam,
  body('correct_on_first_attempt').isBoolean().withMessage('correct_on_first_attempt must be a boolean'),
  body('required_second_attempt').optional().isBoolean(),
  body('auto_shown').optional().isBoolean(),
], ctrl.recordNonVerbalTeaching);

// ── Sentence 4 – gender image tap ────────────────────────────────────────

router.post('/student/:studentId/level2/session/:sessionId/gender-selection', [
  body('first_tap').isIn(['boy', 'girl']).withMessage('first_tap must be boy or girl'),
  body('required_prompt').optional().isBoolean(),
  body('auto_advanced').optional().isBoolean(),
], ctrl.recordGenderSelection);

// ── Sentence 5 – activity pre-selection screen ────────────────────────────

router.post('/student/:studentId/level2/session/:sessionId/activity-selection', [
  body('child_selected_activity')
    .isIn(VALID_ACTIVITIES)
    .withMessage(`child_selected_activity must be one of: ${VALID_ACTIVITIES.join(', ')}`),
], ctrl.recordActivitySelection);

// ── Independent production – full paragraph attempt (Section 8.1) ─────────

router.post('/student/:studentId/level2/session/:sessionId/paragraph-attempt', [
  body('audio_base64').optional().isString(),
  body('mime_type').optional().isString(),
  body('silence_timeout').optional().isBoolean(),
], ctrl.assessParagraph);

// ── Independent production – sentence-by-sentence (Section 8.2) ──────────

router.post('/student/:studentId/level2/session/:sessionId/sentence-by-sentence/:sentenceIndex', [
  sentenceIndexParam,
  body('audio_base64').optional().isString(),
  body('mime_type').optional().isString(),
  body('silence_timeout').optional().isBoolean(),
], ctrl.assessSentenceBySentence);

// ── Non-verbal word match (Section 8.3) ───────────────────────────────────

router.post('/student/:studentId/level2/session/:sessionId/nonverbal-word-match/:sentenceIndex', [
  sentenceIndexParam,
  body('correct_on_first_attempt').isBoolean().withMessage('correct_on_first_attempt must be a boolean'),
  body('required_second_attempt').optional().isBoolean(),
  body('auto_shown').optional().isBoolean(),
], ctrl.recordNonVerbalWordMatch);

module.exports = router;

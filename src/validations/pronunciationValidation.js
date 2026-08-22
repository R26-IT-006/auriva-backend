'use strict';

const { body } = require('express-validator');

const MAX_RAW_AUDIO_BYTES = 8 * 1024 * 1024;

const audioPayloadValidation = [
  body('raw_audio_base64')
    .optional({ nullable: true, checkFalsy: true })
    .custom((value) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('raw_audio_base64 must be a valid base64 string');
      }

      const byteLength = Buffer.byteLength(value, 'base64');
      if (byteLength > MAX_RAW_AUDIO_BYTES) {
        throw new Error('raw_audio_base64 must be 8MB or smaller');
      }

      return true;
    }),
  body('raw_audio_mime_type')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isString()
    .withMessage('raw_audio_mime_type must be a string'),
  body('raw_audio_size')
    .optional({ nullable: true })
    .isInt({ min: 1, max: MAX_RAW_AUDIO_BYTES })
    .withMessage('raw_audio_size must be a positive integer up to 8MB'),
];

const scorePronunciationAttemptValidation = [
  body('mode')
    .optional()
    .isIn(['word', 'alphabet'])
    .withMessage('mode must be either word or alphabet'),
  body('category_id')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('word_id')
    .trim()
    .notEmpty()
    .withMessage('word_id is required'),
  body('word_label')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('difficulty')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 5 })
    .withMessage('difficulty must be an integer between 1 and 5'),
  body('target_phonemes')
    .optional()
    .isArray()
    .withMessage('target_phonemes must be an array'),
  body('target_phonemes.*.text')
    .optional()
    .isString()
    .withMessage('target phoneme text must be a string'),
  body('target_phonemes.*.type')
    .optional({ nullable: true })
    .isString()
    .withMessage('target phoneme type must be a string'),
  body('target_phonemes.*.position')
    .optional({ nullable: true })
    .isString()
    .withMessage('target phoneme position must be a string'),
  body('response_duration')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('response_duration must be a positive number'),
  body('hesitation_time')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('hesitation_time must be a positive number'),
  body('pre_record_delay_seconds')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('pre_record_delay_seconds must be a positive number'),
  body('attempt_number')
    .optional()
    .isInt({ min: 1 })
    .withMessage('attempt_number must be a positive integer'),
  body('heard_reference_audio')
    .optional()
    .isBoolean()
    .withMessage('heard_reference_audio must be a boolean'),
  ...audioPayloadValidation,
];

const savePronunciationResultValidation = [
  body('mode')
    .isIn(['word', 'alphabet'])
    .withMessage('mode must be either word or alphabet'),
  body('category_id')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('word_id')
    .trim()
    .notEmpty()
    .withMessage('word_id is required'),
  body('word_label')
    .trim()
    .notEmpty()
    .withMessage('word_label is required'),
  body('overall_score')
    .isInt({ min: 0, max: 100 })
    .withMessage('overall_score must be an integer between 0 and 100'),
  body('phoneme_scores')
    .optional()
    .isArray()
    .withMessage('phoneme_scores must be an array'),
  body('phoneme_scores.*.text')
    .optional()
    .isString()
    .withMessage('phoneme score text must be a string'),
  body('phoneme_scores.*.type')
    .optional({ nullable: true })
    .isString()
    .withMessage('phoneme score type must be a string'),
  body('phoneme_scores.*.score')
    .optional()
    .isInt({ min: 0, max: 100 })
    .withMessage('phoneme score must be an integer between 0 and 100'),
  body('listen_choose_data')
    .optional({ nullable: true })
    .isObject()
    .withMessage('listen_choose_data must be an object'),
  body('listen_choose_data.activity_type')
    .optional()
    .isIn(['listen_choose', 'sound_focus_listen_choose'])
    .withMessage('listen_choose_data.activity_type must be listen_choose or sound_focus_listen_choose'),
  body('listen_choose_data.target_phoneme')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('listen_choose_data.target_phoneme must be a string'),
  body('listen_choose_data.target_word_id')
    .optional()
    .isString()
    .withMessage('listen_choose_data.target_word_id must be a string'),
  body('listen_choose_data.target_word_label')
    .optional()
    .isString()
    .withMessage('listen_choose_data.target_word_label must be a string'),
  body('listen_choose_data.selected_choice_id')
    .optional({ nullable: true })
    .isString()
    .withMessage('listen_choose_data.selected_choice_id must be a string'),
  body('listen_choose_data.selected_choice_label')
    .optional({ nullable: true })
    .isString()
    .withMessage('listen_choose_data.selected_choice_label must be a string'),
  body('listen_choose_data.is_correct')
    .optional()
    .isBoolean()
    .withMessage('listen_choose_data.is_correct must be a boolean'),
  body('listen_choose_data.attempts')
    .optional()
    .isInt({ min: 1 })
    .withMessage('listen_choose_data.attempts must be a positive integer'),
  body('listen_choose_data.choice_ids')
    .optional()
    .isArray()
    .withMessage('listen_choose_data.choice_ids must be an array'),
  body('listen_choose_data.choice_ids.*')
    .optional()
    .isString()
    .withMessage('listen_choose_data.choice_ids values must be strings'),
  body('listen_choose_data.attempted_choice_ids')
    .optional()
    .isArray()
    .withMessage('listen_choose_data.attempted_choice_ids must be an array'),
  body('listen_choose_data.attempted_choice_ids.*')
    .optional()
    .isString()
    .withMessage('listen_choose_data.attempted_choice_ids values must be strings'),
  body('response_duration')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('response_duration must be a positive number'),
  body('hesitation_time')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('hesitation_time must be a positive number'),
  body('recommendation_type')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('recommendation_message')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('recommendation_details')
    .optional({ nullable: true })
    .isObject()
    .withMessage('recommendation_details must be an object'),
  body('scoring_method')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('recognized_text')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('speech_verification')
    .optional({ nullable: true })
    .isObject()
    .withMessage('speech_verification must be an object'),
  body('confidence_level')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('needs_teacher_review')
    .optional()
    .isBoolean()
    .withMessage('needs_teacher_review must be a boolean'),
  body('heard_reference_audio')
    .optional()
    .isBoolean()
    .withMessage('heard_reference_audio must be a boolean'),
  body('next_word_id')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  body('attempt_number')
    .optional()
    .isInt({ min: 1 })
    .withMessage('attempt_number must be a positive integer'),
  body('workflow_completed')
    .optional()
    .isBoolean()
    .withMessage('workflow_completed must be a boolean'),
  body('recording_uri')
    .optional({ nullable: true, checkFalsy: true })
    .trim(),
  ...audioPayloadValidation,
];

module.exports = {
  savePronunciationResultValidation,
  scorePronunciationAttemptValidation,
};

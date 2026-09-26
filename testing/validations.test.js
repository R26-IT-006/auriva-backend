'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');

const { createStudentValidation, updateStudentValidation } = require('../src/validations/studentValidation');
const {
  loginValidation,
  setPasswordValidation,
  createTeacherValidation,
  assignStudentValidation,
  verifyOtpValidation,
} = require('../src/validations/teacherValidation');
const {
  savePronunciationResultValidation,
  scorePronunciationAttemptValidation,
  submitPronunciationReviewValidation,
} = require('../src/validations/pronunciationValidation');

async function validate(validators, body) {
  const req = { body };
  await Promise.all(validators.map((validator) => validator.run(req)));
  return validationResult(req).array();
}

function messages(errors) {
  return errors.map((error) => error.msg);
}

test('createStudentValidation accepts a complete valid student and trims names', async () => {
  const body = {
    full_name: '  Alex Perera  ',
    date_of_birth: '2018-04-02',
    disability: ' ASD ',
    mobile_number: '+94 77 123 4567',
  };
  const errors = await validate(createStudentValidation, body);

  assert.deepEqual(errors, []);
  assert.equal(body.full_name, 'Alex Perera');
  assert.equal(body.disability, 'ASD');
});

test('createStudentValidation reports required fields, date shape, and bad phone', async () => {
  const errors = await validate(createStudentValidation, {
    full_name: ' ', date_of_birth: '02/04/2018', disability: '', mobile_number: '12x',
  });
  const resultMessages = messages(errors);

  assert.ok(resultMessages.includes('full_name is required'));
  assert.ok(resultMessages.some((message) => /YYYY-MM-DD/.test(message)));
  assert.ok(resultMessages.includes('disability is required'));
  assert.ok(resultMessages.some((message) => /phone number/.test(message)));
});

test('updateStudentValidation permits an empty patch but rejects explicitly empty names', async () => {
  assert.deepEqual(await validate(updateStudentValidation, {}), []);
  assert.ok(messages(await validate(updateStudentValidation, { full_name: ' ' })).includes('full_name cannot be empty'));
});

test('loginValidation accepts supported roles and rejects an unsupported role or empty password', async () => {
  assert.deepEqual(await validate(loginValidation, { role: 'teacher', password: 'secret' }), []);
  const errors = messages(await validate(loginValidation, { role: 'student', password: '' }));
  assert.ok(errors.some((message) => /principal.*teacher/.test(message)));
  assert.ok(errors.includes('password is required'));
});

test('password validation requires length, uppercase, and a number', async () => {
  assert.deepEqual(await validate(setPasswordValidation, { newPassword: 'StrongPass9' }), []);
  const errors = messages(await validate(setPasswordValidation, { newPassword: 'weak' }));
  assert.ok(errors.some((message) => /8 characters/.test(message)));
  assert.ok(errors.some((message) => /uppercase/.test(message)));
  assert.ok(errors.some((message) => /number/.test(message)));
});

test('teacher creation normalizes email and assignment accepts null or positive IDs', async () => {
  const body = { full_name: 'Teacher One', email: 'TEACHER@EXAMPLE.COM', password: '12345678' };
  assert.deepEqual(await validate(createTeacherValidation, body), []);
  assert.equal(body.email, 'teacher@example.com');
  assert.deepEqual(await validate(assignStudentValidation, { teacher_id: null }), []);
  assert.ok(messages(await validate(assignStudentValidation, { teacher_id: 0 })).some((m) => /positive integer/.test(m)));
});

test('OTP validation accepts exactly six digits', async () => {
  assert.deepEqual(await validate(verifyOtpValidation, { email: 'a@b.com', otp: '123456' }), []);
  assert.ok(messages(await validate(verifyOtpValidation, { email: 'bad', otp: '12ab' })).length >= 2);
});

test('scorePronunciationAttemptValidation accepts a realistic scoring request', async () => {
  const errors = await validate(scorePronunciationAttemptValidation, {
    mode: 'word',
    word_id: 'cat',
    target_phonemes: [{ text: 'k', type: 'consonant', position: 'initial' }],
    response_duration: 1.25,
    attempt_number: 1,
    heard_reference_audio: true,
    raw_audio_base64: Buffer.from('audio').toString('base64'),
    raw_audio_mime_type: 'audio/mpeg',
    raw_audio_size: 5,
  });
  assert.deepEqual(errors, []);
});

test('scorePronunciationAttemptValidation rejects invalid mode, missing word, and malformed audio', async () => {
  const errors = messages(await validate(scorePronunciationAttemptValidation, {
    mode: 'sentence', word_id: '', difficulty: 8, attempt_number: 0, raw_audio_base64: '%%%bad',
  }));
  assert.ok(errors.some((m) => /word or alphabet/.test(m)));
  assert.ok(errors.includes('word_id is required'));
  assert.ok(errors.some((m) => /between 1 and 5/.test(m)));
  assert.ok(errors.some((m) => /valid base64/.test(m)));
});

test('savePronunciationResultValidation supports the result_id update path', async () => {
  assert.deepEqual(await validate(savePronunciationResultValidation, {
    result_id: 12,
    workflow_completed: true,
    listen_choose_data: { activity_type: 'listen_choose', attempts: 2, is_correct: true },
  }), []);
});

test('savePronunciationResultValidation requires scoring fields for a new result', async () => {
  const errors = messages(await validate(savePronunciationResultValidation, {}));
  assert.ok(errors.some((m) => /mode/.test(m)));
  assert.ok(errors.includes('word_id is required'));
  assert.ok(errors.includes('word_label is required'));
  assert.ok(errors.some((m) => /overall_score/.test(m)));
});

test('teacher review score must be an integer from 0 through 100', async () => {
  assert.deepEqual(await validate(submitPronunciationReviewValidation, { teacher_reviewed_score: 0 }), []);
  assert.deepEqual(await validate(submitPronunciationReviewValidation, { teacher_reviewed_score: 100 }), []);
  assert.ok((await validate(submitPronunciationReviewValidation, { teacher_reviewed_score: 101 })).length > 0);
});

'use strict';

// Sanity check that every module touched by the layer 1/2/3 pronunciation
// scoring work resolves its require graph correctly — construction only,
// no DB connection or model call is made.

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const test = require('node:test');
const assert = require('node:assert/strict');

test('touched service/controller/route modules load without throwing', () => {
  assert.doesNotThrow(() => require('../src/services/adaptiveCalibrationService'));
  assert.doesNotThrow(() => require('../src/services/pronunciationAnalysisService'));
  assert.doesNotThrow(() => require('../src/services/pronunciationScoringService'));
  assert.doesNotThrow(() => require('../src/services/phonemeGopService'));
  assert.doesNotThrow(() => require('../src/services/teacherService'));
  assert.doesNotThrow(() => require('../src/services/pronunciationReviewQueueService'));
  assert.doesNotThrow(() => require('../src/controllers/teacherController'));
  assert.doesNotThrow(() => require('../src/routes/teacher'));
  assert.doesNotThrow(() => require('../src/models/PronunciationSessionResult'));
  assert.doesNotThrow(() => require('../src/validations/pronunciationValidation'));
});

test('adaptiveCalibrationService exports the expected surface', () => {
  const calibration = require('../src/services/adaptiveCalibrationService');
  assert.equal(typeof calibration.computeCalibration, 'function');
  assert.equal(typeof calibration.applyCalibration, 'function');
  assert.equal(typeof calibration.fitCalibrationFromPairs, 'function');
});

test('PronunciationSessionResult model carries the new teacher-review columns', () => {
  const PronunciationSessionResult = require('../src/models/PronunciationSessionResult');
  const attributes = PronunciationSessionResult.getAttributes();
  assert.ok('teacher_reviewed_score' in attributes);
  assert.ok('teacher_reviewed_at' in attributes);
  assert.ok('teacher_reviewed_by' in attributes);
});

'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const test = require('node:test');
const assert = require('node:assert/strict');

const { Student, PronunciationSessionResult } = require('../src/models');
const teacherService = require('../src/services/teacherService');

function resultRow(values) {
  return {
    get() {
      return { ...values };
    },
  };
}

test('pronunciation history keeps newest-first query order for its consumers', async (t) => {
  t.mock.method(Student, 'findOne', async () => ({ sid: 7 }));
  t.mock.method(PronunciationSessionResult, 'findAll', async () => [
    resultRow({ id: 30, raw_audio_size: 12 }),
    resultRow({ id: 20, raw_audio_size: null }),
  ]);

  const results = await teacherService.getPronunciationResults(3, 7, 10);

  assert.deepEqual(results.map((row) => row.id), [30, 20]);
  assert.deepEqual(results.map((row) => row.has_raw_audio), [true, false]);
  assert.deepEqual(
    PronunciationSessionResult.findAll.mock.calls[0].arguments[0].order,
    [['created_at', 'DESC'], ['id', 'DESC']],
  );
});

test('legacy save only advertises audio bytes that were actually persisted', async (t) => {
  t.mock.method(Student, 'findOne', async () => ({ sid: 7 }));
  t.mock.method(PronunciationSessionResult, 'create', async (record) => record);

  const saved = await teacherService.savePronunciationResult(3, 7, {
    mode: 'word',
    word_id: 'cat',
    word_label: 'cat',
    overall_score: 80,
    raw_audio_size: 1234,
  });

  assert.equal(saved.raw_audio_data, null);
  assert.equal(saved.raw_audio_size, null);
});

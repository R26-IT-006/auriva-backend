'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ApiError = require('../src/utils/ApiError');
const { generateCode } = require('../src/utils/codeGenerator');
const { sendAudioBufferResponse } = require('../src/utils/audioResponse');

test('ApiError retains HTTP status, message, details, and an Error stack', () => {
  const error = new ApiError(422, 'Invalid request', { field: 'email' });

  assert.equal(error.name, 'Error');
  assert.equal(error.statusCode, 422);
  assert.equal(error.message, 'Invalid request');
  assert.deepEqual(error.details, { field: 'email' });
  assert.match(error.stack, /Invalid request/);
});

test('ApiError defaults details to null', () => {
  assert.equal(new ApiError(404, 'Missing').details, null);
});

test('generateCode starts a sequence at 0001 and uses the transaction lock', async () => {
  const transaction = { LOCK: { UPDATE: Symbol('update') } };
  let query;
  const model = {
    async findOne(options) {
      query = options;
      return null;
    },
  };

  assert.equal(await generateCode(model, 'teacher_code', 'TCH', transaction), 'TCH-0001');
  assert.deepEqual(query.attributes, ['teacher_code']);
  assert.deepEqual(query.order, [['teacher_code', 'DESC']]);
  assert.equal(query.transaction, transaction);
  assert.equal(query.lock, transaction.LOCK.UPDATE);
});

test('generateCode increments and zero-pads the latest stored code', async () => {
  const transaction = { LOCK: { UPDATE: true } };
  const model = { findOne: async () => ({ student_code: 'STU-0042' }) };

  assert.equal(await generateCode(model, 'student_code', 'STU', transaction), 'STU-0043');
});

function createResponseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
  };
}

test('sendAudioBufferResponse sends a complete audio response without a Range header', () => {
  const buffer = Buffer.from('abcdef');
  const res = createResponseRecorder();

  sendAudioBufferResponse({ req: { headers: {} }, res, buffer, mimeType: 'audio/mpeg' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Content-Length'], '6');
  assert.equal(res.body, buffer);
});

test('sendAudioBufferResponse returns an inclusive partial byte range', () => {
  const res = createResponseRecorder();

  sendAudioBufferResponse({
    req: { headers: { range: 'bytes=1-3' } },
    res,
    buffer: Buffer.from('abcdef'),
    mimeType: 'audio/wav',
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 1-3/6');
  assert.equal(res.headers['Content-Length'], '3');
  assert.equal(res.body.toString(), 'bcd');
});

test('sendAudioBufferResponse supports open-ended and clamps oversized ranges', () => {
  const res = createResponseRecorder();

  sendAudioBufferResponse({
    req: { headers: { range: 'bytes=4-99' } },
    res,
    buffer: Buffer.from('abcdef'),
    mimeType: 'audio/mpeg',
  });

  assert.equal(res.headers['Content-Range'], 'bytes 4-5/6');
  assert.equal(res.body.toString(), 'ef');
});

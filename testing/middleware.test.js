'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auriva-testing-secret';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { verifyToken } = require('../src/middleware/auth');
const { isPrincipal, isTeacher } = require('../src/middleware/roleGuard');

test('verifyToken decodes a valid Bearer token and calls next', async () => {
  const token = jwt.sign({ id: 17, role: 'teacher' }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextCalls = 0;

  await verifyToken(req, {}, () => { nextCalls += 1; });

  assert.equal(req.user.id, 17);
  assert.equal(req.user.role, 'teacher');
  assert.equal(nextCalls, 1);
});

test('verifyToken rejects a missing or malformed authorization header', async () => {
  await assert.rejects(
    verifyToken({ headers: {} }, {}, () => {}),
    (error) => error.statusCode === 401 && error.message === 'No token provided',
  );
  await assert.rejects(
    verifyToken({ headers: { authorization: 'Basic abc' } }, {}, () => {}),
    (error) => error.statusCode === 401,
  );
});

test('verifyToken rejects a token signed with a different secret', async () => {
  const token = jwt.sign({ id: 1 }, 'different-secret');
  await assert.rejects(
    verifyToken({ headers: { authorization: `Bearer ${token}` } }, {}, () => {}),
    /invalid signature/,
  );
});

test('isPrincipal allows principals and denies other roles', () => {
  let called = false;
  isPrincipal({ user: { role: 'principal' } }, {}, () => { called = true; });
  assert.equal(called, true);

  assert.throws(
    () => isPrincipal({ user: { role: 'teacher' } }, {}, () => {}),
    (error) => error.statusCode === 403 && /Principal/.test(error.message),
  );
});

test('isTeacher allows initialized teachers', () => {
  let called = false;
  isTeacher({ user: { role: 'teacher', is_first_login: false } }, {}, () => { called = true; });
  assert.equal(called, true);
});

test('isTeacher denies the wrong role and gates first-login teachers', () => {
  assert.throws(
    () => isTeacher({ user: { role: 'principal' } }, {}, () => {}),
    (error) => error.statusCode === 403 && /Teacher/.test(error.message),
  );
  assert.throws(
    () => isTeacher({ user: { role: 'teacher', is_first_login: true } }, {}, () => {}),
    (error) => error.statusCode === 403 && error.details.redirect === '/set-password',
  );
});

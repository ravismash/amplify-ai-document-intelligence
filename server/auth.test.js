process.env.JWT_SECRET ||= 'test-jwt-secret-for-unit-tests';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';

test('verifyPassword accepts the correct password and rejects a wrong one', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('hashPassword salts each hash uniquely, even for the same password', async () => {
  const first = await hashPassword('same password');
  const second = await hashPassword('same password');
  assert.notEqual(first, second);
});

test('signToken and verifyToken round-trip the user id and username', () => {
  const token = signToken({ id: 'user_1', username: 'ravi' });
  const payload = verifyToken(token);
  assert.equal(payload.sub, 'user_1');
  assert.equal(payload.username, 'ravi');
});

test('verifyToken throws on a tampered or garbage token', () => {
  assert.throws(() => verifyToken('not-a-real-token'));
  const token = signToken({ id: 'user_1', username: 'ravi' });
  assert.throws(() => verifyToken(`${token}tampered`));
});

test('verifyToken throws on a token signed with a different secret', () => {
  const token = jwt.sign({ sub: 'user_1', username: 'ravi' }, 'a-different-secret');
  assert.throws(() => verifyToken(token));
});

test('signToken throws if JWT_SECRET is unset', () => {
  const original = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => signToken({ id: 'user_1', username: 'ravi' }));
  } finally {
    process.env.JWT_SECRET = original;
  }
});

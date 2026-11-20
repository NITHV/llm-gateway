import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutput, scoreCase, passRate } from '../evals/score.js';

test('contains_any is case-insensitive', () => {
  assert.equal(checkOutput('The answer is Paris.', { type: 'contains_any', values: ['paris'] }), true);
  assert.equal(checkOutput('London', { type: 'contains_any', values: ['paris', 'rome'] }), false);
});

test('not_contains fails when a forbidden word appears', () => {
  assert.equal(checkOutput('yes', { type: 'not_contains', values: ['no'] }), true);
  assert.equal(checkOutput('no, it is not', { type: 'not_contains', values: ['no'] }), false);
});

test('max_words counts words', () => {
  assert.equal(checkOutput('one two three', { type: 'max_words', max: 3 }), true);
  assert.equal(checkOutput('one two three four', { type: 'max_words', max: 3 }), false);
});

test('regex matches the JSON answer', () => {
  const check = { type: 'regex', pattern: '\\{\\s*"status"\\s*:\\s*"ok"\\s*\\}' };
  assert.equal(checkOutput('{"status": "ok"}', check), true);
  assert.equal(checkOutput('Sure! {"status":"fine"}', check), false);
});

test('unknown check type throws', () => {
  assert.throws(() => checkOutput('x', { type: 'nope' }), /unknown check type/);
});

test('a case passes only when all its checks pass', () => {
  const tc = { id: 'c', checks: [{ type: 'contains_any', values: ['4'] }, { type: 'max_words', max: 2 }] };
  assert.equal(scoreCase(tc, '4').passed, true);
  const bad = scoreCase(tc, 'The answer is four and more words');
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.failed, ['contains_any', 'max_words']);
});

test('pass rate is the fraction of passing cases', () => {
  assert.equal(passRate([{ passed: true }, { passed: false }, { passed: true }, { passed: true }]), 0.75);
  assert.equal(passRate([]), 0);
});

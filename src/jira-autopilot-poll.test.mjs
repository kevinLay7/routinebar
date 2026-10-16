import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePoll } from '../bin/jira-autopilot-poll.mjs';
const identity = { data: { accountId: '62f4fec150bd9783f62da8af' } };
const issue = { key: 'STD-515', assignee: identity.data, status: { name: '3. In Progress' } };
test('anonymous empty search is an auth failure, never a successful zero', () => {
  assert.throws(() => validatePoll({ error: '401' }, { data: { issues: [] } }), /authentication/);
  assert.throws(() => validatePoll({ data: { accountId: 'someone-else' } }, { data: { issues: [] } }), /authentication/);
});
test('authenticated poll returns every ticket and allows a real zero', () => {
  assert.equal(validatePoll(identity, { data: { issues: [issue, { ...issue, key: 'STD-512' }] } }).count, 2);
  assert.equal(validatePoll(identity, { data: { issues: [] } }).count, 0);
});
test('bad, truncated, and out-of-scope responses block reconciliation', () => {
  for (const result of [{ error: 'denied' }, { data: {} }, { data: { issues: Array(100).fill(issue) } }, { data: { issues: [{ ...issue, status: { name: 'QA' } }] } }]) assert.throws(() => validatePoll(identity, result));
});

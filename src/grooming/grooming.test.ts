import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGroomingResult, groomingSource } from './grooming.js';
import type { WorkflowConfig } from '../workflow/types.js';
import type { Issue } from '../domain/issue.js';
const config = { tracker: { priority_labels: { 'priority: medium': 3 } } } as unknown as WorkflowConfig;
const known = new Set(['bug', 'priority: medium', 'ready-for-agent']);
const result = { outcome: 'ready', summary: 'Fix reminder persistence', scope: 'Persist the selected time; exclude redesign', acceptance_criteria: ['Time survives restart'], verification: ['Run the existing storage test suite'], evidence: ['Read the reminder persistence module'], labels: ['priority: medium', 'bug'] };
const encode = (v: unknown) => `SYMPHONY_GROOMING_RESULT\n${JSON.stringify(v)}\nEND_SYMPHONY_GROOMING_RESULT`;
test('grooming requires scoped evidence, verification and one known priority', () => {
  assert.equal(parseGroomingResult(encode(result), config, known).outcome, 'ready');
  for (const invalid of [{ ...result, acceptance_criteria: [] }, { ...result, verification: [] }, { ...result, evidence: [] }, { ...result, labels: ['bug'] }, { ...result, labels: ['priority: medium', 'made-up'] }, { ...result, labels: ['priority: medium', 'ready-for-agent'] }]) {
    assert.throws(() => parseGroomingResult(encode(invalid), config, known));
  }
});
test('source fingerprints ignore operational labels but detect changes to intent and classification', () => {
  const issue = { title: 'Fix reminders', description: 'Capture', labels: ['bug', 'requires-grooming'] } as Issue;
  assert.equal(groomingSource(issue), groomingSource({ ...issue, labels: [...issue.labels, 'agent-running'] }));
  assert.notEqual(groomingSource(issue), groomingSource({ ...issue, description: 'Different intent' }));
  assert.notEqual(groomingSource(issue), groomingSource({ ...issue, labels: [...issue.labels, 'agent:codex'] }));
});


test('human grooming can omit priority without accepting conflicting or unsupported labels', () => {
  assert.equal(parseGroomingResult(encode({ ...result, outcome: 'human', labels: [] }), config, known).outcome, 'human');
  assert.throws(() => parseGroomingResult(encode({ ...result, outcome: 'ready', labels: [] }), config, known));
  assert.throws(() => parseGroomingResult(encode({ ...result, outcome: 'human', labels: ['made-up'] }), config, known));
  const multiConfig = { tracker: { priority_labels: { 'priority: medium': 3, 'priority: high': 2 } } } as unknown as WorkflowConfig;
  assert.throws(() => parseGroomingResult(encode({ ...result, outcome: 'human', labels: ['priority: medium', 'priority: high'] }), multiConfig, new Set([...known, 'priority: high'])));
});

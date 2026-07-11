import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStructuredReviewResult, reviewNeedsHuman } from './reviewResult.js';

test('parses structured findings, observed evidence, and reviewer identity', () => {
  const result = parseStructuredReviewResult(`
SYMPHONY_REVIEW_RESULT: {"verdict":"block","summary":"One decision is unclear","findings":[{"disposition":"ambiguous","severity":"high","summary":"Ownership is unclear","file":"src/a.ts","line":12}],"evidence":[]}
SYMPHONY_VERIFICATION_EVIDENCE: {"evidence":[{"kind":"test","summary":"unit tests passed","command":"yarn test"}]}
SYMPHONY_REVIEWER: {"execution_id":"review-thread-1","provider":"codex","model":"gpt-5","lens":"staff-engineer"}
REVIEW_VERDICT: BLOCK
`);
  assert.ok(result);
  assert.equal(result.verdict, 'block');
  assert.equal(result.structured, true);
  assert.equal(result.reviewer?.execution_id, 'review-thread-1');
  assert.deepEqual(result.evidence.map((entry) => entry.kind), ['review', 'test']);
  assert.equal(reviewNeedsHuman(result), true);
});

test('keeps legacy verdicts backward compatible and classifies retry', () => {
  const pass = parseStructuredReviewResult('done\nREVIEW_VERDICT: PASS');
  assert.equal(pass?.verdict, 'pass');
  assert.equal(pass?.structured, false);
  assert.deepEqual(pass?.evidence.map((entry) => entry.kind), ['review']);

  assert.equal(parseStructuredReviewResult('REVIEW_VERDICT: RETRY')?.verdict, 'retry');
  assert.equal(parseStructuredReviewResult('no verdict'), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePauseRequest } from './pauseProtocol.js';

test('parses SYMPHONY_PAUSE blocks', () => {
  const parsed = parsePauseRequest(`Done until I need a decision.

SYMPHONY_PAUSE
reason: pick auth provider
question: Which provider should this feature use?
options:
- Keep Cognito
- Move to Clerk
END_SYMPHONY_PAUSE
`);

  assert.deepEqual(parsed, {
    reason: 'pick auth provider',
    question: 'Which provider should this feature use?',
    options: ['Keep Cognito', 'Move to Clerk'],
  });
});

test('returns null when the pause block has no question', () => {
  const parsed = parsePauseRequest(`SYMPHONY_PAUSE
reason: missing data
END_SYMPHONY_PAUSE`);

  assert.equal(parsed, null);
});

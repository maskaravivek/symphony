import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTemplate } from './renderPrompt.js';

test('treats an empty string as false in workflow conditionals', async () => {
  const rendered = await renderTemplate(
    '{% if symphony.stack_base_branch %}stacked base={{ symphony.stack_base_branch }}{% endif %}',
    { symphony: { stack_base_branch: '' } },
  );

  assert.equal(rendered, '');
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runHookScript } from './hooks.js';

test('captures a bounded hook output tail while preserving streamed verdicts', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-hook-capture-'));
  const previousLimit = process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES;
  process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES = '128';

  try {
    const result = await runHookScript(
      "node -e \"process.stdout.write('x'.repeat(512)); console.log('REVIEW_VERDICT: PASS')\"",
      cwd,
      5_000,
    );

    assert.equal(result.stdout_truncated, true);
    assert.ok(result.stdout.length <= 128);
    assert.match(result.output, /REVIEW_VERDICT: PASS/);
  } finally {
    if (previousLimit === undefined) {
      delete process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES;
    } else {
      process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES = previousLimit;
    }
  }
});

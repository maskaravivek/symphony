import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HookScriptError, runHookScript } from './hooks.js';

test('captures a bounded hook output tail while writing full diagnostics to a log file', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-hook-capture-'));
  const logPath = path.join(cwd, '.symphony', 'hooks', 'after-run.log');
  const previousLimit = process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES;
  process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES = '128';

  try {
    const result = await runHookScript(
      "node -e \"process.stdout.write('x'.repeat(512)); console.log('REVIEW_VERDICT: PASS')\"",
      cwd,
      5_000,
      { logPath },
    );

    assert.equal(result.log_path, logPath);
    assert.equal(result.stdout_truncated, true);
    assert.ok(result.stdout.length <= 128);
    assert.match(result.output, /REVIEW_VERDICT: PASS/);
    const fullLog = await fs.readFile(logPath, 'utf8');
    assert.match(fullLog, /^x{512}REVIEW_VERDICT: PASS\n$/);
  } finally {
    if (previousLimit === undefined) {
      delete process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES;
    } else {
      process.env.SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES = previousLimit;
    }
  }
});

test('includes the hook diagnostic log path on failures', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-hook-failure-'));
  const logPath = path.join(cwd, '.symphony', 'hooks', 'before-run.log');

  await assert.rejects(
    () => runHookScript("node -e \"console.error('checkout failed'); process.exit(2)\"", cwd, 5_000, { logPath }),
    (err: unknown) => {
      assert.ok(err instanceof HookScriptError);
      assert.equal(err.code, 2);
      assert.equal(err.log_path, logPath);
      assert.match(err.stderr, /checkout failed/);
      return true;
    },
  );

  await assert.doesNotReject(() => fs.access(logPath));
});

test('terminates hook subprocesses when aborted', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-hook-abort-'));
  const logPath = path.join(cwd, '.symphony', 'hooks', 'abort.log');
  const controller = new AbortController();
  const startedPath = path.join(cwd, 'started');
  const childScriptPath = path.join(cwd, 'long-running-hook.js');
  await fs.writeFile(
    childScriptPath,
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(startedPath)}, '1');\nsetInterval(() => {}, 1000);\n`,
  );

  const run = runHookScript(`node ${JSON.stringify(childScriptPath)}`, cwd, 30_000, { logPath, signal: controller.signal });

  while (true) {
    try {
      await fs.access(startedPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  controller.abort('test shutdown');

  await assert.rejects(
    run,
    (err: unknown) => {
      assert.ok(err instanceof HookScriptError);
      assert.match(err.message, /Hook cancelled: test shutdown/);
      assert.equal(err.log_path, logPath);
      return true;
    },
  );
});

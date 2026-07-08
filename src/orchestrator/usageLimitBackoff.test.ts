import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Orchestrator } from './orchestrator.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function issuePayload(number: number, title: string, state: string, labels: string[] = []) {
  return {
    id: number,
    node_id: `I_${number}`,
    number,
    title,
    state,
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.test/mangoappstudio/mdedit/issues/${number}`,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(predicate(), true);
}

async function writeWorkflowWithUsageLimit(
  workspaceRoot: string,
  agentCommand: string,
  usageLimitExitCodes: number[],
  usageLimitBackoffMs: number,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-usage-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 2
agents:
  default: codex
  providers:
    codex:
      command: ${agentCommand}
      output_log: .symphony/codex.jsonl
      usage_limit_exit_codes: [${usageLimitExitCodes.join(', ')}]
      usage_limit_backoff_ms: ${usageLimitBackoffMs}
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

function buildMockFetch(
  issueNumbers: number[],
  calls: { url: string; method: string; body: unknown }[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    // Candidate issues
    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse(issueNumbers.map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    // Open pull requests
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    // Issue by number
    for (const n of issueNumbers) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
}

/**
 * Checks whether a given issue had `agent-running` applied (dispatched) in the recorded calls.
 */
function wasDispatched(calls: { url: string; method: string; body: unknown }[], issueNumber: number): boolean {
  return calls.some(
    (c) =>
      c.url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${issueNumber}/labels` &&
      c.method === 'POST' &&
      JSON.stringify(c.body) === JSON.stringify({ labels: ['agent-running'] }),
  );
}

test('blocks new dispatches to the provider after a usage-limit exit code is seen', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-usage-workspace-'));
  // Issue 10 agent exits with code 5 — a configured usage-limit code.
  // Issue 11 is a second candidate that should NOT be dispatched during backoff.
  const workflowPath = await writeWorkflowWithUsageLimit(workspaceRoot, "bash -c 'exit 5'", [5], 3600000);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  // Only issue 10 is returned initially; issue 11 will appear on the second tick.
  let tickCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      // First tick returns issue 10 only; second tick returns both 10 and 11
      const issueNums = tickCount === 0 ? [10] : [11];
      return jsonResponse(issueNums.map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    for (const n of [10, 11]) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    tickCount = 0;
    await orchestrator.tickOnce();

    // Verify issue 10 was dispatched
    assert.ok(wasDispatched(calls, 10), 'issue 10 should have been dispatched on first tick');

    // Wait for the agent (exit 5) to finish and for the backoff label transition to happen
    // (ready-for-agent is re-applied after the failed run)
    await waitFor(() =>
      calls.some(
        (c) =>
          c.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/10/labels' &&
          c.method === 'POST' &&
          JSON.stringify(c.body) === JSON.stringify({ labels: ['ready-for-agent'] }),
      ),
    );

    // Capture call count before second tick to focus on new calls only
    calls.length = 0;

    tickCount = 1;
    await orchestrator.tickOnce();

    // Issue 11 is new and ready, but the codex provider is in backoff — it must not be dispatched
    assert.equal(wasDispatched(calls, 11), false, 'issue 11 should not be dispatched while provider is in usage limit backoff');

    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('does not block dispatch when exit code is not in usage_limit_exit_codes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-usage-no-backoff-'));
  // Agent exits with code 1 — NOT a configured usage-limit exit code (only [5] is)
  const workflowPath = await writeWorkflowWithUsageLimit(workspaceRoot, "bash -c 'exit 1'", [5], 3600000);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  let tickCount = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      const issueNums = tickCount === 0 ? [20] : [21];
      return jsonResponse(issueNums.map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    for (const n of [20, 21]) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    tickCount = 0;
    await orchestrator.tickOnce();

    assert.ok(wasDispatched(calls, 20), 'issue 20 should have been dispatched on first tick');

    // Wait for the agent (exit 1) to fail and the retry label to be applied
    await waitFor(() =>
      calls.some(
        (c) =>
          c.url === 'https://api.github.test/repos/mangoappstudio/mdedit/issues/20/labels' &&
          c.method === 'POST' &&
          JSON.stringify(c.body) === JSON.stringify({ labels: ['ready-for-agent'] }),
      ),
    );

    calls.length = 0;

    tickCount = 1;
    await orchestrator.tickOnce();

    // With no usage limit backoff, issue 21 should be dispatched normally
    assert.ok(wasDispatched(calls, 21), 'issue 21 should be dispatched when exit code is not a usage limit code');

    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function writeWorkflowWithCheckCommand(workspaceRoot: string, checkCommand: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-check-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  // Agent command is a long sleep so it stays running — the check command is what we are testing
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 2
agents:
  default: codex
  providers:
    codex:
      command: sleep 3600
      output_log: .symphony/codex.jsonl
      usage_limit_check_command: ${checkCommand}
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

function mockCodexBarCheckCommand(usedPercent: number): string {
  const payload = JSON.stringify({
    provider: 'codex',
    usage: { primary: { usedPercent } },
  });
  const escapedPayload = payload.replaceAll('"', '\\"');
  return `bash -lc "codexbar() { printf '%s' '${escapedPayload}'; }; codexbar --provider codex --format json --json-only --no-color"`;
}

async function writeStatefulCodexBarScript(
  workspaceRoot: string,
  stateFilePath: string,
  resetAtIso: string,
): Promise<string> {
  const scriptPath = path.join(workspaceRoot, 'stateful-codexbar.sh');
  const escapedStateFile = stateFilePath.replaceAll("'", `'\'\''`);
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail

count_file='${escapedStateFile}'
count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$count" > "$count_file"

if [ "$count" -eq 1 ]; then
  payload='{"provider":"codex","usage":{"primary":{"usedPercent":95,"resetsAt":"${resetAtIso}"}}}'
else
  payload='{"provider":"codex","usage":{"primary":{"usedPercent":10}}}'
fi

codexbar() {
  printf '%s' "$payload"
}
`,
    'utf8',
  );
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

function writeStatefulCodexBarCheckCommand(scriptPath: string): string {
  return `bash -lc "source '${scriptPath}'; codexbar --provider codex --format json --json-only --no-color"`;
}

async function writeWorkflowWithGroupedCheckCommand(workspaceRoot: string, checkCommand: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-grouped-check-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 2
agents:
  default: codex-spark
  providers:
    codex:
      provider_group: codex
      provider_kind: codex
      command: sleep 3600
      output_log: .symphony/codex.jsonl
      usage_limit_check_command: ${checkCommand}
    codex-spark:
      provider_group: codex
      provider_kind: codex
      command: sleep 3600
      output_log: .symphony/codex-spark.jsonl
      extract_codex_thread_id: true
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

async function writeWorkflowWithGroupedClaudeProviders(workspaceRoot: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-grouped-capacity-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 2
agents:
  default: codex
  providers:
    codex:
      command: sleep 3600
    claude:
      provider_group: claude
      provider_kind: claude
      command: sleep 3600
      output_log: .symphony/claude.log
      max_concurrent: 1
    claude-fable:
      provider_group: claude
      provider_kind: claude
      command: sleep 3600
      output_log: .symphony/claude-fable.log
      max_concurrent: 1
  routes:
    - provider: claude-fable
      any_labels: [user-experience]
      all_labels: [complexity:high]
    - provider: claude
      any_labels: [user-experience]
    - provider: codex
      default: true
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

function buildMockFetchWithLabels(
  issueLabels: Record<number, string[]>,
  calls: { url: string; method: string; body: unknown }[],
): typeof globalThis.fetch {
  const issueNumbers = Object.keys(issueLabels).map(Number);
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      return jsonResponse(issueNumbers.map((n) => issuePayload(n, `Issue ${n}`, 'open', issueLabels[n])));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    for (const n of issueNumbers) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', issueLabels[n]));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }

    throw new Error(`Unexpected fetch ${method} ${url}`);
  };
}

async function writeWorkflowWithPlanningMode(workspaceRoot: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-planning-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  api_base_url: https://api.github.test
  active_states: [open]
  terminal_states: [closed]
  required_labels: [ready-for-agent]
  ignored_labels: [blocked, ready-for-human, wontfix]
workspace:
  root: ${workspaceRoot}
hooks:
  after_run: exit 1
agent:
  max_concurrent_agents: 1
agents:
  default: codex
  providers:
    codex:
      provider_group: codex
      provider_kind: codex
      command: bash -c 'printf "Detailed plan" > .symphony/last_message.md'
      handoff_command: bash -c 'printf "Detailed plan" > .symphony/last_message.md'
      output_log: .symphony/codex.jsonl
---

Prompt body
`,
    'utf8',
  );
  return workflowPath;
}

function commentBodies(calls: { url: string; method: string; body: unknown }[], issueNumber: number): string[] {
  return calls
    .filter((c) => c.url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${issueNumber}/comments` && c.method === 'POST')
    .map((c) => (c.body && typeof c.body === 'object' && 'body' in c.body ? String((c.body as { body: unknown }).body) : ''));
}

test('blocks dispatch when usage_limit_check_command exits non-zero', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-check-blocked-workspace-'));
  const workflowPath = await writeWorkflowWithCheckCommand(workspaceRoot, "bash -c 'exit 1'");

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch([30], calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    // The check command exits non-zero, so issue 30 must not be dispatched
    assert.equal(wasDispatched(calls, 30), false, 'issue 30 should not be dispatched when check command exits non-zero');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('blocks sibling providers in the same provider_group when usage_limit_check_command exits non-zero', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-grouped-check-blocked-workspace-'));
  const workflowPath = await writeWorkflowWithGroupedCheckCommand(workspaceRoot, "bash -c 'exit 1'");

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch([32], calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    assert.equal(wasDispatched(calls, 32), false, 'codex-spark should not dispatch while the codex provider group is blocked');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('applies max_concurrent across providers in the same provider_group', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-grouped-capacity-workspace-'));
  const workflowPath = await writeWorkflowWithGroupedClaudeProviders(workspaceRoot);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetchWithLabels(
    {
      40: ['ready-for-agent', 'user-experience', 'complexity:high'],
      41: ['ready-for-agent', 'user-experience'],
    },
    calls,
  );

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    assert.ok(wasDispatched(calls, 40), 'high-complexity UX issue should dispatch to claude-fable');
    assert.equal(wasDispatched(calls, 41), false, 'default UX issue should wait while a claude-group sibling is running');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('planning issues post the final message as an issue comment and skip after_run', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-planning-workspace-'));
  const workflowPath = await writeWorkflowWithPlanningMode(workspaceRoot);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetchWithLabels({ 50: ['ready-for-agent', 'task:spec'] }, calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    await waitFor(() => commentBodies(calls, 50).some((body) => body.includes('## Symphony Technical Specification') && body.includes('Detailed plan')));
    assert.ok(commentBodies(calls, 50).some((body) => body.includes('Detailed plan')), 'planning result should be posted as an issue comment');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('allows dispatch when usage_limit_check_command exits zero', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-check-allowed-workspace-'));
  const workflowPath = await writeWorkflowWithCheckCommand(workspaceRoot, "bash -c 'exit 0'");

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch([31], calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    // The check command exits zero (within limit), so issue 31 should be dispatched normally
    assert.ok(wasDispatched(calls, 31), 'issue 31 should be dispatched when check command exits zero');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('allows dispatch when usage_limit_check_command returns unknown', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-check-unknown-workspace-'));
  const workflowPath = await writeWorkflowWithCheckCommand(workspaceRoot, "bash -c 'exit 2'");

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch([33], calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    assert.ok(wasDispatched(calls, 33), 'issue 33 should dispatch when usage check result is unknown');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('blocks dispatch when a codexbar usage payload is at or above 90%', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-codexbar-blocked-workspace-'));
  const workflowPath = await writeWorkflowWithCheckCommand(workspaceRoot, mockCodexBarCheckCommand(90));

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch([40], calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    assert.equal(wasDispatched(calls, 40), false, 'issue should not be dispatched when codexbar reports usage >= 90%');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('allows dispatch when a codexbar usage payload is below 90%', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-codexbar-allowed-workspace-'));
  const workflowPath = await writeWorkflowWithCheckCommand(workspaceRoot, mockCodexBarCheckCommand(89));

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch([41], calls);

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    assert.ok(wasDispatched(calls, 41), 'issue should be dispatched when codexbar reports usage below 90%');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('backs off GitHub polling after rate limit responses', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-github-rate-limit-workspace-'));
  const workflowPath = await writeWorkflowWithUsageLimit(workspaceRoot, 'sleep 3600', [], 0);

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ message: 'API rate limit exceeded for user ID 123' }), {
      status: 403,
      statusText: 'Forbidden',
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor((Date.now() + 60_000) / 1000)),
      },
    });
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    await orchestrator.tickOnce();
    const afterFirstTick = calls.length;
    assert.ok(afterFirstTick > 0, 'first tick should hit GitHub and see the rate limit');

    await orchestrator.tickOnce();
    assert.equal(calls.length, afterFirstTick, 'second tick should skip GitHub while rate limit backoff is active');
    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('uses codexbar resetsAt to skip usage checks until reset', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-codexbar-resets-at-workspace-'));
  const stateFilePath = path.join(workspaceRoot, 'codexbar-check-count.txt');
  const resetAtMs = Date.now() + 500;
  const resetAtIso = new Date(resetAtMs).toISOString();
  const statefulScriptPath = await writeStatefulCodexBarScript(workspaceRoot, stateFilePath, resetAtIso);
  const workflowPath = await writeWorkflowWithCheckCommand(workspaceRoot, writeStatefulCodexBarCheckCommand(statefulScriptPath));

  const calls: { url: string; method: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  let tickCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.startsWith('https://api.github.test/repos/mangoappstudio/mdedit/issues?')) {
      if (tickCount === 0) return jsonResponse([30].map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
      if (tickCount === 1) return jsonResponse([31].map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
      return jsonResponse([30].map((n) => issuePayload(n, `Issue ${n}`, 'open', ['ready-for-agent'])));
    }
    if (url === 'https://api.github.test/repos/mangoappstudio/mdedit/pulls?state=open&per_page=50') {
      return jsonResponse([]);
    }
    for (const n of [30, 31]) {
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}`) {
        return jsonResponse(issuePayload(n, `Issue ${n}`, 'open', ['agent-running']));
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments?per_page=50`) {
        return jsonResponse([]);
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/comments` && method === 'POST') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://api.github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/comments/${500 + n}` && method === 'PATCH') {
        return jsonResponse({ id: 500 + n, body: String(body), html_url: `https://api.github.test/comment/${500 + n}` });
      }
      if (url === `https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels` && method === 'POST') {
        return jsonResponse([]);
      }
      if (url.startsWith(`https://api.github.test/repos/mangoappstudio/mdedit/issues/${n}/labels/`) && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const orchestrator = new Orchestrator({ workflowPath, repoId: 'mdedit' });

  try {
    tickCount = 0;
    await orchestrator.tickOnce();
    assert.equal(wasDispatched(calls, 30), false, 'initial check at >=90% should block dispatch');
    const checksAfterFirstTick = Number((await fs.readFile(stateFilePath, 'utf8')).trim());
    assert.equal(checksAfterFirstTick, 1, 'usage check should run once on first tick');

    calls.length = 0;
    tickCount = 1;
    await orchestrator.tickOnce();
    assert.equal(wasDispatched(calls, 31), false, 'while reset window is active, dispatch should remain blocked');
    const checksAfterSecondTick = Number((await fs.readFile(stateFilePath, 'utf8')).trim());
    assert.equal(checksAfterSecondTick, 1, 'usage check should not run again during resetsAt backoff');

    await new Promise((resolve) => setTimeout(resolve, 650));

    calls.length = 0;
    tickCount = 2;
    await orchestrator.tickOnce();
    const checksAfterThirdTick = Number((await fs.readFile(stateFilePath, 'utf8')).trim());
    assert.equal(checksAfterThirdTick, 2, 'usage check should rerun after reset');
    assert.ok(wasDispatched(calls, 30), 'issue should dispatch after backoff resets');

    await orchestrator.shutdown('test');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

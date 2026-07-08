import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadWorkflowFromFile } from './loadWorkflow.js';

async function writeWorkflow(frontMatter: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(workflowPath, `---\n${frontMatter}---\n\nPrompt body\n`, 'utf8');
  return workflowPath;
}

test('loads bounded retry attempts', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agent:
  max_attempts: 3
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agent.max_attempts, 3);
});

test('defaults candidate ordering to priority then created_at', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.tracker.candidate_order, 'priority_then_created_at');
});

test('defaults workspace strategies to durable issue workspaces', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.workspace.strategy, {
    implementation: 'durable_issue_workspace',
    planning: 'durable_issue_workspace',
    epic: {
      stacked: 'durable_issue_workspace',
      independent: 'durable_issue_workspace',
    },
  });
});

test('loads workspace strategies', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
workspace:
  strategy:
    implementation: pooled_isolated
    planning: none_or_readonly
    epic:
      stacked: durable_epic_workspace
      independent: pooled_isolated
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.workspace.strategy, {
    implementation: 'pooled_isolated',
    planning: 'none_or_readonly',
    epic: {
      stacked: 'durable_epic_workspace',
      independent: 'pooled_isolated',
    },
  });
});

test('rejects unsupported workspace strategy', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
workspace:
  strategy:
    implementation: shared_checkout
codex:
  command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /workspace.strategy.implementation must be/);
});

test('loads ready_for_agent_labeled_at candidate ordering', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  candidate_order: ready_for_agent_labeled_at
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.tracker.candidate_order, 'ready_for_agent_labeled_at');
});

test('rejects invalid candidate ordering', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  candidate_order: newest_first
codex:
  command: codex exec -
`);

  await assert.rejects(
    () => loadWorkflowFromFile(workflowPath),
    /tracker.candidate_order must be priority_then_created_at or ready_for_agent_labeled_at/,
  );
});

test('rejects invalid bounded retry attempts', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agent:
  max_attempts: 0
codex:
  command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /agent.max_attempts must be a positive number/);
});

test('loads native sub-issue epic config', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  epics:
    enabled: true
    relationship_source: native_subissues
    auto_label_children: true
    parent_mode: coordinator_only
    execution_mode: stacked
    max_depth: 4
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.tracker.epics, {
    enabled: true,
    relationship_source: 'native_subissues',
    auto_label_children: true,
    parent_mode: 'coordinator_only',
    execution_mode: 'stacked',
    max_depth: 4,
  });
});

test('uses disabled epic config by default', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.tracker.epics, {
    enabled: false,
    relationship_source: 'native_subissues',
    auto_label_children: true,
    parent_mode: 'coordinator_only',
    execution_mode: 'independent',
    max_depth: 8,
  });
});

test('rejects unsupported epic execution mode', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  epics:
    enabled: true
    execution_mode: pipeline
codex:
  command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /tracker.epics.execution_mode must be independent or stacked/);
});

test('creates a default codex agent provider from legacy codex config', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
codex:
  command: codex exec -
  resume_command: codex exec resume "{{ symphony.codex_thread_id }}" -
  handoff_command: codex exec --readonly -
  turn_timeout_ms: 1234
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agents.default, 'codex');
  assert.equal(loaded.config.agents.providers.codex.provider_group, 'codex');
  assert.equal(loaded.config.agents.providers.codex.provider_kind, 'codex');
  assert.equal(loaded.config.agents.providers.codex.command, 'codex exec -');
  assert.equal(loaded.config.agents.providers.codex.resume_command, 'codex exec resume "{{ symphony.codex_thread_id }}" -');
  assert.equal(loaded.config.agents.providers.codex.handoff_command, 'codex exec --readonly -');
  assert.equal(loaded.config.agents.providers.codex.turn_timeout_ms, 1234);
  assert.equal(loaded.config.agents.providers.codex.output_log, '.symphony/codex.jsonl');
  assert.equal(loaded.config.agents.providers.codex.extract_codex_thread_id, true);
});

test('loads label-routed agent providers', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
      output_log: .symphony/codex.jsonl
    claude:
      provider_group: claude
      provider_kind: claude
      command: claude -p
      output_log: .symphony/claude.log
      max_concurrent: 1
  routes:
    - provider: claude
      any_labels: [ui, ux, agent:claude]
      none_labels: [agent:codex]
    - provider: codex
      default: true
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agents.default, 'codex');
  assert.equal(loaded.config.agents.providers.codex.provider_group, 'codex');
  assert.equal(loaded.config.agents.providers.codex.provider_kind, 'codex');
  assert.equal(loaded.config.agents.providers.claude.provider_group, 'claude');
  assert.equal(loaded.config.agents.providers.claude.provider_kind, 'claude');
  assert.equal(loaded.config.agents.providers.claude.command, 'claude -p');
  assert.equal(loaded.config.agents.providers.claude.max_concurrent, 1);
  assert.equal(loaded.config.agents.providers.claude.extract_codex_thread_id, false);
  assert.deepEqual(loaded.config.agents.routes[0], {
    provider: 'claude',
    any_labels: ['ui', 'ux', 'agent:claude'],
    all_labels: [],
    none_labels: ['agent:codex'],
    default: false,
  });
});

test('defaults codex thread extraction from provider_kind codex', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex-spark
  providers:
    codex-spark:
      provider_group: codex
      provider_kind: codex
      command: codex exec --model gpt-5.3-codex-spark -
      output_log: .symphony/codex-spark.jsonl
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agents.providers['codex-spark'].extract_codex_thread_id, true);
});

test('loads usage_limit_exit_codes and usage_limit_backoff_ms for a provider', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
      usage_limit_exit_codes: [5, 29]
      usage_limit_backoff_ms: 3600000
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.agents.providers.codex.usage_limit_exit_codes, [5, 29]);
  assert.equal(loaded.config.agents.providers.codex.usage_limit_backoff_ms, 3600000);
});

test('defaults usage_limit_exit_codes to null and usage_limit_backoff_ms to 0', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agents.providers.codex.usage_limit_exit_codes, null);
  assert.equal(loaded.config.agents.providers.codex.usage_limit_backoff_ms, 0);
});

test('rejects empty usage_limit_check_command', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
      usage_limit_check_command: "   "
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /usage_limit_check_command must be a non-empty string/);
});

test('rejects non-integer values in usage_limit_exit_codes', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
      usage_limit_exit_codes: [5, "notanumber"]
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /usage_limit_exit_codes must be an array of integers/);
});

test('rejects negative usage_limit_backoff_ms', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
      usage_limit_backoff_ms: -1000
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /usage_limit_backoff_ms must be a non-negative number/);
});

test('rejects unsupported epic relationship source', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
  epics:
    enabled: true
    relationship_source: markdown_tasks
codex:
  command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /tracker.epics.relationship_source must be native_subissues/);
});

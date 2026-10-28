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
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agent.max_attempts, 3);
});

test('review-free merging requires an explicit local validation command', async () => {
  const frontMatter = `
tracker:
  kind: github
  owner: example
  repo: app
  token: token
merge:
  enabled: true
  required_reviews: 0
agents:
  default: codex
  providers:
    codex:
      command: echo unused
`;
  await assert.rejects(loadWorkflowFromFile(await writeWorkflow(frontMatter)), /validation_command is required/);
  const path = await writeWorkflow(frontMatter.replace('  required_reviews: 0', '  required_reviews: 0\n  validation_command: yarn test'));
  const loaded = await loadWorkflowFromFile(path);
  assert.equal(loaded.config.merge.required_reviews, 0);
  assert.deepEqual(loaded.config.merge.required_evidence, { standard: ['validation'], elevated: ['validation'] });
  await assert.rejects(loadWorkflowFromFile(await writeWorkflow(frontMatter.replace('required_reviews: 0', 'required_reviews: -1'))), /must be 0 or 1/);
});

test('loads review auto-fix config', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
review:
  enabled: false
  auto_fix_review_comments: true
  number_of_auto_fix_iterations: 2
  shepherd_pull_requests: true
  max_feedback_rounds: 4
  non_blocking_feedback_priorities: [p2, p3]
  lenses: [staff-engineer, security]
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.review, {
    enabled: false,
    auto_fix_review_comments: true,
    number_of_auto_fix_iterations: 2,
    shepherd_pull_requests: true,
    max_feedback_rounds: 4,
    non_blocking_feedback_priorities: ['p2', 'p3'],
    lenses: ['staff-engineer', 'security'],
  });
});

test('defaults review auto-fix config conservatively', async () => {
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
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.deepEqual(loaded.config.review, {
    enabled: true,
    auto_fix_review_comments: false,
    number_of_auto_fix_iterations: 1,
    shepherd_pull_requests: false,
    max_feedback_rounds: 5,
    non_blocking_feedback_priorities: ['p2', 'p3'],
    lenses: ['staff-engineer'],
  });
});

test('defaults autonomous merge and scheduled loops conservatively', async () => {
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
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.match(loaded.config.workflow_sha ?? '', /^[a-f0-9]{64}$/);
  assert.equal(loaded.config.merge.workflow_sha, loaded.config.workflow_sha);
  const { workflow_sha: _workflowSha, ...merge } = loaded.config.merge;
  assert.deepEqual(merge, {
    enabled: false,
    dry_run: false,
    require_checks: true,
    required_reviews: 1,
    validation_command: null,
    method: 'squash',
    default_risk: 'standard',
    policy_version: 'v1',
    require_independent_reviews: false,
    required_evidence: { standard: ['review'], elevated: ['review'] },
    substantive_ignored_paths: [],
    rules: [],
  });
  assert.deepEqual(loaded.config.loops, []);
});

test('loads deterministic merge risk rules and scheduled loops', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
merge:
  enabled: true
  dry_run: true
  require_checks: false
  method: rebase
  default_risk: standard
  policy_version: mdedit-2026-07
  require_independent_reviews: true
  required_evidence:
    standard: [review]
    elevated: [review, test]
  substantive_ignored_paths: ["**/*.test.ts", generated/**]
  rules:
    - risk: elevated
      any_labels: [security, migration]
      paths: [apps/api/src/auth/**, .github/workflows/**]
      min_changed_lines: 500
      min_changed_files: 20
      required_evidence: [integration]
    - risk: prohibited
      target_branches: [production]
loops:
  - id: daily-quality
    enabled: true
    interval_ms: 86400000
    prompt: Use the repository quality skill and create only evidence-backed issues.
    provider: codex
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.match(loaded.config.workflow_sha ?? '', /^[a-f0-9]{64}$/);
  assert.equal(loaded.config.merge.workflow_sha, loaded.config.workflow_sha);
  const { workflow_sha: _workflowSha, ...merge } = loaded.config.merge;
  assert.deepEqual(merge, {
    enabled: true,
    dry_run: true,
    require_checks: false,
    required_reviews: 1,
    validation_command: null,
    method: 'rebase',
    default_risk: 'standard',
    policy_version: 'mdedit-2026-07',
    require_independent_reviews: true,
    required_evidence: { standard: ['review'], elevated: ['review', 'test'] },
    substantive_ignored_paths: ['**/*.test.ts', 'generated/**'],
    rules: [
      {
        risk: 'elevated',
        any_labels: ['security', 'migration'],
        paths: ['apps/api/src/auth/**', '.github/workflows/**'],
        target_branches: [],
        min_changed_lines: 500,
        min_changed_files: 20,
        required_evidence: ['integration'],
      },
      {
        risk: 'prohibited',
        any_labels: [],
        paths: [],
        target_branches: ['production'],
        min_changed_lines: null,
        min_changed_files: null,
        required_evidence: [],
      },
    ],
  });
  assert.deepEqual(loaded.config.loops, [
    {
      id: 'daily-quality',
      enabled: true,
      interval_ms: 86400000,
      prompt: 'Use the repository quality skill and create only evidence-backed issues.',
      provider: 'codex',
    },
  ]);
});

test('rejects invalid merge risk and scheduled-loop intervals', async () => {
  const invalidRiskPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
merge:
  default_risk: dangerous
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);
  await assert.rejects(() => loadWorkflowFromFile(invalidRiskPath), /merge.default_risk must be standard, elevated, or prohibited/);

  const invalidSizePath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
merge:
  rules:
    - risk: elevated
      min_changed_lines: 0
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);
  await assert.rejects(() => loadWorkflowFromFile(invalidSizePath), /merge.rules\[0\].min_changed_lines must be a positive integer/);

  const invalidLoopPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
loops:
  - id: quality
    interval_ms: 0
    prompt: Run quality checks.
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);
  await assert.rejects(() => loadWorkflowFromFile(invalidLoopPath), /loops\[0\]\.interval_ms must be a positive number/);
});

test('rejects invalid review auto-fix iterations', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
review:
  number_of_auto_fix_iterations: -1
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /review.number_of_auto_fix_iterations must be a non-negative integer/);
});

test('rejects invalid external feedback policy', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
review:
  max_feedback_rounds: 0
  non_blocking_feedback_priorities: [p4]
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /review.max_feedback_rounds must be a positive integer/);
});

test('defaults candidate ordering to priority then created_at', async () => {
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
agents:
  default: codex
  providers:
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

test('ships checked-out read-only planning runs in the example workflow', async () => {
  const loaded = await loadWorkflowFromFile(path.resolve('WORKFLOW.example.md'));

  assert.equal(loaded.config.workspace.strategy.planning, 'durable_issue_workspace');
  assert.match(loaded.config.agents.providers.codex?.handoff_command ?? '', /-s read-only/);
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /tracker.epics.execution_mode must be independent or stacked/);
});

test('rejects the removed top-level codex provider config', async () => {
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

  await assert.rejects(
    () => loadWorkflowFromFile(workflowPath),
    /top-level codex config was removed; configure agents.providers instead/,
  );
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

test('rejects the removed agents.routes labels alias', async () => {
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
  routes:
    - provider: codex
      labels: [docs]
`);

  await assert.rejects(
    () => loadWorkflowFromFile(workflowPath),
    /agents.routes\[0\].labels was removed; use any_labels instead/,
  );
});

test('defaults codex thread extraction from provider_kind codex', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agents:
  default: codex-secondary
  providers:
    codex-secondary:
      provider_group: codex
      provider_kind: codex
      command: codex exec -
      output_log: .symphony/codex-secondary.jsonl
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agents.providers['codex-secondary'].extract_codex_thread_id, true);
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
agents:
  default: codex
  providers:
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
agents:
  default: codex
  providers:
    codex:
      command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /tracker.epics.relationship_source must be native_subissues/);
});

test('storage maintenance defaults to daily and rejects unsafe retention values', async () => {
  const base = `tracker:\n  owner: test\n  repo: app\n  token: token\nagents:\n  providers:\n    codex:\n      command: codex exec -\n`;
  const defaults = await loadWorkflowFromFile(await writeWorkflow(base));
  assert.equal(defaults.config.workspace.storage_maintenance?.interval_ms, 86400000);
  assert.equal(defaults.config.workspace.storage_maintenance?.min_free_gib, 20);
  for (const invalid of ['retention_days: -1', 'max_pool_slots: 1.5', 'max_artifact_gib: .inf', 'enabled: definitely']) {
    await assert.rejects(loadWorkflowFromFile(await writeWorkflow(`${base}workspace:\n  storage_maintenance:\n    ${invalid}\n`)), /workspace.storage_maintenance/);
  }
});

test('rejects a malformed route list instead of silently falling back to the default agent', async () => {
  const workflow = await writeWorkflow(`tracker:\n  owner: test\n  repo: app\n  token: test\nagents:\n  providers:\n    codex:\n      command: codex exec -\n  routes:\n    provider: codex\n`);
  await assert.rejects(loadWorkflowFromFile(workflow), /agents.routes must be an array/);
});

import { Command } from 'commander';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { Orchestrator } from './orchestrator/orchestrator.js';
import { MultiRepoOrchestrator } from './orchestrator/multiRepoOrchestrator.js';
import { GithubIssueTrackerClient } from './github/githubClient.js';
import { log } from './utils/log.js';
import { resolveWorkflowPath } from './workflow/resolveWorkflowPath.js';
import { loadWorkflowFromFile } from './workflow/loadWorkflow.js';
import { scanRunStates } from './status/scanRunStates.js';
import { readEpicStates, type EpicState } from './status/epicState.js';
import { loadServerConfigFromFile } from './server/loadServerConfig.js';
import { selectRunState } from './status/selectRunState.js';
import type { RunState } from './status/runState.js';
import type { LoadedWorkflow } from './workflow/types.js';

const execFileAsync = promisify(execFile);

async function loadConfigFromWorkflowPath(workflowPath: string) {
  const loaded = await loadWorkflowFromFile(workflowPath);
  return loaded.config;
}

function resolveConfigPath(configPath: string): string {
  return path.resolve(configPath);
}

async function scanStatesFromServerConfig(configPath: string): Promise<RunState[]> {
  const serverConfig = await loadServerConfigFromFile(configPath);
  const states: RunState[] = [];
  for (const repo of serverConfig.repos.filter((r) => r.enabled)) {
    const workflowConfig = await loadConfigFromWorkflowPath(repo.workflow);
    const repoStates = await scanRunStates(workflowConfig.workspace.root);
    states.push(
      ...repoStates.map((state) => ({
        ...state,
        repo_id: state.repo_id ?? repo.id,
        owner: state.owner ?? workflowConfig.tracker.owner,
        repo: state.repo ?? workflowConfig.tracker.repo,
      })),
    );
  }
  return states;
}

async function scanStates(options: { config?: string; workflow?: string }): Promise<RunState[]> {
  if (options.config) return scanStatesFromServerConfig(resolveConfigPath(options.config));
  const workflowPath = await resolveWorkflowPath(options.workflow ?? 'WORKFLOW.md');
  const config = await loadConfigFromWorkflowPath(workflowPath);
  return scanRunStates(config.workspace.root);
}

async function scanEpicsFromServerConfig(configPath: string): Promise<EpicState[]> {
  const serverConfig = await loadServerConfigFromFile(configPath);
  const states: EpicState[] = [];
  for (const repo of serverConfig.repos.filter((r) => r.enabled)) {
    const workflowConfig = await loadConfigFromWorkflowPath(repo.workflow);
    const repoStates = await readEpicStates(workflowConfig.workspace.root);
    states.push(
      ...repoStates.map((state) => ({
        ...state,
        repo_id: state.repo_id ?? repo.id,
        owner: state.owner ?? workflowConfig.tracker.owner,
        repo: state.repo ?? workflowConfig.tracker.repo,
      })),
    );
  }
  return states;
}

async function scanEpics(options: { config?: string; workflow?: string }): Promise<EpicState[]> {
  if (options.config) return scanEpicsFromServerConfig(resolveConfigPath(options.config));
  const workflowPath = await resolveWorkflowPath(options.workflow ?? 'WORKFLOW.md');
  const config = await loadConfigFromWorkflowPath(workflowPath);
  return readEpicStates(config.workspace.root);
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('bash', ['-lc', `command -v ${command}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function lifecycleLabelsForWorkflow(loaded: LoadedWorkflow): string[] {
  const labels = new Set([
    ...loaded.config.tracker.required_labels,
    ...(loaded.config.tracker.any_required_labels ?? []),
    ...loaded.config.tracker.ignored_labels,
    'agent-running',
    'ready-for-human',
    'needs-info',
    'interactive',
  ]);
  return [...labels].map((label) => label.trim().toLowerCase()).filter(Boolean).sort();
}

async function loadDoctorWorkflows(options: { config?: string; workflow?: string }): Promise<Array<{ id: string; workflowPath: string; loaded: LoadedWorkflow }>> {
  if (options.config) {
    const serverConfig = await loadServerConfigFromFile(resolveConfigPath(options.config));
    const entries = [];
    for (const repo of serverConfig.repos.filter((r) => r.enabled)) {
      entries.push({ id: repo.id, workflowPath: repo.workflow, loaded: await loadWorkflowFromFile(repo.workflow) });
    }
    return entries;
  }

  const workflowPath = await resolveWorkflowPath(options.workflow ?? 'WORKFLOW.md');
  return [{ id: 'default', workflowPath, loaded: await loadWorkflowFromFile(workflowPath) }];
}

async function runDoctor(options: { config?: string; workflow?: string }): Promise<number> {
  const entries = await loadDoctorWorkflows(options);
  let failures = 0;

  const tools = ['git', 'gh', 'codex'];
  for (const tool of tools) {
    const ok = await commandExists(tool);
    // eslint-disable-next-line no-console
    console.log(`${ok ? 'ok' : 'fail'} tool ${tool}`);
    if (!ok) failures += 1;
  }

  for (const entry of entries) {
    const config = entry.loaded.config;
    const prefix = `${entry.id} (${config.tracker.owner}/${config.tracker.repo})`;
    // eslint-disable-next-line no-console
    console.log(`\n${prefix}`);
    // eslint-disable-next-line no-console
    console.log(`ok workflow ${entry.workflowPath}`);

    try {
      await fs.mkdir(config.workspace.root, { recursive: true });
      // eslint-disable-next-line no-console
      console.log(`ok workspace root ${config.workspace.root}`);
    } catch (err) {
      failures += 1;
      // eslint-disable-next-line no-console
      console.log(`fail workspace root ${config.workspace.root}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (config.agent.max_attempts === null) {
      failures += 1;
      // eslint-disable-next-line no-console
      console.log('fail agent.max_attempts is not set');
    } else {
      // eslint-disable-next-line no-console
      console.log(`ok agent.max_attempts ${config.agent.max_attempts}`);
    }

    try {
      const labels = new Set((await new GithubIssueTrackerClient(config.tracker).listLabels()).map((label) => label.name));
      const missingLabels = lifecycleLabelsForWorkflow(entry.loaded).filter((label) => !labels.has(label));
      if (missingLabels.length > 0) {
        failures += 1;
        // eslint-disable-next-line no-console
        console.log(`fail missing labels: ${missingLabels.join(', ')}`);
      } else {
        // eslint-disable-next-line no-console
        console.log('ok lifecycle labels');
      }
    } catch (err) {
      failures += 1;
      // eslint-disable-next-line no-console
      console.log(`fail labels: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return failures;
}

function padRight(input: string, width: number): string {
  if (input.length >= width) return input;
  return input + ' '.repeat(width - input.length);
}

function shortThreadId(threadId: string | null | undefined): string {
  if (!threadId) return '';
  if (threadId.length <= 12) return threadId;
  return `${threadId.slice(0, 12)}...`;
}

async function main(): Promise<void> {
  const program = new Command();

  program.name('symphony').description('Symphony: GitHub-issues-driven coding-agent orchestrator service.');

  program
    .command('run')
    .description('Run the Symphony orchestrator loop')
    .option('-c, --config <path>', 'Path to symphony.config.yml')
    .option('-w, --workflow <path>', 'Path to WORKFLOW.md', 'WORKFLOW.md')
    .option('--once', 'Run a single poll tick, then exit', false)
    .action(async (options: { config?: string; workflow: string; once: boolean }) => {
      const orchestrator = options.config
        ? new MultiRepoOrchestrator({ configPath: resolveConfigPath(options.config) })
        : new Orchestrator({ workflowPath: await resolveWorkflowPath(options.workflow) });

      const shutdown = async (signal: string) => {
        log('info', 'shutdown_requested', { event: 'shutdown_requested', signal });
        await orchestrator.shutdown(`signal:${signal}`);
      };

      process.on('SIGINT', () => {
        void shutdown('SIGINT').finally(() => process.exit(0));
      });
      process.on('SIGTERM', () => {
        void shutdown('SIGTERM').finally(() => process.exit(0));
      });

      if (options.once) {
        await orchestrator.tickOnce();
        await orchestrator.shutdown('once_complete');
        return;
      }

      await orchestrator.runForever();
    });

  program
    .command('status')
    .description('Show issue workspace and epic coordinator status')
    .option('-c, --config <path>', 'Path to symphony.config.yml')
    .option('-w, --workflow <path>', 'Path to WORKFLOW.md', 'WORKFLOW.md')
    .action(async (options: { config?: string; workflow: string }) => {
      const states = await scanStates({ config: options.config, workflow: options.workflow });
      const epics = await scanEpics({ config: options.config, workflow: options.workflow });
      const rows = [
        ...states.map((s) => ({
          issueNumber: s.issue_number ?? Number.POSITIVE_INFINITY,
          repo: s.repo_id ?? '',
          issue: s.issue_number ? `#${s.issue_number}` : s.issue_identifier,
          status: s.status,
          lifecycle: s.workflow_state ?? '',
          labels: (s.labels ?? []).join(','),
          pause: s.pause_reason ?? '',
          thread: shortThreadId(s.codex_thread_id),
          updated: s.updated_at,
          workspace: s.workspace_path,
        })),
        ...epics.map((s) => ({
          issueNumber: s.issue_number ?? Number.POSITIVE_INFINITY,
          repo: s.repo_id ?? '',
          issue: s.issue_number ? `#${s.issue_number}` : s.issue_identifier,
          status: `epic:${s.status}`,
          lifecycle: `${s.terminal_children}/${s.total_children} terminal`,
          labels: s.labels.join(','),
          pause: '',
          thread: '',
          updated: s.updated_at,
          workspace: '(epic coordinator)',
        })),
      ]
        .sort((a, b) => {
          const repoCompare = a.repo.localeCompare(b.repo);
          if (repoCompare !== 0) return repoCompare;
          return a.issueNumber - b.issueNumber;
        })
        .map((s) => ({
          repo: s.repo,
          issue: s.issue,
          status: s.status,
          lifecycle: s.lifecycle,
          labels: s.labels,
          pause: s.pause,
          thread: s.thread,
          updated: s.updated,
          workspace: s.workspace,
        }));

      if (rows.length === 0) {
        // eslint-disable-next-line no-console
        console.log('No run state found.');
        return;
      }

      const issueW = Math.max('issue'.length, ...rows.map((r) => r.issue.length));
      const repoW = Math.max('repo'.length, ...rows.map((r) => r.repo.length));
      const statusW = Math.max('status'.length, ...rows.map((r) => r.status.length));
      const lifecycleW = Math.max('lifecycle'.length, ...rows.map((r) => r.lifecycle.length));
      const pauseW = Math.max('pause'.length, ...rows.map((r) => r.pause.length));
      const threadW = Math.max('thread'.length, ...rows.map((r) => r.thread.length));
      const labelsW = Math.max('labels'.length, ...rows.map((r) => r.labels.length));

      // eslint-disable-next-line no-console
      console.log(
        `${padRight('repo', repoW)}  ${padRight('issue', issueW)}  ${padRight('status', statusW)}  ${padRight('lifecycle', lifecycleW)}  ${padRight('pause', pauseW)}  ${padRight('thread', threadW)}  ${padRight('labels', labelsW)}  updated_at                 workspace`,
      );
      for (const r of rows) {
        // eslint-disable-next-line no-console
        console.log(
          `${padRight(r.repo, repoW)}  ${padRight(r.issue, issueW)}  ${padRight(r.status, statusW)}  ${padRight(r.lifecycle, lifecycleW)}  ${padRight(r.pause, pauseW)}  ${padRight(r.thread, threadW)}  ${padRight(r.labels, labelsW)}  ${r.updated}  ${r.workspace}`,
        );
      }
    });

  program
    .command('open')
    .description('Print workspace + artifact paths for an issue number')
    .argument('<issue_ref>', 'GitHub issue number or repo-qualified ref (e.g. 264 or mdedit#264)')
    .option('-c, --config <path>', 'Path to symphony.config.yml')
    .option('-w, --workflow <path>', 'Path to WORKFLOW.md', 'WORKFLOW.md')
    .action(async (issueRef: string, options: { config?: string; workflow: string }) => {
      const states = await scanStates({ config: options.config, workflow: options.workflow });
      const selection = selectRunState(states, issueRef);
      if (selection.ambiguous) {
        // eslint-disable-next-line no-console
        console.log(`Issue ${issueRef} is ambiguous. Use one of: ${selection.matches.map((s) => `${s.repo_id}#${s.issue_number}`).join(', ')}`);
        return;
      }
      if (!selection.state) {
        // eslint-disable-next-line no-console
        console.log(`No run state found for issue ${issueRef}.`);
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`workspace: ${selection.state.workspace_path}`);
      // eslint-disable-next-line no-console
      console.log(`prompt:    ${selection.state.prompt_path ?? ''}`);
      // eslint-disable-next-line no-console
      console.log(`codex:     ${selection.state.codex_jsonl_path ?? ''}`);
      // eslint-disable-next-line no-console
      console.log(`last:      ${selection.state.last_message_path ?? ''}`);
      // eslint-disable-next-line no-console
      console.log(`status:    ${selection.state.status}`);
      // eslint-disable-next-line no-console
      console.log(`pause:     ${selection.state.pause_reason ?? ''}`);
      // eslint-disable-next-line no-console
      console.log(`labels:    ${(selection.state.labels ?? []).join(',')}`);
      // eslint-disable-next-line no-console
      console.log(`thread:    ${selection.state.codex_thread_id ?? ''}`);
      if (selection.state.codex_thread_id) {
        // eslint-disable-next-line no-console
        console.log(`resume:    codex resume --include-non-interactive ${selection.state.codex_thread_id}`);
        // eslint-disable-next-line no-console
        console.log(`exec:      codex exec resume ${selection.state.codex_thread_id} -`);
      }
    });

  program
    .command('tail')
    .description('Tail the Codex JSONL output for an issue number')
    .argument('<issue_ref>', 'GitHub issue number or repo-qualified ref (e.g. 264 or mdedit#264)')
    .option('-c, --config <path>', 'Path to symphony.config.yml')
    .option('-w, --workflow <path>', 'Path to WORKFLOW.md', 'WORKFLOW.md')
    .option('-n, --lines <n>', 'Lines to show before following', '200')
    .action(async (issueRef: string, options: { config?: string; workflow: string; lines: string }) => {
      const lines = Number(options.lines);
      const safeLines = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 200;

      const states = await scanStates({ config: options.config, workflow: options.workflow });
      const selection = selectRunState(states, issueRef);
      if (selection.ambiguous) {
        // eslint-disable-next-line no-console
        console.log(`Issue ${issueRef} is ambiguous. Use one of: ${selection.matches.map((s) => `${s.repo_id}#${s.issue_number}`).join(', ')}`);
        return;
      }
      if (!selection.state || !selection.state.codex_jsonl_path) {
        // eslint-disable-next-line no-console
        console.log(`No codex log found for issue ${issueRef}.`);
        return;
      }

      const child = spawn('tail', ['-n', String(safeLines), '-f', selection.state.codex_jsonl_path], { stdio: 'inherit' });
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', () => resolve());
      });
    });

  program
    .command('doctor')
    .description('Check Symphony config, required tools, workspace roots, and GitHub lifecycle labels')
    .option('-c, --config <path>', 'Path to symphony.config.yml')
    .option('-w, --workflow <path>', 'Path to WORKFLOW.md', 'WORKFLOW.md')
    .action(async (options: { config?: string; workflow: string }) => {
      const failures = await runDoctor({ config: options.config, workflow: options.workflow });
      if (failures > 0) process.exitCode = 1;
    });

  await program.parseAsync(process.argv);
}

await main();

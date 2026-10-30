import { EpisodeStore } from '../episodes/episodeStore.js';
import type { ActivityBatch, Activity } from './notifications.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GithubIssueTrackerClient } from '../github/githubClient.js';
import { loadServerConfigFromFile } from '../server/loadServerConfig.js';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import { scanRunStates } from '../status/scanRunStates.js';
import { readRunState } from '../status/runState.js';
import { acquireWorkflowLock } from '../orchestrator/workflowLock.js';
import { sleep } from '../utils/sleep.js';
import { loadAttachmentStorage } from './attachmentStorage.js';
import { TelegramMediaError } from './media.js';
import { intakeAliases } from './intakeRouting.js';
import { TelegramBotApi } from './api.js';
import { TelegramBridge, loadBridgeState, saveBridgeState, type BridgeBackend, type BridgeTask } from './bridge.js';

export interface TelegramBridgeOptions {
  attachmentConfig?: string;
  config?: string;
  workflow?: string;
  tokenFile?: string;
  chatId?: string;
  userId?: string;
  stateDir: string;
  briefHour?: string;
  briefTimezone?: string;
}

function telegramId(raw: string, name: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${name} must be a positive integer (private chats only)`);
  return id;
}

export async function createBridgeBackend(options: { config?: string; workflow?: string; attachmentConfig?: string }): Promise<BridgeBackend> {
  const attachments = options.attachmentConfig ? await loadAttachmentStorage(options.attachmentConfig) : null;
  const repos = options.config
    ? (await loadServerConfigFromFile(path.resolve(options.config))).repos.filter((repo) => repo.enabled)
    : [{ id: 'default', workflow: path.resolve(options.workflow ?? 'WORKFLOW.md') }];
  const entries = await Promise.all(repos.map(async (repo) => {
    const { config } = await loadWorkflowFromFile(repo.workflow);
    return { id: repo.id, config, github: new GithubIssueTrackerClient(config.tracker) };
  }));
  function entryFor(task: BridgeTask) {
    const entry = entries.find((candidate) => task.key === `${candidate.id}#${task.state.issue_number}`);
    if (!entry) throw new Error('Task repository is no longer configured');
    return entry;
  }
  function intakeEntry(repoId: string) {
    const entry = entries.find(entry => entry.id === repoId);
    if (!entry) throw new Error('Intake repository is no longer configured');
    return entry;
  }
  return {
    async activity(cursors) {
      return Promise.all(entries.map(async entry => {
        const batch: ActivityBatch = {repo:entry.id,cursor:cursors[entry.id] ?? 0,activities:[]};
        const file = path.join(entry.config.workspace.root,'.symphony','episodes.sqlite');
        if (!(await fs.access(file).then(() => true, () => false))) return batch;
        const store = new EpisodeStore(file);
        try {
          const repoIds = [entry.id,`${entry.config.tracker.owner}/${entry.config.tracker.repo}`];
          // Old single-workflow installations use owner/repo while the multi-repo server uses id.
          const events = store.list({after_sequence:batch.cursor,limit:1000});
          if (cursors[entry.id] === undefined) {
            batch.cursor = store.latest()?.sequence ?? 0;
            return batch; // Baseline existing history when enabling briefs; never replay old notifications.
          }
          for (const event of events) {
            batch.cursor = event.sequence;
            if (!repoIds.includes(event.repo_id)) continue;
            const payload = event.payload;
            const number = event.event === 'merge.merged' ? payload.pr_number : payload.issue_number;
            const kind: Activity['kind'] | null = event.event === 'merge.merged' ? 'merged'
              : event.event === 'workflow.completed' ? 'completed' : event.event === 'workflow.failed' ? 'failed'
              : event.event === 'workflow.paused' ? 'paused' : null;
            if (!kind || typeof number !== 'number') continue;
            batch.activities.push({repo:entry.id,key:`${entry.id}#${number}`,kind,
              url:`https://github.com/${entry.config.tracker.owner}/${entry.config.tracker.repo}/${kind === 'merged' ? 'pull' : 'issues'}/${number}`});
            if (kind === 'completed' && Array.isArray(payload.followup_urls)) {
              for (const url of payload.followup_urls) if (typeof url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(url)) {
                batch.activities.push({repo:entry.id,key:url,kind:'followup',url});
              }
            }
          }
          return batch;
        } finally {store.close();}
      }));
    },
    async repositories() {
      return entries.map(entry => ({ id: entry.id, repository: `${entry.config.tracker.owner}/${entry.config.tracker.repo}`, aliases: intakeAliases(entry.config.tracker.repo) }));
    },
    async findIntake(repoId, marker, since) {
      return intakeEntry(repoId).github.findTelegramIntake(marker, since);
    },
    async createIntake(repoId, text, marker, images) {
      return intakeEntry(repoId).github.createTelegramIntake(text, marker, images);
    },
    async storeImage(repoId, key, image) {
      intakeEntry(repoId);
      if (!attachments) throw new TelegramMediaError('Image uploads are not configured. Configure the shared TaskDrop attachment service and resend.');
      return attachments.store(key, image);
    },
    async capturedComment(repoId, number, marker, text) {
      return (await intakeEntry(repoId).github.upsertStatusComment(number, marker, `${marker}\n${text}`)).id;
    },
    async storageAlerts() {
      const alerts = await Promise.all(entries.map(async entry => {
        const status = await fs.readFile(path.join(entry.config.workspace.root, '.symphony', 'storage-status.json'), 'utf8')
          .then(raw => JSON.parse(raw) as { blocked: boolean; minimum_free_gib: number }).catch(() => null);
        return status && typeof status.blocked === 'boolean' && Number.isFinite(status.minimum_free_gib)
          ? { key: entry.id, ...status } : null;
      }));
      return alerts.filter((alert): alert is NonNullable<typeof alert> => alert !== null);
    },
    async tasks() {
      const all = await Promise.all(entries.map(async (entry) => {
        const states = await scanRunStates(entry.config.workspace.root);
        return Promise.all(states.filter((state) => state.issue_number !== null &&
          (!state.owner || state.owner === entry.config.tracker.owner) &&
          (!state.repo || state.repo === entry.config.tracker.repo)).map(async (state) => ({
          key: `${entry.id}#${state.issue_number}`,
          state,
          lastMessage: state.last_message_path
            ? await fs.readFile(state.last_message_path, 'utf8').catch(() => '') : '',
        })));
      }));
      const latest = new Map<string, BridgeTask>();
      for (const task of all.flat()) {
        if (!latest.has(task.key) || task.state.updated_at > latest.get(task.key)!.state.updated_at) latest.set(task.key, task);
      }
      return [...latest.values()];
    },
    async comment(task, marker, text) {
      return (await entryFor(task).github.upsertStatusComment(task.state.issue_number!, marker, `${marker}\n${text}`)).id;
    },
    async resume(task) {
      const entry = entryFor(task);
      const current = await readRunState(task.state.workspace_path);
      // Never requeue a newer session or a worker which is still running/finalizing.
      if (!current || current.session_id !== task.state.session_id ||
          !['paused', 'completed', 'failed'].includes(current.status) ||
          (current.status === 'paused' && current.pause_reason !== 'needs-info')) return false;
      // The GitHub client caches issue reads; use a fresh client for each resume decision.
      const github = new GithubIssueTrackerClient(entry.config.tracker);
      const issue = await github.fetchIssueOrPullRequestByNumber(task.state.issue_number!);
      if (!issue || !entry.config.tracker.active_states.includes(issue.state) ||
          issue.labels.some((label) => ['interactive', 'blocked', 'wontfix', 'agent-running'].includes(label))) return false;
      const removable = ['needs-info', 'ready-for-human', 'symphony-failed'];
      if (issue.labels.some((label) => entry.config.tracker.ignored_labels.includes(label) && !removable.includes(label))) return false;
      // Remove blocking lifecycle labels before adding the queue label.
      await github.transitionLabels(issue.number!, { remove: removable });
      await github.addLabels(issue.number!, ['ready-for-agent', ...entry.config.tracker.required_labels,
        ...(entry.config.tracker.any_required_labels?.slice(0, 1) ?? [])]);
      return true;
    },
  };
}

export async function runTelegramBridge(options: TelegramBridgeOptions): Promise<void> {
  const pairing = !options.chatId && !options.userId
    ? JSON.parse(await fs.readFile(path.join(path.resolve(options.stateDir), 'pairing.json'), 'utf8')) as { chatId: string; userId: string }
    : null;
  const chatId = telegramId(options.chatId ?? pairing?.chatId ?? '', '--chat-id');
  const userId = telegramId(options.userId ?? pairing?.userId ?? '', '--user-id');
  const token = options.tokenFile ? (await fs.readFile(options.tokenFile, 'utf8')).trim() : process.env.SYMPHONY_TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Provide a valid bot token through --token-file or SYMPHONY_TELEGRAM_BOT_TOKEN');
  const stateDir = path.resolve(options.stateDir);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockResult = await acquireWorkflowLock({ workspaceRoot: stateDir, workflowPath: options.config ?? options.workflow ?? 'WORKFLOW.md', repoId: 'telegram', owner: null, repo: null });
  if (!lockResult.acquired) throw new Error('A Telegram bridge already owns this state directory');
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const statePath = path.join(stateDir, 'telegram.json');
    // Bind durable routing and update cursors to one bot/chat/user identity.
    const { createHash } = await import('node:crypto');
    const identity = createHash('sha256').update(`${token.split(':')[0]}:${chatId}:${userId}:${path.resolve(options.config ?? options.workflow ?? 'WORKFLOW.md')}`).digest('hex');
    const identityPath = path.join(stateDir, 'identity');
    const existing = await fs.readFile(identityPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    if (existing !== null && existing !== identity) throw new Error('Use a different --state-dir for a different bot/chat/user');
    await fs.writeFile(identityPath, identity, { mode: 0o600 });
    const state = await loadBridgeState(statePath);
    const backend = await createBridgeBackend({ ...options, attachmentConfig: options.attachmentConfig ?? path.join(stateDir, 'attachments.json') });
    const api = new TelegramBotApi(token, chatId);
    const bridge = new TelegramBridge(api, backend, state, { chatId, userId }, () => saveBridgeState(statePath, state), identity, {hour:Number(options.briefHour ?? 9),timeZone:options.briefTimezone ?? 'America/Toronto'});
    console.log('Telegram bridge started. Only the configured private chat and user are authorized.');
    while (!stopped) {
      try {
        await bridge.notify();
        for (const update of await api.updates(state.offset)) {
          if (stopped) break;
          await bridge.receive(update);
        }
      } catch {
        // Do not log provider errors: they can contain tokens or private task content.
        console.error('Telegram bridge cycle failed; retrying in 10 seconds. Check connectivity, bot configuration, and GitHub access.');
        await sleep(10_000);
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await lockResult.lock.release();
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunState } from '../status/runState.js';
import { parsePauseRequest, formatPauseComment } from '../orchestrator/pauseProtocol.js';
import type { TelegramApi, TelegramUpdate } from './api.js';

export interface BridgeTask {
  key: string;
  state: RunState;
  lastMessage: string;
}

export interface BridgeBackend {
  tasks(): Promise<BridgeTask[]>;
  storageAlerts?(): Promise<Array<{ key: string; blocked: boolean; minimum_free_gib: number }>>;
  // Must be idempotent by marker. Never pass arbitrary Telegram text to a shell.
  comment(task: BridgeTask, marker: string, text: string): Promise<number>;
  // Recheck GitHub state and labels before changing lifecycle labels.
  resume(task: BridgeTask): Promise<boolean>;
}

interface Target { key: string; session: string | null; question: boolean }
export interface BridgeState {
  offset: number;
  seen: Record<string, string>;
  messages: Record<string, Target>;
  pending: Record<string, { commentId: number }>;
}

export async function loadBridgeState(file: string): Promise<BridgeState> {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8')) as BridgeState;
    if (!Number.isSafeInteger(state.offset) || !state.seen || !state.messages || !state.pending) {
      throw new Error('Invalid Telegram bridge state');
    }
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { offset: 0, seen: {}, messages: {}, pending: {} };
  }
}

export async function saveBridgeState(file: string, state: BridgeState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function busy(task: BridgeTask): boolean {
  return ['agent-running', 'finalizing', 'retry-wait'].includes(task.state.status);
}

export class TelegramBridge {
  constructor(
    private api: TelegramApi,
    private backend: BridgeBackend,
    readonly state: BridgeState,
    private authorized: { chatId: number; userId: number },
    private persist: () => Promise<void>,
  ) {}

  private async taskMessage(task: BridgeTask, text: string, question = false): Promise<void> {
    const id = await this.api.send(`${task.key}: ${task.state.issue_title ?? task.state.issue_identifier}\n${task.state.issue_url ?? ''}\n\n${text}`);
    this.state.messages[String(id)] = { key: task.key, session: task.state.session_id, question };
  }

  async notify(): Promise<void> {
    for (const alert of await this.backend.storageAlerts?.() ?? []) {
      const key = `$storage:${alert.key}`;
      const fingerprint = `${alert.blocked}:${alert.minimum_free_gib}`;
      if (this.state.seen[key] === fingerprint) continue;
      if (alert.blocked || this.state.seen[key]?.startsWith('true:')) {
        await this.api.send(`${alert.key}: ${alert.blocked
          ? `New Symphony work is paused: free disk space is below ${alert.minimum_free_gib} GiB or the workspace filesystem is unavailable. Active jobs continue. Free space to resume automatically.`
          : 'Disk space has recovered. Symphony can dispatch new work again.'}`);
      }
      this.state.seen[key] = fingerprint;
      await this.persist();
    }
    for (const task of await this.backend.tasks()) {
      const fingerprint = `${task.state.session_id}:${task.state.attempt}:${task.state.status}:${task.state.finished_at}`;
      const previous = this.state.seen[task.key];
      if (previous === fingerprint) continue;
      const question = task.state.status === 'paused' && task.state.pause_reason === 'needs-info';
      // Baseline historical successes/failures on first observation; surface existing questions.
      if (previous !== undefined || question) {
        const pause = question ? parsePauseRequest(task.lastMessage) : null;
        if (question) {
          await this.taskMessage(task, `${pause ? formatPauseComment(pause) : 'The agent needs input. See the issue for its question.'}\n\nReply to this message to answer and resume.`, true);
        } else if (['completed', 'failed', 'cancelled', 'paused'].includes(task.state.status)) {
          const detail = task.state.status === 'completed' ? task.lastMessage : task.state.last_error;
          await this.taskMessage(task, `${task.state.status}\n${(detail ?? '').slice(0, 2600)}\n\nReply with follow-up instructions. Interactive handoffs still need to be handled in Symphony.`);
        }
      }
      this.state.seen[task.key] = fingerprint;
      await this.persist();
    }
    await this.flushPending();
  }

  private async flushPending(): Promise<void> {
    for (const task of await this.backend.tasks()) {
      const pending = this.state.pending[task.key];
      if (!pending || busy(task)) continue;
      // The run context cursor proves whether a later run consumed this comment.
      if ((task.state.last_seen_comment_id ?? 0) < pending.commentId) {
        const resumed = await this.backend.resume(task);
        await this.taskMessage(task, resumed ? 'Your saved follow-up is queued for another run.' : 'Your follow-up is saved on GitHub. The task could not be requeued; check its labels and open/closed state.');
      }
      delete this.state.pending[task.key];
      await this.persist();
    }
  }

  async receive(update: TelegramUpdate): Promise<void> {
    if (update.update_id < this.state.offset) return;
    const message = update.message;
    if (message && message.chat.type === 'private' && message.chat.id === this.authorized.chatId &&
        message.from?.id === this.authorized.userId && !message.from.is_bot) {
      const text = message.text?.trim();
      if (text) await this.handleText(text, message.reply_to_message?.message_id, update.update_id);
    }
    // Save only after effects complete. A retried update reuses its GitHub comment marker.
    this.state.offset = update.update_id + 1;
    await this.persist();
  }

  private async handleText(text: string, replyId: number | undefined, updateId: number): Promise<void> {
    const tasks = await this.backend.tasks();
    if (/^\/(start|help)(?:@\w+)?$/.test(text)) {
      await this.api.send('Symphony is connected. Use /status or /questions. Reply to a task message to save instructions on GitHub and resume eligible tasks. Running tasks consume follow-ups in a later run.');
      return;
    }
    if (/^\/status(?:@\w+)?$/.test(text)) {
      await this.api.send(tasks.map((task) => `${task.key}: ${task.state.status}`).join('\n') || 'No Symphony runs found.');
      return;
    }
    if (/^\/questions(?:@\w+)?$/.test(text)) {
      const questions = tasks.filter((task) => task.state.status === 'paused' && task.state.pause_reason === 'needs-info');
      for (const task of questions) {
        const pause = parsePauseRequest(task.lastMessage);
        await this.taskMessage(task, `${pause ? formatPauseComment(pause) : 'See the issue for the agent question.'}\n\nReply here to answer and resume.`, true);
        await this.persist();
      }
      if (!questions.length) await this.api.send('No tasks waiting for input.');
      return;
    }
    const target = replyId === undefined ? undefined : this.state.messages[String(replyId)];
    const task = target && tasks.find((entry) => entry.key === target.key);
    if (!task || !target) {
      await this.api.send('Reply to one of my task messages so I can identify the repository and issue. Use /questions to retrieve pending questions.');
      return;
    }
    if (target.question && (target.session !== task.state.session_id || task.state.status !== 'paused' || task.state.pause_reason !== 'needs-info')) {
      await this.api.send('That question belongs to an earlier run or has already been answered. Use /questions for current questions.');
      return;
    }
    const marker = `<!-- symphony-telegram:${this.authorized.chatId}:${updateId} -->`;
    const commentId = await this.backend.comment(task, marker, `User instruction received through the authorized Telegram bridge:\n\n${text}`);
    if (busy(task)) {
      this.state.pending[task.key] = { commentId };
      await this.persist();
      await this.api.send('Saved on GitHub. The agent is running; I will queue your follow-up when this run finishes. It has not received this instruction yet.');
      return;
    }
    const resumed = await this.backend.resume(task);
    await this.api.send(resumed ? 'Saved on GitHub and queued for Symphony to resume.' : 'Saved on GitHub. This task needs manual attention before it can resume (for example, it is closed, blocked, or an interactive handoff).');
  }
}

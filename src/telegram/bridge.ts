import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { RunState } from '../status/runState.js';
import { parsePauseRequest, formatPauseComment } from '../orchestrator/pauseProtocol.js';
import { resolveIntake, type IntakeRepository } from './intakeRouting.js';
import { messageImage, MAX_IMAGE_BYTES, TelegramMediaError, type TelegramImage, type DownloadedImage } from './media.js';
import type { TelegramApi, TelegramUpdate } from './api.js';

export interface BridgeTask {
  key: string;
  state: RunState;
  lastMessage: string;
}

export interface IntakeIssue { number: number; title: string; url: string }
interface IntakeRecord {
  repoId: string;
  marker: string;
  since: string;
  issue?: IntakeIssue;
  stage?: 'prepared' | 'posting';
  images?: string;
}

export interface BridgeBackend {
  repositories?(): Promise<IntakeRepository[]>;
  findIntake?(repoId: string, marker: string, since: string): Promise<IntakeIssue | null>;
  createIntake?(repoId: string, text: string, marker: string, images?: string): Promise<IntakeIssue>;
  storeImage?(repoId: string, key: string, image: DownloadedImage): Promise<string>;
  capturedComment?(repoId: string, number: number, marker: string, text: string): Promise<number>;
  tasks(): Promise<BridgeTask[]>;
  storageAlerts?(): Promise<Array<{ key: string; blocked: boolean; minimum_free_gib: number }>>;
  // Must be idempotent by marker. Never pass arbitrary Telegram text to a shell.
  comment(task: BridgeTask, marker: string, text: string): Promise<number>;
  // Recheck GitHub state and labels before changing lifecycle labels.
  resume(task: BridgeTask): Promise<boolean>;
}

interface Target { key: string; session: string | null; question: boolean }
interface MediaGroup {
  updateId: number;
  text: string;
  replyId?: number;
  messageIds: number[];
  images: TelegramImage[];
  updatedAt: number;
  target?: Target;
}
export interface BridgeState {
  mediaGroups?: Record<string, MediaGroup>;
  intakes?: Record<string, IntakeRecord>;
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
    if (state.intakes !== undefined && (!state.intakes || Array.isArray(state.intakes) || typeof state.intakes !== 'object' ||
        Object.values(state.intakes).some(record => !record || typeof record.repoId !== 'string' ||
          (record.stage !== undefined && !['prepared', 'posting'].includes(record.stage)) ||
          (record.images !== undefined && typeof record.images !== 'string') ||
          !/^<!-- symphony-intake:[a-f0-9]{64} -->$/.test(record.marker) || !Number.isFinite(Date.parse(record.since)) ||
          (record.issue !== undefined && (!record.issue || !Number.isSafeInteger(record.issue.number) ||
            record.issue.number <= 0 || typeof record.issue.title !== 'string' || typeof record.issue.url !== 'string'))))) {
      throw new Error('Invalid Telegram intake state');
    }
    if (state.mediaGroups !== undefined && (!state.mediaGroups || Array.isArray(state.mediaGroups) || typeof state.mediaGroups !== 'object' ||
        Object.values(state.mediaGroups).some(group => !group || !Number.isSafeInteger(group.updateId) ||
          typeof group.text !== 'string' || !Array.isArray(group.messageIds) || !group.messageIds.every(Number.isSafeInteger) ||
          !Number.isFinite(group.updatedAt) || !Array.isArray(group.images) || group.images.length > 10 ||
          group.images.some(image => !image || typeof image.file_id !== 'string' || typeof image.file_unique_id !== 'string') ||
          (group.replyId !== undefined && !Number.isSafeInteger(group.replyId)) ||
          (group.target !== undefined && (!group.target || typeof group.target.key !== 'string' || typeof group.target.question !== 'boolean'))))) {
      throw new Error('Invalid Telegram media state');
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
    private namespace = 'telegram',
  ) {}

  private async taskMessage(task: BridgeTask, text: string, question = false): Promise<void> {
    const id = await this.api.send(`${task.key}: ${task.state.issue_title ?? task.state.issue_identifier}\n${task.state.issue_url ?? ''}\n\n${text}`);
    this.state.messages[String(id)] = { key: task.key, session: task.state.session_id, question };
  }

  async notify(): Promise<void> {
    await this.flushMediaGroups();
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
      try {
        const image = messageImage(message);
        const text = (message.text ?? message.caption ?? '').trim();
        if (image && message.media_group_id) {
          const groups = this.state.mediaGroups ??= {};
          const group = groups[message.media_group_id] ??= {
            updateId: update.update_id, text: '', messageIds: [], images: [], updatedAt: Date.now(),
          };
          if (group.target) {
            await this.handleReply(text || 'Additional image context.', group.messageIds[0], update.update_id, [image]);
          } else if (!group.messageIds.includes(message.message_id)) {
            if (group.images.length >= 10) throw new TelegramMediaError('Send at most 10 images per album.');
            group.messageIds.push(message.message_id);
            group.images.push(image);
            if (text) group.text += `${group.text ? '\n\n' : ''}${text}`;
            group.replyId ??= message.reply_to_message?.message_id;
            group.updatedAt = Date.now();
          }
        } else if (image) {
          const target = await this.handleMedia(text, message.reply_to_message?.message_id, update.update_id, [image]);
          if (target) this.state.messages[String(message.message_id)] = target;
        } else if (text) await this.handleText(text, message.reply_to_message?.message_id, update.update_id);
      } catch (error) {
        if (!(error instanceof TelegramMediaError)) throw error;
        await this.api.send(error.message);
      }
    }
    // Save only after effects complete. A retried update reuses its GitHub comment marker.
    this.state.offset = update.update_id + 1;
    await this.persist();
  }

  private async flushMediaGroups(): Promise<void> {
    for (const [id, group] of Object.entries(this.state.mediaGroups ?? {})) {
      if (group.target || Date.now() - group.updatedAt < 2000) continue;
      try {
        const target = await this.handleMedia(group.text, group.replyId, group.updateId, group.images);
        if (target) {
          group.target = target;
          for (const messageId of group.messageIds) this.state.messages[String(messageId)] = target;
          group.images = [];
        } else delete this.state.mediaGroups![id];
      } catch (error) {
        if (!(error instanceof TelegramMediaError)) throw error;
        await this.api.send(error.message);
        delete this.state.mediaGroups![id];
      }
      await this.persist();
    }
  }

  private async handleMedia(text: string, replyId: number | undefined, updateId: number, images: TelegramImage[]): Promise<Target | undefined> {
    if (/^\/new(?:@\w+)?(?:\s|$)/.test(text)) return this.intake(text, updateId, images);
    return this.handleReply(text || 'Image context supplied through Telegram.', replyId, updateId, images);
  }

  private async imageMarkdown(repoId: string, updateId: number, images: TelegramImage[]): Promise<string> {
    if (!images.length) return '';
    if (!this.api.downloadImage || !this.backend.storeImage) throw new TelegramMediaError('Image uploads are unavailable in this bridge.');
    const downloaded: DownloadedImage[] = [];
    for (const image of images) {
      if ((image.file_size ?? 0) > MAX_IMAGE_BYTES) throw new TelegramMediaError('Images must be at most 8 MiB each.');
      downloaded.push(await this.api.downloadImage(image.file_id));
    }
    const urls: string[] = [];
    for (const [index, image] of images.entries()) {
      const key = createHash('sha256').update(`${this.namespace}:${repoId}:${updateId}:${image.file_unique_id}`).digest('hex');
      urls.push(await this.backend.storeImage(repoId, key, downloaded[index]!));
    }
    return `\n\n### Images supplied through Telegram\n\n${urls.map((url, index) => `![Telegram image ${index + 1}](${url})`).join('\n\n')}`;
  }

  private async intake(command: string, updateId: number, images: TelegramImage[] = []): Promise<Target | undefined> {
    const repos = await this.backend.repositories?.() ?? [];
    const result = resolveIntake(command.replace(/^\/new(?:@\w+)?\s*/, ''), repos);
    if (result.kind === 'invalid' || (result.kind === 'matched' && result.text.length > 8000)) {
      await this.api.send('Use /new <repo or alias> <task> (up to 8000 characters). Example: /new camera coach Improve framing tips. Use /repos for names and aliases.');
      return;
    }
    if (result.kind === 'ambiguous') {
      await this.api.send(`That name matches multiple repositories: ${result.ids.join(', ')}. Use a more specific name from /repos; no issue was created.`);
      return;
    }
    if (result.kind !== 'matched' || !this.backend.findIntake || !this.backend.createIntake) {
      await this.api.send('Unknown or unavailable repository. Use /repos for configured names and aliases.');
      return;
    }
    const { repo, text } = result;
    const records = this.state.intakes ??= {};
    const key = String(updateId);
    let record = records[key];
    if (!record) {
      const hash = createHash('sha256').update(`${this.namespace}:${this.authorized.chatId}:${updateId}`).digest('hex');
      record = records[key] = { stage: 'prepared', repoId: repo.id, marker: `<!-- symphony-intake:${hash} -->`, since: new Date(Date.now() - 300_000).toISOString() };
    }
    // Persist preparation before uploads; mark posting durably before the issue POST.
    await this.persist();
    if (!record.issue) {
      record.issue = await this.backend.findIntake(record.repoId, record.marker, record.since) ?? undefined;
      if (!record.issue && record.stage === 'prepared') {
        record.images ??= await this.imageMarkdown(record.repoId, updateId, images);
        record.stage = 'posting';
        await this.persist();
        try {
          record.issue = await this.backend.createIntake(record.repoId, text, record.marker, record.images);
        } catch {
          // POST may have succeeded despite a lost response. Never blindly repeat it.
          record.issue = await this.backend.findIntake(record.repoId, record.marker, record.since).catch(() => null) ?? undefined;
        }
      }
    }
    await this.persist();
    if (!record.issue) {
      await this.api.send(`${record.repoId}: issue creation could not be confirmed. Use /intakes to check again, and check GitHub before submitting another /new command.`);
      return;
    }
    const messageId = await this.api.send(`${record.repoId}#${record.issue.number}: ${record.issue.title}\n${record.issue.url}\n\nCaptured with requires-grooming. Symphony will gather context and ask questions if needed when the orchestrator runs. Reply to this message with more text or images, or answer the bot's grooming questions here.`);
    const target = { key: `${record.repoId}#${record.issue.number}`, session: null, question: false };
    this.state.messages[String(messageId)] = target;
    await this.persist();
    return target;
  }

  private async handleText(text: string, replyId: number | undefined, updateId: number): Promise<void> {
    if (/^\/repos(?:@\w+)?$/.test(text)) {
      const repos = await this.backend.repositories?.() ?? [];
      await this.api.send(repos.map(repo => `${repo.id}: ${repo.repository}${repo.aliases?.length ? ` (aliases: ${repo.aliases.join(", ")})` : ''}`).join('\n') || 'No repositories configured for intake.');
      return;
    }
    if (/^\/new(?:@\w+)?(?:\s|$)/.test(text)) {
      await this.intake(text, updateId);
      return;
    }
    const tasks = await this.backend.tasks();
    if (/^\/(start|help)(?:@\w+)?$/.test(text)) {
      await this.api.send('Symphony is connected. Use /repos to list repositories, /new <repo> <task> to capture an idea for grooming, /intakes to recover uncertain captures, /status or /questions. Reply to a task message to save instructions on GitHub and resume eligible tasks. You can attach photos or image files with /new in the caption, or reply with images to a task message. Running tasks consume follow-ups in a later run.');
      return;
    }
    if (/^\/intakes(?:@\w+)?$/.test(text)) {
      const captures = Object.values(this.state.intakes ?? {});
      for (const record of captures) {
        if (!record.issue) {
          record.issue = await this.backend.findIntake?.(record.repoId, record.marker, record.since) ?? undefined;
        }
      }
      await this.persist();
      await this.api.send(captures.slice(-10).map(record => record.issue
        ? `${record.repoId}#${record.issue.number}: ${record.issue.url}`
        : `${record.repoId}: creation unconfirmed. Check GitHub before submitting again.`).join('\n') || 'No Telegram captures recorded.');
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
    await this.handleReply(text, replyId, updateId);
  }

  private async handleReply(text: string, replyId: number | undefined, updateId: number, images: TelegramImage[] = []): Promise<Target | undefined> {
    const tasks = await this.backend.tasks();
    const target = replyId === undefined ? undefined : this.state.messages[String(replyId)];
    const task = target && tasks.find((entry) => entry.key === target.key);
    if (!target) {
      await this.api.send('Reply to one of my task messages so I can identify the repository and issue. Use /questions for pending questions, or send an image with /new <repo> <task> as its caption.');
      return;
    }
    if (target.question && (!task || target.session !== task.state.session_id || task.state.status !== 'paused' || task.state.pause_reason !== 'needs-info')) {
      await this.api.send('That question belongs to an earlier run or has already been answered. Use /questions for current questions.');
      return;
    }
    const capture = Object.values(this.state.intakes ?? {}).find(record => record.issue && `${record.repoId}#${record.issue.number}` === target.key);
    if (!task && (!capture?.issue || !this.backend.capturedComment)) {
      await this.api.send('That task is no longer available. Use /questions for current questions.');
      return;
    }
    const repoId = capture?.repoId ?? target.key.slice(0, target.key.lastIndexOf('#'));
    const markdown = await this.imageMarkdown(repoId, updateId, images);
    const marker = `<!-- symphony-telegram:${this.authorized.chatId}:${updateId} -->`;
    const body = `User instruction received through the authorized Telegram bridge:\n\n${text}${markdown}`;
    if (!task) {
      await this.backend.capturedComment!(capture!.repoId, capture!.issue!.number, marker, body);
      await this.api.send('Context saved on the GitHub issue.');
      return target;
    }
    const commentId = await this.backend.comment(task, marker, body);
    if (busy(task)) {
      this.state.pending[task.key] = { commentId };
      await this.persist();
      await this.api.send('Saved on GitHub. The agent is running; I will queue your follow-up when this run finishes. It has not received this instruction yet.');
      return target;
    }
    const resumed = await this.backend.resume(task);
    await this.api.send(resumed ? 'Saved on GitHub and queued for Symphony to resume.' : 'Saved on GitHub. This task needs manual attention before it can resume (for example, it is closed, blocked, or an interactive handoff).');
    return target;
  }
}

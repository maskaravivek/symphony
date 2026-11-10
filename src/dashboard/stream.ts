import fs, { type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import type { ChangeEvent } from '../status/dashboardTypes.js';
import type { DashboardGithubCache } from '../status/dashboard/githubCache.js';
import type { DashboardSources } from '../status/dashboard/sources.js';

export const STREAM_DEBOUNCE_MS = 750;
/** Continuous writes (an agent streaming its log) still produce an event at least this often. */
export const STREAM_MAX_WAIT_MS = 5_000;
export const STREAM_PING_MS = 25_000;
export const STREAM_RESCAN_MS = 60_000;

/** Noisy, irrelevant paths under `<workspace.root>/.symphony`. */
const IGNORED_PREFIXES = ['repository.git', 'hooks', 'toolchains', 'logs', 'orchestrator.lock'];

export interface ChangeStreamOptions {
  getSources: () => Promise<DashboardSources>;
  github?: DashboardGithubCache | null;
  debounceMs?: number;
  maxWaitMs?: number;
  pingMs?: number;
  rescanMs?: number;
}

interface Pending {
  timer: NodeJS.Timeout;
  firstAt: number;
  scope: ChangeEvent['scope'];
}

/**
 * Server-sent change notifications for `/api/stream`. Watches each workspace root's `.symphony`
 * directory, each slot's `.symphony` directory, and the orchestrator heartbeat; debounces per
 * repo and tells clients to refetch. Watchers start with the first client.
 */
export class DashboardChangeStream {
  private readonly clients = new Set<ServerResponse>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, Pending>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pingMs: number;
  private readonly rescanMs: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private unsubscribeGithub: (() => void) | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: ChangeStreamOptions) {
    this.debounceMs = options.debounceMs ?? STREAM_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? STREAM_MAX_WAIT_MS;
    this.pingMs = options.pingMs ?? STREAM_PING_MS;
    this.rescanMs = options.rescanMs ?? STREAM_RESCAN_MS;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get watchedPaths(): string[] {
    return [...this.watchers.keys()];
  }

  handle(req: IncomingMessage, res: ServerResponse, head = false): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (head || this.closed) {
      res.end();
      return;
    }
    res.write('retry: 5000\n: connected\n\n');
    this.clients.add(res);
    const remove = () => {
      this.clients.delete(res);
    };
    req.on('close', remove);
    res.on('close', remove);
    void this.start();
  }

  /** Sends a change event to every client (also used by tests). */
  emit(event: ChangeEvent): void {
    const payload = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.pingTimer = null;
    this.rescanTimer = null;
    this.unsubscribeGithub?.();
    this.unsubscribeGithub = null;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) if (!client.writableEnded) client.write(': ping\n\n');
    }, this.pingMs);
    this.pingTimer.unref();
    this.unsubscribeGithub = this.options.github?.onRefresh((repoId) => this.emit({ at: new Date().toISOString(), scope: 'github', repo_id: repoId })) ?? null;
    await this.rescan();
    this.rescanTimer = setInterval(() => void this.rescan(), this.rescanMs);
    this.rescanTimer.unref();
  }

  private schedule(repoId: string | null, scope: ChangeEvent['scope']): void {
    if (this.closed) return;
    const key = repoId ?? '';
    const now = Date.now();
    const existing = this.pending.get(key);
    const fire = () => {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      this.emit({ at: new Date().toISOString(), scope: pending?.scope ?? scope, repo_id: repoId });
    };
    if (existing) {
      clearTimeout(existing.timer);
      // Local changes outrank heartbeat-only changes in the same window.
      const merged: ChangeEvent['scope'] = existing.scope === 'local' || scope === 'local' ? 'local' : scope;
      const wait = Math.max(0, Math.min(this.debounceMs, existing.firstAt + this.maxWaitMs - now));
      this.pending.set(key, { timer: setTimeout(fire, wait), firstAt: existing.firstAt, scope: merged });
      return;
    }
    this.pending.set(key, { timer: setTimeout(fire, this.debounceMs), firstAt: now, scope });
  }

  private watch(dir: string, recursive: boolean, onChange: (filename: string) => void): void {
    if (this.watchers.has(dir) || this.closed) return;
    try {
      const watcher = fs.watch(dir, { recursive, persistent: false }, (_type, filename) => {
        onChange(filename ? filename.toString() : '');
      });
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(dir);
      });
      this.watchers.set(dir, watcher);
    } catch {
      // Directory vanished or watching is unsupported; the next rescan retries.
    }
  }

  private async rescan(): Promise<void> {
    if (this.closed) return;
    let sources: DashboardSources;
    try {
      sources = await this.options.getSources();
    } catch {
      return;
    }
    const wanted = new Set<string>();
    const controlMeta = path.join(sources.control_dir, '.symphony');
    if (fs.existsSync(controlMeta)) {
      wanted.add(controlMeta);
      this.watch(controlMeta, false, (filename) => {
        if (path.basename(filename) === 'heartbeat.json') this.schedule(null, 'heartbeat');
      });
    }
    for (const repo of sources.repos) {
      const root = repo.workspace_root;
      if (!root) continue;
      const repoMeta = path.join(root, '.symphony');
      if (fs.existsSync(repoMeta) && repoMeta !== controlMeta) {
        wanted.add(repoMeta);
        this.watch(repoMeta, true, (filename) => {
          const first = filename.split(path.sep)[0] ?? '';
          if (IGNORED_PREFIXES.some((prefix) => first.startsWith(prefix))) return;
          this.schedule(repo.repo_id, path.basename(filename) === 'heartbeat.json' ? 'heartbeat' : 'local');
        });
      }
      for (const slotMeta of await listSlotMetaDirs(root)) {
        wanted.add(slotMeta);
        this.watch(slotMeta, true, () => this.schedule(repo.repo_id, 'local'));
      }
    }
    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
  }
}

async function listSlotMetaDirs(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_archives' || entry.name.startsWith('.')) continue;
    if (entry.name === '_loops') {
      const loops = await fs.promises.readdir(path.join(root, '_loops'), { withFileTypes: true }).catch(() => []);
      for (const loop of loops) if (loop.isDirectory() && !loop.name.startsWith('.')) candidates.push(path.join(root, '_loops', loop.name, '.symphony'));
      continue;
    }
    if (/^_pool_\d+$/.test(entry.name) || !entry.name.startsWith('_')) candidates.push(path.join(root, entry.name, '.symphony'));
  }
  for (const candidate of candidates) if (fs.existsSync(candidate)) result.push(candidate);
  return result;
}

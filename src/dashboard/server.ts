import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { isIP } from 'node:net';
import { URL } from 'node:url';

import { loadBoardState, type LoadBoardStateOptions } from '../status/boardState.js';
import { DashboardNotFoundError, type ReadModelOptions } from '../status/dashboard/context.js';
import { DashboardGithubCache } from '../status/dashboard/githubCache.js';
import { loadEventsPage, loadHistoryState } from '../status/dashboard/historyState.js';
import { loadOverviewState } from '../status/dashboard/overviewState.js';
import { loadRepoState } from '../status/dashboard/repoState.js';
import { resolveDashboardSources, type DashboardSources } from '../status/dashboard/sources.js';
import { loadTaskDetail } from '../status/dashboard/taskState.js';
import { readAgentLog } from './agentLog.js';
import { ArtifactAccessError, readArtifactChunk, tailArtifact, type ArtifactAccess } from './artifacts.js';
import { locateUiDir, resolveUiPath, sendStaticFile } from './static.js';
import { DashboardChangeStream } from './stream.js';

export const DEFAULT_DASHBOARD_REFRESH_MS = 300_000;

export interface DashboardServerOptions {
  config?: string;
  workflow?: string;
  host: string;
  port: number;
  /** Refresh interval for the legacy `/api/board` consumers. */
  refreshMs: number;
  /** False keeps every route local-only (no GitHub calls). Defaults to true. */
  liveRefresh?: boolean;
  /** Override the static UI directory (tests). Defaults to `src/dashboard/ui` or `dist/ui`. */
  uiDir?: string;
  /** Override the GitHub cache (tests). */
  githubCache?: DashboardGithubCache;
  staleAfterMs?: number;
}

export interface StartedDashboardServer {
  server: Server;
  host: string;
  port: number;
  url: string;
}

export type DashboardRequestHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  /** Stops file watchers and ends open event streams. */
  close(): void;
  stream: DashboardChangeStream;
};

class BadRequestError extends Error {
  readonly status = 400;
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown, head = false): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(head ? undefined : body);
}

function intParam(url: URL, name: string, options: { min?: number; max?: number } = {}): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) throw new BadRequestError(`${name} must be an integer`);
  const value = Number(raw);
  if (options.min !== undefined && value < options.min) throw new BadRequestError(`${name} must be >= ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new BadRequestError(`${name} must be <= ${options.max}`);
  return value;
}

function pathParam(url: URL): string {
  const value = url.searchParams.get('path');
  if (!value) throw new BadRequestError('path is required');
  if (!path.isAbsolute(value)) throw new BadRequestError('path must be absolute');
  return value;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequestError('invalid path segment');
  }
}

function errorStatus(err: unknown): number {
  if (err instanceof DashboardNotFoundError || err instanceof BadRequestError) return err.status;
  if (err instanceof ArtifactAccessError) return err.status;
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status?: unknown }).status) : Number.NaN;
  return [400, 403, 404].includes(status) ? status : 500;
}

const UI_MISSING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Symphony Dashboard</title></head>
<body><main><h1>Symphony Dashboard</h1><p>The dashboard UI files were not found. Run <code>yarn build</code>, or start from a checkout that contains <code>src/dashboard/ui/</code>. The JSON API is available under <code>/api/</code>.</p></main></body></html>
`;

export function createDashboardRequestHandler(options: Omit<DashboardServerOptions, 'host' | 'port'>): DashboardRequestHandler {
  const liveRefresh = options.liveRefresh ?? true;
  const github = options.githubCache ?? new DashboardGithubCache({ enabled: liveRefresh });
  const getSources = (): Promise<DashboardSources> => resolveDashboardSources({ config: options.config, workflow: options.workflow });
  const stream = new DashboardChangeStream({ getSources, github });

  const readModelOptions = (url: URL): ReadModelOptions => ({
    github,
    forceGithub: url.searchParams.get('github') === '1',
    staleAfterMs: options.staleAfterMs,
  });

  const artifactAccess = (sources: DashboardSources): ArtifactAccess => ({ allowedRoots: sources.allowed_roots, symphonyArtifactsOnly: true });

  async function routeApi(url: URL): Promise<unknown> {
    const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeSegment);
    const [resource, ...rest] = segments;
    switch (resource) {
      case 'board':
        if (rest.length > 0) break;
        return loadBoardState({
          config: options.config,
          workflow: options.workflow,
          refreshMs: options.refreshMs,
          liveRefresh,
          githubCache: github,
        } satisfies LoadBoardStateOptions);
      case 'overview':
        if (rest.length > 0) break;
        return loadOverviewState(await getSources(), readModelOptions(url));
      case 'repos':
        if (rest.length !== 1) break;
        return loadRepoState(await getSources(), rest[0]!, readModelOptions(url));
      case 'tasks': {
        if (rest.length === 3 && rest[1] === 'loop') {
          return loadTaskDetail(await getSources(), rest[0]!, { loopId: rest[2]! }, readModelOptions(url));
        }
        if (rest.length !== 2) break;
        if (!/^\d+$/.test(rest[1]!)) throw new BadRequestError('issue number must be a positive integer');
        return loadTaskDetail(await getSources(), rest[0]!, Number(rest[1]), readModelOptions(url));
      }
      case 'history':
        if (rest.length > 0) break;
        return loadHistoryState(await getSources(), {
          days: intParam(url, 'days', { min: 1, max: 366 }),
          repo: url.searchParams.get('repo') || null,
        });
      case 'events':
        if (rest.length > 0) break;
        return loadEventsPage(await getSources(), {
          repo: url.searchParams.get('repo') || null,
          before: url.searchParams.get('before')?.startsWith('[')
            ? url.searchParams.get('before') : intParam(url, 'before', { min: 0 }) ?? null,
          limit: intParam(url, 'limit', { min: 1, max: 500 }),
          task: url.searchParams.get('task') || null,
        });
      case 'artifact': {
        if (rest.length > 0) break;
        const access = artifactAccess(await getSources());
        const filePath = pathParam(url);
        const tail = intParam(url, 'tail', { min: 1 });
        if (tail !== undefined) return tailArtifact(access, filePath, { bytes: tail });
        return readArtifactChunk(access, filePath, { offset: intParam(url, 'offset', { min: 0 }), limit: intParam(url, 'limit', { min: 1 }) });
      }
      case 'agent-log':
        if (rest.length > 0) break;
        return readAgentLog(artifactAccess(await getSources()), pathParam(url), {
          after: intParam(url, 'after', { min: 0 }),
          limit: intParam(url, 'limit', { min: 1 }),
        });
      default:
        break;
    }
    throw new DashboardNotFoundError('not found');
  }

  async function serveUi(res: ServerResponse, pathname: string, head: boolean): Promise<void> {
    const uiDir = options.uiDir ?? locateUiDir();
    if (pathname.startsWith('/ui/') || pathname === '/ui') {
      const file = uiDir ? resolveUiPath(uiDir, pathname.slice('/ui'.length)) : null;
      if (file && (await sendStaticFile(res, file, head))) return;
      writeJson(res, 404, { error: 'not found' }, head);
      return;
    }
    if (!uiDir) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(head ? undefined : UI_MISSING_HTML);
      return;
    }
    // Top-level files (e.g. /favicon.svg) are served when present; every other path is the app shell.
    if (pathname !== '/' && !pathname.slice(1).includes('/')) {
      const file = resolveUiPath(uiDir, pathname);
      if (file && path.basename(file) !== 'index.html' && (await sendStaticFile(res, file, head))) return;
    }
    if (await sendStaticFile(res, path.join(uiDir, 'index.html'), head)) return;
    writeJson(res, 404, { error: 'not found' }, head);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      writeJson(res, 405, { error: 'readonly dashboard only supports GET requests' });
      return;
    }
    const head = method === 'HEAD';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      writeJson(res, 400, { error: 'invalid url' }, head);
      return;
    }

    if (url.pathname === '/api/stream') {
      stream.handle(req, res, head);
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        const value = await routeApi(url);
        writeJson(res, 200, value, head);
      } catch (err) {
        const status = errorStatus(err);
        const message = err instanceof Error ? err.message : String(err);
        writeJson(res, status, { error: status === 500 ? `internal error: ${message}` : message }, head);
      }
      return;
    }
    try {
      await serveUi(res, url.pathname, head);
    } catch (err) {
      if (!res.headersSent) writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) }, head);
      else res.end();
    }
  };

  return Object.assign(handler, {
    close: () => stream.close(),
    stream,
  });
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<StartedDashboardServer> {
  const basePort = options.port;
  const attempts = basePort === 0 ? 1 : 25;
  let lastError: unknown = null;
  const handler = createDashboardRequestHandler(options);

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = basePort === 0 ? 0 : basePort + offset;
    const server = http.createServer((req, res) => {
      // Require a Host that belongs to this server so browser DNS rebinding cannot expose local data.
      const authority = req.headers.host ?? '';
      const match = /^(\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d+)?$/i.exec(authority);
      const hostname = match?.[1]?.toLowerCase();
      const configuredHost = isIP(options.host) === 6 ? `[${options.host}]` : options.host.toLowerCase();
      if (!hostname || !['localhost', '127.0.0.1', '[::1]', configuredHost].includes(hostname)) {
        writeJson(res, 403, { error: 'Invalid dashboard host' }, req.method === 'HEAD');
        return;
      }
      void handler(req, res);
    });
    try {
      const actualPort = await listen(server, options.host, port);
      // End event streams and stop watchers first; otherwise open SSE responses keep close() waiting.
      const close = server.close.bind(server);
      server.close = ((callback?: (err?: Error) => void) => {
        handler.close();
        return close(callback);
      }) as Server['close'];
      return {
        server,
        host: options.host,
        port: actualPort,
        url: `http://${isIP(options.host) === 6 ? `[${options.host}]` : options.host}:${actualPort}/`,
      };
    } catch (err) {
      lastError = err;
      server.close();
      const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : null;
      if (code !== 'EADDRINUSE' || basePort === 0) break;
    }
  }

  handler.close();
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

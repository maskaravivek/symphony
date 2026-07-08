import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { loadBoardState, type LoadBoardStateOptions } from '../status/boardState.js';

export interface DashboardServerOptions {
  config?: string;
  workflow?: string;
  host: string;
  port: number;
  refreshMs: number;
  liveRefresh?: boolean;
}

export interface StartedDashboardServer {
  server: Server;
  host: string;
  port: number;
  url: string;
}

function writeText(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  writeText(res, statusCode, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`);
}

function renderDashboardHtml(refreshMs: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-strong: #eef2f6;
      --text: #17202a;
      --muted: #687385;
      --border: #d8dee8;
      --accent: #0b6bcb;
      --good: #0f7b4f;
      --warn: #a86a00;
      --bad: #b42318;
      --review: #6f3cc3;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101418;
        --panel: #171d23;
        --panel-strong: #202833;
        --text: #e8edf3;
        --muted: #9ba7b6;
        --border: #2d3845;
        --accent: #63a8ff;
        --good: #59c898;
        --warn: #e5ad4f;
        --bad: #ff7b72;
        --review: #b69cff;
        --shadow: none;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      gap: 16px;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 94%, transparent);
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0;
      font-size: 17px;
      font-weight: 700;
    }
    .meta {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .source {
      max-width: min(60vw, 760px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--panel-strong);
      color: var(--text);
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .stale { color: var(--warn); }
    main {
      overflow-x: auto;
      padding: 12px 14px 18px;
    }
    .board {
      display: grid;
      grid-auto-columns: minmax(250px, 290px);
      grid-auto-flow: column;
      gap: 10px;
      align-items: start;
      min-height: calc(100vh - 86px);
    }
    .column {
      min-width: 0;
      background: color-mix(in srgb, var(--panel-strong) 72%, transparent);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .column-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 9px;
      border-bottom: 1px solid var(--border);
    }
    .column-title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
    }
    .count {
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .cards {
      display: grid;
      gap: 6px;
      padding: 8px;
    }
    .empty {
      color: var(--muted);
      font-size: 12px;
      padding: 10px 2px 12px;
    }
    .card {
      display: grid;
      gap: 6px;
      padding: 8px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .card.active { border-left: 4px solid var(--accent); }
    .card.needs-info { border-left: 4px solid var(--warn); }
    .card.blocked, .card.failed-cancelled { border-left: 4px solid var(--bad); }
    .card.review-blocked, .card.ready-for-review { border-left: 4px solid var(--review); }
    .card.waiting-human { border-left: 4px solid var(--good); }
    .card.queued { border-left: 4px solid var(--muted); }
    .card.closed { opacity: 0.72; }
    .card.epics { border-left: 4px solid var(--accent); }
      cursor: pointer;
    }
    .card:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .card-top {
      display: flex;
      gap: 8px;
      align-items: baseline;
      justify-content: space-between;
    }
    .issue {
      min-width: 0;
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .issue a {
      color: var(--text);
      text-decoration: none;
    }
    .issue a:hover { color: var(--accent); text-decoration: underline; }
    .repo {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .title {
      color: var(--text);
      font-size: 12px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .card-summary {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .fields {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .card:not(.expanded) .details { display: none; }
    .field {
      display: grid;
      grid-template-columns: 70px minmax(0, 1fr);
      gap: 6px;
      align-items: baseline;
    }
    .field span:last-child { overflow-wrap: anywhere; }
    .label-list {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .label {
      padding: 1px 5px;
      border-radius: 999px;
      background: var(--panel-strong);
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .path {
      width: 100%;
      min-height: 26px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel-strong);
      color: var(--muted);
      font: inherit;
      font-size: 11px;
      padding: 4px 6px;
    }
    .error {
      color: var(--bad);
      overflow-wrap: anywhere;
    }
    @media (max-width: 720px) {
      header { align-items: flex-start; flex-direction: column; }
      .source { max-width: 92vw; }
      main { padding: 10px; }
      .board { grid-auto-columns: minmax(240px, 86vw); }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Symphony Dashboard</h1>
      <div class="meta">
        <span id="source" class="source">Loading...</span>
      </div>
    </div>
    <div class="meta">
      <span class="pill"><span id="total">0</span>&nbsp;cards</span>
      <span id="stale" class="pill stale" hidden>0 stale</span>
      <span id="updated">Refreshing...</span>
    </div>
  </header>
  <main id="scroller">
    <section id="board" class="board" aria-live="polite"></section>
  </main>
  <script>
    const refreshMs = ${refreshMs};
    const boardEl = document.getElementById('board');
    const scroller = document.getElementById('scroller');
    const sourceEl = document.getElementById('source');
    const totalEl = document.getElementById('total');
    const staleEl = document.getElementById('stale');
    const updatedEl = document.getElementById('updated');

    function text(value) {
      return value === null || value === undefined || value === '' ? '-' : String(value);
    }

    function shortThread(value) {
      if (!value) return '-';
      return value.length > 12 ? value.slice(0, 12) + '...' : value;
    }

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return text(value);
      return date.toLocaleString();
    }

    function el(tag, className, content) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    }

    function field(label, value, className) {
      const row = el('div', 'field');
      row.append(el('span', '', label));
      row.append(el('span', className || '', text(value)));
      return row;
    }

    function pathField(label, value) {
      if (!value) return null;
      const row = el('div', 'field');
      row.append(el('span', '', label));
      const input = document.createElement('input');
      input.className = 'path';
      input.readOnly = true;
      input.value = value;
      row.append(input);
      return row;
    }

    function renderCard(card) {
      const node = el('article', 'card ' + card.column);
      const top = el('div', 'card-top');
      const issue = el('div', 'issue');
      const issueText = card.issue_number ? '#' + card.issue_number : card.issue_identifier;
      if (card.issue_url) {
        const link = document.createElement('a');
        link.href = card.issue_url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = issueText;
        issue.append(link);
      } else {
        issue.textContent = issueText;
      }
      top.append(issue, el('div', 'repo', card.repo_id || card.repo || '-'));
      node.append(top);
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-expanded', 'false');
      node.addEventListener('click', (event) => {
        if (event.target.closest('a,input')) return;
        node.classList.toggle('expanded');
        node.setAttribute('aria-expanded', node.classList.contains('expanded') ? 'true' : 'false');
      });
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        node.click();
      });

      node.append(el('div', 'title', card.title || card.issue_identifier));
      const summary = el('div', 'card-summary');
      summary.append(el('span', 'pill', card.status));
      if (card.agent_provider) summary.append(el('span', 'pill', card.agent_provider));
      if (card.pr_number) summary.append(el('span', 'pill', 'PR #' + card.pr_number));
      if (card.review_auto_fix_iteration !== null) summary.append(el('span', 'pill', 'auto-fix ' + card.review_auto_fix_iteration));
      if (card.epic_progress) summary.append(el('span', 'pill', card.epic_progress));
      if (card.stale) summary.append(el('span', 'pill stale', 'stale'));
      node.append(summary);

      const fields = el('div', 'fields details');
      fields.append(field('status', card.status));
      fields.append(field('flow', card.workflow_state || card.issue_state || '-'));
      if (card.agent_provider || card.agent_mode) fields.append(field('agent', [card.agent_provider, card.agent_mode].filter(Boolean).join(' / ')));
      if (card.attempt !== null) fields.append(field('attempt', card.attempt));
      if (card.thread_id) fields.append(field('thread', shortThread(card.thread_id)));
      if (card.pr_number) fields.append(field('pr', '#' + card.pr_number));
      if (card.epic_progress) fields.append(field('progress', card.epic_progress));
      if (card.review_auto_fix_iteration !== null) fields.append(field('auto-fix', card.review_auto_fix_iteration));
      if (card.sources_count > 1) fields.append(field('sources', card.sources_count));
      fields.append(field('updated', formatDate(card.updated_at), card.stale ? 'stale' : ''));
      if (card.last_error) fields.append(field('error', card.last_error, 'error'));
      const workspace = pathField('workspace', card.workspace_path);
      if (workspace) fields.append(workspace);
      const agentLog = pathField('log', card.artifacts && card.artifacts.agent_log);
      if (agentLog) fields.append(agentLog);
      const last = pathField('last', card.artifacts && card.artifacts.last_message);
      if (last) fields.append(last);
      node.append(fields);

      if (card.labels && card.labels.length > 0) {
        const labels = el('div', 'label-list details');
        for (const label of card.labels) labels.append(el('span', 'label', label));
        node.append(labels);
      }
      return node;
    }

    function renderBoard(board) {
      const scrollLeft = scroller.scrollLeft;
      sourceEl.textContent = board.source.kind + ': ' + board.source.path;
      totalEl.textContent = board.total_cards;
      staleEl.hidden = board.stale_cards === 0;
      staleEl.textContent = board.stale_cards + ' stale';
      updatedEl.textContent = 'Updated ' + formatDate(board.generated_at);
      boardEl.replaceChildren();
      for (const column of board.columns) {
        const section = el('section', 'column');
        const header = el('div', 'column-header');
        header.append(el('h2', 'column-title', column.title), el('span', 'count', column.cards.length));
        section.append(header);
        const cards = el('div', 'cards');
        if (column.cards.length === 0) {
          cards.append(el('div', 'empty', 'No cards'));
        } else {
          for (const card of column.cards) cards.append(renderCard(card));
        }
        section.append(cards);
        boardEl.append(section);
      }
      scroller.scrollLeft = scrollLeft;
    }

    async function refresh() {
      try {
        const response = await fetch('/api/board', { cache: 'no-store' });
        if (!response.ok) throw new Error(await response.text());
        renderBoard(await response.json());
      } catch (error) {
        updatedEl.textContent = 'Refresh failed';
        sourceEl.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    refresh();
    setInterval(refresh, refreshMs);
  </script>
</body>
</html>`;
}

export function createDashboardRequestHandler(options: Omit<DashboardServerOptions, 'host' | 'port'>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      writeJson(res, 405, { error: 'readonly dashboard only supports GET requests' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      const body = renderDashboardHtml(options.refreshMs);
      writeText(res, 200, 'text/html; charset=utf-8', method === 'HEAD' ? '' : body);
      return;
    }

    if (url.pathname === '/api/board') {
      try {
        const board = await loadBoardState({
          config: options.config,
          workflow: options.workflow,
          refreshMs: options.refreshMs,
          liveRefresh: options.liveRefresh ?? true,
        } satisfies LoadBoardStateOptions);
        writeJson(res, 200, method === 'HEAD' ? null : board);
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  };
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

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = basePort === 0 ? 0 : basePort + offset;
    const server = http.createServer((req, res) => {
      void createDashboardRequestHandler(options)(req, res);
    });
    try {
      const actualPort = await listen(server, options.host, port);
      return {
        server,
        host: options.host,
        port: actualPort,
        url: `http://${options.host}:${actualPort}/`,
      };
    } catch (err) {
      lastError = err;
      server.close();
      const code = typeof err === 'object' && err && 'code' in err ? (err as { code?: string }).code : null;
      if (code !== 'EADDRINUSE' || basePort === 0) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

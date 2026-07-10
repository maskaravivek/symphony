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
      color-scheme: light;
      --canvas: oklch(0.972 0.006 255);
      --surface: oklch(0.994 0.003 255);
      --surface-subtle: oklch(0.952 0.009 255);
      --surface-hover: oklch(0.976 0.012 255);
      --ink: oklch(0.245 0.025 258);
      --ink-soft: oklch(0.42 0.024 258);
      --muted: oklch(0.54 0.022 258);
      --faint: oklch(0.68 0.018 258);
      --line: oklch(0.885 0.014 255);
      --line-strong: oklch(0.81 0.02 255);
      --accent: oklch(0.53 0.16 255);
      --accent-soft: oklch(0.945 0.03 255);
      --good: oklch(0.49 0.11 155);
      --good-soft: oklch(0.95 0.025 155);
      --warn: oklch(0.56 0.11 72);
      --warn-soft: oklch(0.955 0.034 78);
      --bad: oklch(0.53 0.17 28);
      --bad-soft: oklch(0.955 0.032 28);
      --review: oklch(0.52 0.13 305);
      --review-soft: oklch(0.95 0.027 305);
      --neutral: oklch(0.56 0.025 258);
      --neutral-soft: oklch(0.945 0.009 258);
      --shadow: 0 1px 2px oklch(0.22 0.03 258 / 0.06), 0 5px 16px oklch(0.22 0.03 258 / 0.035);
      --focus: 0 0 0 3px oklch(0.53 0.16 255 / 0.2);
    }
    * { box-sizing: border-box; }
    html { background: var(--canvas); }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--canvas);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
      text-rendering: optimizeLegibility;
    }
    button, input, select { font: inherit; }
    button, a, input, select { -webkit-tap-highlight-color: transparent; }
    a { color: var(--accent); }
    .app-header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: grid;
      gap: 14px;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    .header-row {
      display: flex;
      gap: 24px;
      align-items: center;
      justify-content: space-between;
    }
    .brand-block {
      display: flex;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .brand-mark {
      display: grid;
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      place-items: center;
      border-radius: 8px;
      background: var(--ink);
      color: var(--surface);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .brand-copy { min-width: 0; }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 750;
      letter-spacing: -0.025em;
    }
    .meta {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .source {
      display: block;
      max-width: min(58vw, 720px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .header-status {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .metric {
      display: inline-flex;
      min-height: 28px;
      align-items: baseline;
      gap: 4px;
      padding: 4px 9px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-subtle);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .metric strong {
      color: var(--ink);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    .refresh-status {
      display: inline-flex;
      min-height: 28px;
      align-items: center;
      gap: 7px;
      padding: 4px 2px 4px 7px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--neutral);
      box-shadow: 0 0 0 3px var(--neutral-soft);
    }
    .refresh-status.ready .status-dot { background: var(--good); box-shadow: 0 0 0 3px var(--good-soft); }
    .refresh-status.refreshing .status-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .refresh-status.failed .status-dot { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 21px;
      padding: 2px 6px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface-subtle);
      color: var(--ink-soft);
      font-size: 11px;
      font-weight: 550;
      line-height: 1.3;
      white-space: nowrap;
    }
    .stale { color: var(--warn); }
    .filters {
      display: grid;
      grid-template-columns: minmax(210px, 1.6fr) repeat(4, minmax(120px, 0.7fr)) auto;
      gap: 8px;
      align-items: end;
    }
    .filter-group {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .filter-label {
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.055em;
      line-height: 1;
      text-transform: uppercase;
    }
    .filter-control {
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      background: var(--surface);
      color: var(--ink);
      font-size: 12px;
      padding: 5px 9px;
      outline: none;
      transition: border-color 160ms cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 160ms cubic-bezier(0.165, 0.84, 0.44, 1);
    }
    .filter-control::placeholder { color: var(--faint); }
    .filter-control:hover { border-color: var(--muted); }
    .filter-control:focus-visible { border-color: var(--accent); box-shadow: var(--focus); }
    .filter-actions {
      display: inline-flex;
      min-height: 34px;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .check-filter {
      display: inline-flex;
      min-height: 34px;
      gap: 7px;
      align-items: center;
      padding: 0 3px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .check-filter input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
    .quiet-button, .copy-button, .card-toggle {
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      background: var(--surface);
      color: var(--ink-soft);
      cursor: pointer;
      outline: none;
      transition: background 160ms cubic-bezier(0.165, 0.84, 0.44, 1), border-color 160ms cubic-bezier(0.165, 0.84, 0.44, 1), color 160ms cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 160ms cubic-bezier(0.165, 0.84, 0.44, 1);
    }
    .quiet-button { min-height: 34px; padding: 5px 10px; font-size: 12px; font-weight: 600; }
    .quiet-button:hover, .copy-button:hover, .card-toggle:hover { background: var(--surface-hover); border-color: var(--muted); color: var(--ink); }
    .quiet-button:focus-visible, .copy-button:focus-visible, .card-toggle:focus-visible, a:focus-visible { box-shadow: var(--focus); outline: none; }
    .refresh-error {
      padding: 8px 10px;
      border: 1px solid color-mix(in oklch, var(--bad) 25%, var(--line));
      border-radius: 7px;
      background: var(--bad-soft);
      color: var(--bad);
      font-size: 12px;
    }
    main {
      overflow-x: auto;
      padding: 16px 18px 24px;
    }
    .board {
      display: grid;
      grid-auto-columns: minmax(270px, 306px);
      grid-auto-flow: column;
      gap: 12px;
      align-items: start;
      min-height: calc(100vh - 132px);
    }
    .column {
      --state: var(--neutral);
      --state-soft: var(--neutral-soft);
      min-width: 0;
      overflow: hidden;
      background: color-mix(in oklch, var(--surface-subtle) 72%, var(--surface));
      border: 1px solid var(--line);
      border-radius: 10px;
    }
    .column[data-column="active"] { --state: var(--accent); --state-soft: var(--accent-soft); }
    .column[data-column="needs-info"] { --state: var(--warn); --state-soft: var(--warn-soft); }
    .column[data-column="blocked"], .column[data-column="failed-cancelled"] { --state: var(--bad); --state-soft: var(--bad-soft); }
    .column[data-column="review-blocked"], .column[data-column="ready-for-review"] { --state: var(--review); --state-soft: var(--review-soft); }
    .column[data-column="waiting-human"] { --state: var(--good); --state-soft: var(--good-soft); }
    .column-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 10px 11px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in oklch, var(--state-soft) 55%, var(--surface));
    }
    .column-heading {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .column-heading .status-dot {
      width: 7px;
      height: 7px;
      background: var(--state);
      box-shadow: none;
    }
    .column-title {
      margin: 0;
      overflow: hidden;
      color: var(--ink-soft);
      font-size: 12px;
      font-weight: 720;
      letter-spacing: -0.005em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .count {
      min-width: 21px;
      padding: 1px 6px;
      border: 1px solid color-mix(in oklch, var(--state) 16%, var(--line));
      border-radius: 999px;
      background: var(--surface);
      color: var(--ink-soft);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      text-align: center;
    }
    .cards {
      display: grid;
      gap: 8px;
      padding: 9px;
    }
    .empty-state, .loading-state {
      display: grid;
      width: min(460px, calc(100vw - 36px));
      align-content: start;
      gap: 7px;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .empty-state strong, .loading-state strong { font-size: 14px; }
    .empty-state span, .loading-state span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .loading-bars { display: grid; gap: 7px; margin-top: 3px; }
    .loading-bar { height: 8px; border-radius: 4px; background: var(--surface-subtle); }
    .loading-bar:nth-child(2) { width: 72%; }
    .empty-state .quiet-button { justify-self: start; margin-top: 3px; }
    .column-empty {
      padding: 13px 11px 16px;
      color: var(--faint);
      font-size: 11px;
    }
    .card {
      --state: var(--neutral);
      --state-soft: var(--neutral-soft);
      display: grid;
      gap: 8px;
      padding: 10px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 9px;
      box-shadow: var(--shadow);
      transition: border-color 160ms cubic-bezier(0.165, 0.84, 0.44, 1), box-shadow 160ms cubic-bezier(0.165, 0.84, 0.44, 1), background 160ms cubic-bezier(0.165, 0.84, 0.44, 1);
    }
    .card:hover { border-color: var(--line-strong); box-shadow: 0 2px 4px oklch(0.22 0.03 258 / 0.07), 0 8px 22px oklch(0.22 0.03 258 / 0.045); }
    .card.active { --state: var(--accent); --state-soft: var(--accent-soft); }
    .card.needs-info { --state: var(--warn); --state-soft: var(--warn-soft); background: color-mix(in oklch, var(--warn-soft) 28%, var(--surface)); }
    .card.blocked, .card.failed-cancelled { --state: var(--bad); --state-soft: var(--bad-soft); background: color-mix(in oklch, var(--bad-soft) 30%, var(--surface)); }
    .card.review-blocked, .card.ready-for-review { --state: var(--review); --state-soft: var(--review-soft); }
    .card.waiting-human { --state: var(--good); --state-soft: var(--good-soft); }
    .card.closed { opacity: 0.76; box-shadow: none; }
    .card-top {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .issue {
      min-width: 0;
      font-size: 12px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .issue a {
      color: var(--ink-soft);
      text-decoration: none;
    }
    .issue a:hover { color: var(--accent); text-decoration: underline; }
    .card-actions { display: inline-flex; gap: 6px; align-items: center; flex: 0 0 auto; }
    .repo {
      color: var(--muted);
      font-size: 10px;
      white-space: nowrap;
    }
    .card-toggle {
      display: grid;
      width: 26px;
      height: 26px;
      padding: 0;
      place-items: center;
    }
    .card-toggle svg { width: 13px; height: 13px; transition: transform 160ms cubic-bezier(0.165, 0.84, 0.44, 1); }
    .card.expanded .card-toggle svg { transform: rotate(180deg); }
    .title {
      color: var(--ink);
      font-size: 13px;
      font-weight: 590;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .card-summary {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
    }
    .error-preview {
      overflow: hidden;
      padding: 7px 8px;
      border: 1px solid color-mix(in oklch, var(--bad) 20%, var(--line));
      border-radius: 6px;
      background: var(--bad-soft);
      color: var(--bad);
      font-size: 11px;
      line-height: 1.4;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fields {
      display: grid;
      gap: 6px;
      padding-top: 9px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
    }
    .card-details { display: grid; gap: 8px; }
    .card:not(.expanded) .details { display: none; }
    .field {
      display: grid;
      grid-template-columns: 66px minmax(0, 1fr);
      gap: 8px;
      align-items: baseline;
    }
    .field > span:first-child {
      color: var(--faint);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.045em;
      text-transform: uppercase;
    }
    .field span:last-child { overflow-wrap: anywhere; }
    .field a { font-weight: 600; text-decoration: none; }
    .field a:hover { text-decoration: underline; }
    .label-list {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .label {
      padding: 2px 5px;
      border-radius: 5px;
      background: var(--surface-subtle);
      color: var(--muted);
      font-size: 10px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .pill-link { text-decoration: none; }
    .pill-link:hover { color: var(--accent); border-color: var(--accent); }
    .path-wrap { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; }
    .path {
      width: 100%;
      min-height: 28px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface-subtle);
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 9px;
      padding: 4px 7px;
    }
    .copy-button { min-width: 46px; padding: 3px 7px; font-size: 10px; font-weight: 650; }
    .error {
      color: var(--bad);
      overflow-wrap: anywhere;
    }
    @media (max-width: 960px) {
      .filters { grid-template-columns: minmax(220px, 1.4fr) repeat(2, minmax(120px, 0.7fr)); }
      .filter-actions { justify-content: flex-start; }
    }
    @media (max-width: 640px) {
      .app-header { position: static; padding: 12px; }
      .header-row { align-items: flex-start; flex-direction: column; }
      .header-status { justify-content: flex-start; }
      .filters { grid-template-columns: 1fr; }
      .source { max-width: calc(100vw - 64px); }
      main { padding: 12px; }
      .board { grid-auto-columns: minmax(260px, 88vw); min-height: calc(100vh - 220px); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="header-row">
      <div class="brand-block">
        <span class="brand-mark" aria-hidden="true">S</span>
        <div class="brand-copy">
          <h1>Symphony</h1>
          <div class="meta">
            <span id="source" class="source">Loading orchestration source...</span>
          </div>
        </div>
      </div>
      <div class="header-status">
        <span class="metric"><strong id="total">0</strong><span id="totalContext">tasks</span></span>
        <span id="stale" class="metric stale" hidden><strong>0</strong> stale</span>
        <span id="refreshStatus" class="refresh-status refreshing" role="status" aria-live="polite">
          <span class="status-dot" aria-hidden="true"></span>
          <span id="updated">Refreshing</span>
        </span>
      </div>
    </div>
    <form class="filters" aria-label="Dashboard filters" role="search" onsubmit="return false">
      <label class="filter-group">
        <span class="filter-label">Search</span>
        <input id="searchFilter" class="filter-control" type="search" placeholder="Issue, PR, title, or label" autocomplete="off">
      </label>
      <label class="filter-group">
        <span class="filter-label">Repository</span>
        <select id="repoFilter" class="filter-control"></select>
      </label>
      <label class="filter-group">
        <span class="filter-label">Status</span>
        <select id="columnFilter" class="filter-control"></select>
      </label>
      <label class="filter-group">
        <span class="filter-label">Label</span>
        <select id="labelFilter" class="filter-control"></select>
      </label>
      <label class="filter-group">
        <span class="filter-label">Agent</span>
        <select id="agentFilter" class="filter-control"></select>
      </label>
      <div class="filter-actions">
        <label class="check-filter"><input id="staleFilter" type="checkbox"> <span>Stale only</span></label>
        <button id="clearFilters" class="quiet-button" type="button">Clear filters</button>
      </div>
    </form>
    <div id="refreshError" class="refresh-error" role="alert" hidden></div>
  </header>
  <main id="scroller">
    <section id="board" class="board" aria-live="polite" aria-busy="true">
      <div class="loading-state">
        <strong>Loading orchestration state</strong>
        <span>Reading workspaces and refreshing GitHub metadata.</span>
        <div class="loading-bars" aria-hidden="true">
          <span class="loading-bar"></span>
          <span class="loading-bar"></span>
          <span class="loading-bar"></span>
        </div>
      </div>
    </section>
  </main>
  <script>
    const refreshMs = ${refreshMs};
    const boardEl = document.getElementById('board');
    const scroller = document.getElementById('scroller');
    const sourceEl = document.getElementById('source');
    const totalEl = document.getElementById('total');
    const totalContextEl = document.getElementById('totalContext');
    const staleEl = document.getElementById('stale');
    const updatedEl = document.getElementById('updated');
    const refreshStatusEl = document.getElementById('refreshStatus');
    const refreshErrorEl = document.getElementById('refreshError');
    const searchFilter = document.getElementById('searchFilter');
    const repoFilter = document.getElementById('repoFilter');
    const columnFilter = document.getElementById('columnFilter');
    const labelFilter = document.getElementById('labelFilter');
    const agentFilter = document.getElementById('agentFilter');
    const staleFilter = document.getElementById('staleFilter');
    const clearFilters = document.getElementById('clearFilters');
    let currentBoard = null;
    const expandedCards = new Set();

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

    function formatRelativeDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return text(value);
      const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
      if (seconds < 10) return 'Updated just now';
      if (seconds < 60) return 'Updated ' + seconds + 's ago';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return 'Updated ' + minutes + 'm ago';
      return 'Updated ' + formatDate(value);
    }

    function truncate(value, length) {
      const normalized = text(value).replace(/\s+/g, ' ').trim();
      return normalized.length > length ? normalized.slice(0, length - 1) + '…' : normalized;
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

    function linkField(label, textValue, href) {
      if (!href) return field(label, textValue);
      const row = el('div', 'field');
      row.append(el('span', '', label));
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = text(textValue);
      row.append(link);
      return row;
    }

    function pathField(label, value) {
      if (!value) return null;
      const row = el('div', 'field');
      row.append(el('span', '', label));
      const wrap = el('div', 'path-wrap');
      const input = document.createElement('input');
      input.className = 'path';
      input.readOnly = true;
      input.value = value;
      input.setAttribute('aria-label', label + ' path');
      const copy = el('button', 'copy-button', 'Copy');
      copy.type = 'button';
      copy.setAttribute('aria-label', 'Copy ' + label + ' path');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          input.select();
          document.execCommand('copy');
          input.setSelectionRange(0, 0);
        }
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      wrap.append(input, copy);
      row.append(wrap);
      return row;
    }

    function renderCard(card) {
      const node = el('article', 'card ' + card.column);
      node.dataset.status = card.column;
      const detailsId = 'details-' + card.id.replace(/[^a-zA-Z0-9_-]/g, '-');
      const expanded = expandedCards.has(card.id);
      if (expanded) node.classList.add('expanded');

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
      const actions = el('div', 'card-actions');
      actions.append(el('div', 'repo', card.repo_id || card.repo || '-'));
      const toggle = el('button', 'card-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('aria-controls', detailsId);
      toggle.setAttribute('aria-label', (expanded ? 'Collapse' : 'Expand') + ' details for ' + issueText);
      toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      toggle.addEventListener('click', () => {
        const isExpanded = node.classList.toggle('expanded');
        if (isExpanded) expandedCards.add(card.id);
        else expandedCards.delete(card.id);
        toggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        toggle.setAttribute('aria-label', (isExpanded ? 'Collapse' : 'Expand') + ' details for ' + issueText);
      });
      actions.append(toggle);
      top.append(issue, actions);
      node.append(top);

      node.append(el('div', 'title', card.title || card.issue_identifier));
      const summary = el('div', 'card-summary');
      for (const label of (card.feature_labels || []).slice(0, 3)) summary.append(el('span', 'pill', label));
      if (card.pr_number && card.pr_url) {
        const prLink = document.createElement('a');
        prLink.href = card.pr_url;
        prLink.target = '_blank';
        prLink.rel = 'noreferrer';
        prLink.className = 'pill pill-link';
        prLink.textContent = 'PR #' + card.pr_number;
        summary.append(prLink);
      } else if (card.pr_number) {
        summary.append(el('span', 'pill', 'PR #' + card.pr_number));
      }
      if (card.review_auto_fix_iteration !== null) summary.append(el('span', 'pill', 'auto-fix ' + card.review_auto_fix_iteration));
      if (card.epic_progress) summary.append(el('span', 'pill', card.epic_progress));
      if (card.stale) summary.append(el('span', 'pill stale', 'stale'));
      node.append(summary);

      if (card.last_error) node.append(el('div', 'error-preview', truncate(card.last_error, 110)));

      const details = el('div', 'details card-details');
      details.id = detailsId;
      const fields = el('div', 'fields');
      fields.append(field('status', card.status));
      fields.append(field('flow', card.workflow_state || card.issue_state || '-'));
      if (card.agent_provider || card.agent_mode) fields.append(field('agent', [card.agent_provider, card.agent_mode].filter(Boolean).join(' / ')));
      if (card.attempt !== null) fields.append(field('attempt', card.attempt));
      if (card.thread_id) fields.append(field('thread', shortThread(card.thread_id)));
      if (card.pr_number) fields.append(linkField('pr', '#' + card.pr_number, card.pr_url));
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
      details.append(fields);

      if (card.labels && card.labels.length > 0) {
        const labels = el('div', 'label-list');
        labels.setAttribute('aria-label', 'Task labels');
        for (const label of card.labels) labels.append(el('span', 'label', label));
        details.append(labels);
      }
      node.append(details);
      return node;
    }

    function uniqueSorted(values) {
      return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    }

    function setSelectOptions(select, values, allLabel, labelForValue) {
      const previous = select.value;
      select.replaceChildren();
      const all = document.createElement('option');
      all.value = '';
      all.textContent = allLabel;
      select.append(all);
      for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = labelForValue ? labelForValue(value) : value;
        select.append(option);
      }
      select.value = values.includes(previous) ? previous : '';
    }

    function allCards(board) {
      return board.columns.flatMap((column) => column.cards);
    }

    function syncFilters(board) {
      const cards = allCards(board);
      const columnTitles = new Map(board.columns.map((column) => [column.id, column.title]));
      setSelectOptions(repoFilter, uniqueSorted(cards.map((card) => card.repo_id || card.repo)), 'All repos');
      setSelectOptions(
        columnFilter,
        board.columns.filter((column) => column.cards.length > 0).map((column) => column.id),
        'All statuses',
        (value) => columnTitles.get(value) || value,
      );
      setSelectOptions(labelFilter, uniqueSorted(cards.flatMap((card) => card.labels || [])), 'All labels');
      setSelectOptions(agentFilter, uniqueSorted(cards.map((card) => card.agent_provider)), 'All agents');
    }

    function cardMatches(card) {
      const query = searchFilter.value.trim().toLowerCase();
      const repo = repoFilter.value;
      const column = columnFilter.value;
      const label = labelFilter.value;
      const agent = agentFilter.value;
      if (repo && (card.repo_id || card.repo) !== repo) return false;
      if (column && card.column !== column) return false;
      if (label && !(card.labels || []).includes(label)) return false;
      if (agent && card.agent_provider !== agent) return false;
      if (staleFilter.checked && !card.stale) return false;
      if (!query) return true;
      const haystack = [
        card.title,
        card.issue_identifier,
        card.issue_number ? '#' + card.issue_number : '',
        card.pr_number ? 'pr #' + card.pr_number : '',
        card.repo_id,
        card.repo,
        ...(card.labels || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    }

    function filtersActive() {
      return Boolean(
        searchFilter.value.trim() ||
        repoFilter.value ||
        columnFilter.value ||
        labelFilter.value ||
        agentFilter.value ||
        staleFilter.checked
      );
    }

    function resetFilters() {
      searchFilter.value = '';
      repoFilter.value = '';
      columnFilter.value = '';
      labelFilter.value = '';
      agentFilter.value = '';
      staleFilter.checked = false;
      if (currentBoard) renderBoard(currentBoard);
      searchFilter.focus();
    }

    function renderBoard(board) {
      const scrollLeft = scroller.scrollLeft;
      const sourceText = board.source.kind + ': ' + board.source.path;
      sourceEl.textContent = sourceText;
      sourceEl.title = sourceText;
      const visibleTotal = allCards(board).filter(cardMatches).length;
      totalEl.textContent = visibleTotal;
      totalContextEl.textContent = visibleTotal === board.total_cards
        ? (visibleTotal === 1 ? 'task' : 'tasks')
        : 'of ' + board.total_cards + ' tasks';
      staleEl.hidden = board.stale_cards === 0;
      staleEl.replaceChildren(el('strong', '', board.stale_cards), document.createTextNode(' stale'));
      updatedEl.textContent = formatRelativeDate(board.generated_at);
      boardEl.replaceChildren();
      for (const column of board.columns) {
        const visibleCards = column.cards.filter(cardMatches);
        if (visibleCards.length === 0) continue;
        const section = el('section', 'column');
        section.dataset.column = column.id;
        const header = el('div', 'column-header');
        const heading = el('div', 'column-heading');
        const dot = el('span', 'status-dot');
        dot.setAttribute('aria-hidden', 'true');
        heading.append(dot, el('h2', 'column-title', column.title));
        header.append(heading, el('span', 'count', visibleCards.length));
        section.append(header);
        const cards = el('div', 'cards');
        for (const card of visibleCards) cards.append(renderCard(card));
        section.append(cards);
        boardEl.append(section);
      }
      if (boardEl.childElementCount === 0) {
        const empty = el('div', 'empty-state');
        empty.append(
          el('strong', '', board.total_cards === 0 ? 'No orchestration activity yet' : 'No tasks match these filters'),
          el('span', '', board.total_cards === 0
            ? 'Runs will appear here after Symphony claims its first issue.'
            : 'Adjust the filters or clear them to return to the full board.'),
        );
        if (board.total_cards > 0 && filtersActive()) {
          const reset = el('button', 'quiet-button', 'Clear filters');
          reset.type = 'button';
          reset.addEventListener('click', resetFilters);
          empty.append(reset);
        }
        boardEl.append(empty);
      }
      boardEl.setAttribute('aria-busy', 'false');
      scroller.scrollLeft = scrollLeft;
    }

    async function refresh() {
      refreshStatusEl.className = 'refresh-status refreshing';
      if (!currentBoard) updatedEl.textContent = 'Loading';
      refreshErrorEl.hidden = true;
      boardEl.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch('/api/board', { cache: 'no-store' });
        if (!response.ok) throw new Error(await response.text());
        currentBoard = await response.json();
        syncFilters(currentBoard);
        renderBoard(currentBoard);
        refreshStatusEl.className = 'refresh-status ready';
      } catch (error) {
        refreshStatusEl.className = 'refresh-status failed';
        updatedEl.textContent = 'Refresh failed';
        refreshErrorEl.textContent = error instanceof Error ? error.message : String(error);
        refreshErrorEl.hidden = false;
        boardEl.setAttribute('aria-busy', 'false');
      }
    }

    for (const control of [searchFilter, repoFilter, columnFilter, labelFilter, agentFilter, staleFilter]) {
      control.addEventListener('input', () => {
        if (currentBoard) renderBoard(currentBoard);
      });
    }
    clearFilters.addEventListener('click', resetFilters);
    searchFilter.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && searchFilter.value) {
        searchFilter.value = '';
        if (currentBoard) renderBoard(currentBoard);
      }
    });

    refresh();
    setInterval(refresh, refreshMs);
    setInterval(() => {
      if (currentBoard && refreshStatusEl.classList.contains('ready')) {
        updatedEl.textContent = formatRelativeDate(currentBoard.generated_at);
      }
    }, 30000);
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

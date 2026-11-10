/**
 * Turns raw agent logs into readable items for the dashboard.
 *
 * Supported formats:
 *  - `codex-jsonl`: `codex exec --json` events (thread/turn/item lines).
 *  - `claude-jsonl`: Claude Code `--output-format stream-json` lines
 *    (system/assistant/user/result with `message.content` blocks).
 *  - `plain`: anything else, one item per non-empty line. Claude as configured in
 *    WORKFLOW.example.md (`claude -p | tee ...`) writes plain text.
 */

import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import type { AgentLogItem, AgentLogPage, TokenUsage } from '../status/dashboardTypes.js';
import {
  ArtifactAccessError,
  completeUtf8End,
  readBytes,
  resolveArtifactFile,
  tailArtifact,
  type ArtifactAccess,
  type ResolvedArtifact,
} from './artifacts.js';

export type AgentLogFormat = AgentLogPage['provider_format'];

export const DEFAULT_AGENT_LOG_BYTES = 256 * 1024;
export const MAX_AGENT_LOG_BYTES = 2 * 1024 * 1024;
const ACTIVITY_TAIL_BYTES = 64 * 1024;
const DETECT_SAMPLE_BYTES = 64 * 1024;
const MAX_USAGE_SCAN_BYTES = 64 * 1024 * 1024;
const TITLE_CHARS = 200;
const COMMAND_TITLE_CHARS = 160;
const OUTPUT_BODY_CHARS = 4 * 1024;
const MESSAGE_BODY_CHARS = 64 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function capBody(text: string | null, max: number): string | null {
  if (text === null) return null;
  if (text.length <= max) return text;
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${text.slice(0, head)}\n… (${text.length - max} characters omitted) …\n${text.slice(text.length - tail)}`;
}

function timestampOf(obj: JsonObject): string | null {
  for (const key of ['timestamp', 'ts', 'created_at', 'time']) {
    const value = obj[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

const PLAIN_TIMESTAMP = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/;

function emptyUsage(): TokenUsage {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, turns: 0 };
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.input_tokens += usage.input_tokens;
  target.cached_input_tokens += usage.cached_input_tokens;
  target.output_tokens += usage.output_tokens;
  target.turns += usage.turns;
}

function codexUsage(raw: unknown): TokenUsage {
  const usage = isObject(raw) ? raw : {};
  return {
    input_tokens: num(usage.input_tokens) ?? 0,
    cached_input_tokens: num(usage.cached_input_tokens) ?? 0,
    output_tokens: num(usage.output_tokens) ?? 0,
    turns: 1,
  };
}

function claudeUsage(obj: JsonObject): TokenUsage | null {
  if (!isObject(obj.usage)) return null;
  const usage = obj.usage;
  return {
    input_tokens: num(usage.input_tokens) ?? 0,
    cached_input_tokens: num(usage.cache_read_input_tokens) ?? 0,
    output_tokens: num(usage.output_tokens) ?? 0,
    turns: num(obj.num_turns) ?? 1,
  };
}

function formatTokens(usage: TokenUsage): string {
  return `${usage.input_tokens} in (${usage.cached_input_tokens} cached) / ${usage.output_tokens} out`;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const CODEX_TYPE = /^(thread\.|turn\.|item\.)/;
const CLAUDE_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_event']);

export function detectAgentLogFormat(filePath: string, sample: string): AgentLogFormat {
  const isJsonl = path.extname(filePath).toLowerCase() === '.jsonl';
  let inspected = 0;
  for (const line of sample.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (inspected >= 5) break;
    inspected += 1;
    const parsed = parseJsonLine(line);
    if (!isObject(parsed) || typeof parsed.type !== 'string') continue;
    if (isJsonl && CODEX_TYPE.test(parsed.type)) return 'codex-jsonl';
    if (CLAUDE_TYPES.has(parsed.type)) {
      const message = parsed.message;
      if (parsed.type === 'system' || parsed.type === 'result' || parsed.type === 'stream_event') return 'claude-jsonl';
      if (isObject(message) && (Array.isArray(message.content) || typeof message.content === 'string')) {
        return 'claude-jsonl';
      }
    }
  }
  return 'plain';
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class ChunkParser {
  readonly items: AgentLogItem[] = [];
  usage: TokenUsage | null = null;
  private nextIndex: number;
  private readonly byItemId = new Map<string, AgentLogItem>();

  constructor(startIndex: number) {
    this.nextIndex = startIndex;
  }

  push(item: Omit<AgentLogItem, 'index'>): AgentLogItem {
    const full: AgentLogItem = { index: this.nextIndex, ...item };
    this.nextIndex += 1;
    this.items.push(full);
    return full;
  }

  addUsage(usage: TokenUsage): void {
    this.usage ??= emptyUsage();
    addUsage(this.usage, usage);
  }

  raw(line: string, at: string | null = null): void {
    const text = stripAnsi(line).trim();
    if (text === '') return;
    this.push({ at, kind: 'raw', title: oneLine(text, TITLE_CHARS), body: text.length > TITLE_CHARS ? capBody(text, OUTPUT_BODY_CHARS) : null, status: null, exit_code: null });
  }

  remember(id: string | null, item: AgentLogItem): void {
    if (id) this.byItemId.set(id, item);
  }

  find(id: string | null): AgentLogItem | undefined {
    return id ? this.byItemId.get(id) : undefined;
  }
}

function codexItemStatus(event: string, item: JsonObject, exitCode: number | null): AgentLogItem['status'] {
  const status = str(item.status);
  if (status === 'failed' || status === 'declined' || status === 'error') return 'failed';
  if (exitCode !== null && exitCode !== 0) return 'failed';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'completed') return 'completed';
  return event === 'item.completed' ? 'completed' : 'in_progress';
}

function codexItemFields(event: string, item: JsonObject): Omit<AgentLogItem, 'index' | 'at'> {
  const type = str(item.type) ?? 'item';
  const exitCode = num(item.exit_code);
  const status = codexItemStatus(event, item, exitCode);
  const text = str(item.text);
  switch (type) {
    case 'agent_message': {
      const body = text ?? '';
      return { kind: 'message', title: oneLine(body, TITLE_CHARS) || 'Agent message', body: capBody(body, MESSAGE_BODY_CHARS), status, exit_code: null };
    }
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.map((part) => (isObject(part) ? str(part.text) ?? '' : String(part))).join('\n') : str(item.summary);
      const body = text ?? summary ?? '';
      return { kind: 'reasoning', title: oneLine(body, TITLE_CHARS) || 'Reasoning', body: capBody(body, MESSAGE_BODY_CHARS), status, exit_code: null };
    }
    case 'command_execution': {
      const command = str(item.command) ?? '';
      const output = str(item.aggregated_output);
      return { kind: 'command', title: oneLine(command, COMMAND_TITLE_CHARS) || 'Command', body: output ? capBody(output, OUTPUT_BODY_CHARS) : null, status, exit_code: exitCode };
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      const files = changes.map((change) => `${str(change.kind) ?? 'update'} ${str(change.path) ?? '?'}`);
      return { kind: 'tool', title: oneLine(`Edit files: ${files.map((f) => f.split(' ').slice(1).join(' ')).join(', ') || 'unknown'}`, TITLE_CHARS), body: files.length ? files.join('\n') : null, status, exit_code: null };
    }
    case 'web_search':
      return { kind: 'tool', title: oneLine(`Web search: ${str(item.query) ?? ''}`, TITLE_CHARS), body: null, status, exit_code: null };
    case 'todo_list': {
      const todos = Array.isArray(item.items) ? item.items.filter(isObject) : [];
      const body = todos.map((todo) => `${todo.completed === true ? '[x]' : '[ ]'} ${str(todo.text) ?? ''}`).join('\n');
      return { kind: 'raw', title: 'Plan', body: body || null, status, exit_code: null };
    }
    case 'error': {
      const message = str(item.message) ?? text ?? 'Error';
      return { kind: 'error', title: oneLine(message, TITLE_CHARS), body: message.length > TITLE_CHARS ? capBody(message, OUTPUT_BODY_CHARS) : null, status: 'failed', exit_code: null };
    }
    default: {
      const tool = str(item.tool) ?? str(item.name);
      if (type === 'mcp_tool_call' || type === 'tool_call' || tool) {
        const server = str(item.server);
        const name = [server, tool].filter(Boolean).join('.') || type;
        const args = item.arguments ?? item.input;
        const errorText = isObject(item.error) ? str(item.error.message) : str(item.error);
        const result = item.result === undefined || item.result === null ? null : typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
        const title = oneLine(args === undefined ? name : `${name} ${typeof args === 'string' ? args : JSON.stringify(args)}`, TITLE_CHARS);
        return { kind: 'tool', title, body: capBody(errorText ?? result, OUTPUT_BODY_CHARS), status: errorText ? 'failed' : status, exit_code: null };
      }
      return { kind: 'raw', title: type, body: text ? capBody(text, OUTPUT_BODY_CHARS) : null, status, exit_code: exitCode };
    }
  }
}

function parseCodexLine(parser: ChunkParser, line: string): void {
  const parsed = parseJsonLine(line);
  if (!isObject(parsed) || typeof parsed.type !== 'string') {
    parser.raw(line);
    return;
  }
  const at = timestampOf(parsed);
  const type = parsed.type;
  switch (type) {
    case 'thread.started': {
      const threadId = str(parsed.thread_id);
      parser.push({ at, kind: 'thread', title: 'Thread started', body: threadId, status: null, exit_code: null });
      return;
    }
    case 'turn.started':
      parser.push({ at, kind: 'turn', title: 'Turn started', body: null, status: 'in_progress', exit_code: null });
      return;
    case 'turn.completed': {
      const usage = codexUsage(parsed.usage);
      parser.addUsage(usage);
      parser.push({ at, kind: 'turn', title: `Turn completed · ${formatTokens(usage)}`, body: null, status: 'completed', exit_code: null });
      return;
    }
    case 'turn.failed': {
      const message = (isObject(parsed.error) ? str(parsed.error.message) : str(parsed.error)) ?? 'Turn failed';
      parser.push({ at, kind: 'error', title: oneLine(`Turn failed: ${message}`, TITLE_CHARS), body: capBody(message, OUTPUT_BODY_CHARS), status: 'failed', exit_code: null });
      return;
    }
    case 'error': {
      const message = str(parsed.message) ?? 'Error';
      parser.push({ at, kind: 'error', title: oneLine(message, TITLE_CHARS), body: message.length > TITLE_CHARS ? capBody(message, OUTPUT_BODY_CHARS) : null, status: 'failed', exit_code: null });
      return;
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      if (!isObject(parsed.item)) {
        parser.push({ at, kind: 'raw', title: type, body: null, status: null, exit_code: null });
        return;
      }
      const id = str(parsed.item.id);
      const fields = codexItemFields(type, parsed.item);
      const existing = parser.find(id);
      if (existing) {
        existing.title = fields.title || existing.title;
        existing.body = fields.body ?? existing.body;
        existing.status = fields.status;
        existing.exit_code = fields.exit_code ?? existing.exit_code;
        existing.kind = fields.kind;
        return;
      }
      parser.remember(id, parser.push({ at, ...fields }));
      return;
    }
    default:
      parser.push({ at, kind: 'raw', title: oneLine(type, TITLE_CHARS), body: null, status: null, exit_code: null });
  }
}

function summarizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  if (isObject(input)) {
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
      const value = str(input[key]);
      if (value) return value;
    }
  }
  return JSON.stringify(input);
}

function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => (isObject(part) ? str(part.text) ?? (part.type === 'image' ? '[image]' : '') : String(part)));
    return parts.join('\n');
  }
  if (content === undefined || content === null) return null;
  return JSON.stringify(content);
}

function parseClaudeLine(parser: ChunkParser, line: string): void {
  const parsed = parseJsonLine(line);
  if (!isObject(parsed) || typeof parsed.type !== 'string') {
    parser.raw(line);
    return;
  }
  const at = timestampOf(parsed);
  const message = isObject(parsed.message) ? parsed.message : null;
  switch (parsed.type) {
    case 'system': {
      const subtype = str(parsed.subtype);
      if (subtype === 'init') {
        const model = str(parsed.model);
        parser.push({ at, kind: 'thread', title: model ? `Session started (${model})` : 'Session started', body: str(parsed.session_id), status: null, exit_code: null });
      } else {
        parser.push({ at, kind: 'raw', title: oneLine(`system${subtype ? `: ${subtype}` : ''}`, TITLE_CHARS), body: null, status: null, exit_code: null });
      }
      return;
    }
    case 'assistant': {
      const content = message?.content;
      if (typeof content === 'string') {
        if (content.trim()) parser.push({ at, kind: 'message', title: oneLine(content, TITLE_CHARS), body: capBody(content, MESSAGE_BODY_CHARS), status: null, exit_code: null });
        return;
      }
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === 'text') {
          const text = str(block.text) ?? '';
          if (!text.trim()) continue;
          parser.push({ at, kind: 'message', title: oneLine(text, TITLE_CHARS), body: capBody(text, MESSAGE_BODY_CHARS), status: null, exit_code: null });
        } else if (block.type === 'thinking') {
          const text = str(block.thinking) ?? '';
          if (!text.trim()) continue;
          parser.push({ at, kind: 'reasoning', title: oneLine(text, TITLE_CHARS), body: capBody(text, MESSAGE_BODY_CHARS), status: null, exit_code: null });
        } else if (block.type === 'tool_use') {
          const name = str(block.name) ?? 'tool';
          const summary = oneLine(summarizeToolInput(block.input), 140);
          const item = parser.push({ at, kind: 'tool', title: summary ? `${name}: ${summary}` : name, body: null, status: 'in_progress', exit_code: null });
          parser.remember(str(block.id), item);
        }
      }
      return;
    }
    case 'user': {
      const content = message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue;
        const text = toolResultText(block.content);
        const failed = block.is_error === true;
        const tool = parser.find(str(block.tool_use_id));
        if (tool) {
          tool.status = failed ? 'failed' : 'completed';
          tool.body = capBody(text, OUTPUT_BODY_CHARS);
        } else {
          parser.push({ at, kind: 'raw', title: oneLine(`Tool result${text ? `: ${text}` : ''}`, TITLE_CHARS), body: capBody(text, OUTPUT_BODY_CHARS), status: failed ? 'failed' : 'completed', exit_code: null });
        }
      }
      return;
    }
    case 'result': {
      const usage = claudeUsage(parsed);
      if (usage) parser.addUsage(usage);
      const failed = parsed.is_error === true || (str(parsed.subtype) ?? 'success') !== 'success';
      const result = str(parsed.result);
      const label = failed ? `Run failed${str(parsed.subtype) ? ` (${str(parsed.subtype)})` : ''}` : 'Run completed';
      parser.push({ at, kind: 'turn', title: usage ? `${label} · ${formatTokens(usage)}` : label, body: capBody(result, MESSAGE_BODY_CHARS), status: failed ? 'failed' : 'completed', exit_code: null });
      return;
    }
    case 'stream_event':
      // Partial deltas (--include-partial-messages); the full assistant message follows.
      return;
    default:
      parser.push({ at, kind: 'raw', title: oneLine(parsed.type, TITLE_CHARS), body: null, status: null, exit_code: null });
  }
}

function parsePlainLine(parser: ChunkParser, line: string): void {
  let text = stripAnsi(line).replace(/\s+$/, '');
  if (text.trim() === '') return;
  let at: string | null = null;
  const match = PLAIN_TIMESTAMP.exec(text);
  if (match) {
    const date = new Date(match[1]!);
    if (!Number.isNaN(date.getTime())) {
      at = date.toISOString();
      text = text.slice(match[0].length) || text;
    }
  }
  const trimmed = text.trim();
  parser.push({
    at,
    kind: 'message',
    title: trimmed.length > TITLE_CHARS ? `${trimmed.slice(0, TITLE_CHARS - 1)}…` : trimmed,
    body: trimmed.length > TITLE_CHARS ? capBody(trimmed, OUTPUT_BODY_CHARS) : null,
    status: null,
    exit_code: null,
  });
}

export function parseAgentLogChunk(
  text: string,
  format: AgentLogFormat,
  startIndex: number,
): { items: AgentLogItem[]; usage: TokenUsage | null } {
  const parser = new ChunkParser(startIndex);
  const parseLine = format === 'codex-jsonl' ? parseCodexLine : format === 'claude-jsonl' ? parseClaudeLine : parsePlainLine;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    parseLine(parser, line);
  }
  return { items: parser.items, usage: parser.usage };
}

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------

async function detectFromFile(resolved: ResolvedArtifact): Promise<AgentLogFormat> {
  const sample = await readBytes(resolved.realPath, 0, Math.min(DETECT_SAMPLE_BYTES, resolved.stat.size));
  return detectAgentLogFormat(resolved.requestedPath, sample.subarray(0, completeUtf8End(sample, sample.length)).toString('utf8'));
}

function parseIntegerOption(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    throw new ArtifactAccessError(400, `${name} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * Reads complete lines starting at byte offset `after` (default 0) up to `limit`
 * bytes (default 256 KiB, max 2 MiB). A trailing partial line is left for the
 * next call; `next_offset` is the end of the last complete line consumed.
 * Item indexes start at `after`, so they increase and never collide across pages
 * (each item consumes at least one line of two or more bytes) but are not contiguous.
 * `usage` covers this page only.
 */
export async function readAgentLog(
  access: ArtifactAccess,
  filePath: string,
  options: { after?: number; limit?: number },
): Promise<AgentLogPage> {
  const after = parseIntegerOption(options.after, 'after') ?? 0;
  const requestedLimit = parseIntegerOption(options.limit, 'limit');
  if (requestedLimit === 0) throw new ArtifactAccessError(400, 'limit must be greater than zero');
  const limit = Math.min(requestedLimit ?? DEFAULT_AGENT_LOG_BYTES, MAX_AGENT_LOG_BYTES);
  const resolved = await resolveArtifactFile(access, filePath);
  const size = resolved.stat.size;

  if (after >= size) {
    const format = size > 0 ? await detectFromFile(resolved) : detectAgentLogFormat(resolved.requestedPath, '');
    // after > size means the file was truncated or replaced; resume from its current end.
    return { path: resolved.requestedPath, provider_format: format, items: [], next_offset: Math.min(after, size), size, usage: null };
  }

  const buf = await readBytes(resolved.realPath, after, Math.min(limit, size - after));
  let consumed = buf.lastIndexOf(0x0a) + 1;
  if (consumed === 0 && buf.length >= limit) {
    // A single line longer than the limit: consume it in pieces rather than stalling.
    consumed = completeUtf8End(buf, buf.length) || buf.length;
  }
  const text = buf.subarray(0, consumed).toString('utf8');
  const format = after === 0 ? detectAgentLogFormat(resolved.requestedPath, text || buf.toString('utf8')) : await detectFromFile(resolved);
  const { items, usage } = parseAgentLogChunk(text, format, after);
  return { path: resolved.requestedPath, provider_format: format, items, next_offset: after + consumed, size, usage };
}

function isMissing(error: unknown): boolean {
  return error instanceof ArtifactAccessError && error.status === 404;
}

/** Last message/command/tool from the final 64 KiB of the log, or null. Missing files yield null. */
export async function lastAgentActivity(
  access: ArtifactAccess,
  filePath: string,
): Promise<{ text: string; at: string | null } | null> {
  let resolved: ResolvedArtifact;
  try {
    resolved = await resolveArtifactFile(access, filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const chunk = await tailArtifact(access, filePath, { bytes: ACTIVITY_TAIL_BYTES });
  let text = chunk.content;
  if (chunk.offset > 0) {
    // The first line is probably partial.
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  const format = await detectFromFile(resolved);
  const { items } = parseAgentLogChunk(text, format, 0);
  const preferred = new Set<AgentLogItem['kind']>(['message', 'command', 'tool']);
  const item = [...items].reverse().find((candidate) => preferred.has(candidate.kind))
    ?? [...items].reverse().find((candidate) => candidate.kind !== 'turn' && candidate.kind !== 'thread');
  if (!item) return null;
  const summary = oneLine(item.title, TITLE_CHARS);
  if (!summary) return null;
  return { text: summary, at: item.at ?? chunk.mtime };
}

/**
 * Total token usage for a log: codex sums every `turn.completed`; claude uses the
 * last `result` line. Plain logs, files over 64 MiB, and missing files yield null.
 */
export async function readAgentUsage(access: ArtifactAccess, filePath: string): Promise<TokenUsage | null> {
  let resolved: ResolvedArtifact;
  try {
    resolved = await resolveArtifactFile(access, filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (resolved.stat.size === 0 || resolved.stat.size > MAX_USAGE_SCAN_BYTES) return null;
  const format = await detectFromFile(resolved);
  if (format === 'plain') return null;

  const total = emptyUsage();
  let lastResult: TokenUsage | null = null;
  const stream = createReadStream(resolved.realPath, { encoding: 'utf8', start: 0, end: resolved.stat.size - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (format === 'codex-jsonl') {
        if (!line.includes('turn.completed')) continue;
        const parsed = parseJsonLine(line);
        if (isObject(parsed) && parsed.type === 'turn.completed') addUsage(total, codexUsage(parsed.usage));
      } else {
        if (!line.includes('"result"')) continue;
        const parsed = parseJsonLine(line);
        if (isObject(parsed) && parsed.type === 'result') lastResult = claudeUsage(parsed) ?? lastResult;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (format === 'claude-jsonl') return lastResult;
  return total.turns > 0 ? total : null;
}

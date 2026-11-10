/**
 * Read-only, bounded access to run artifacts (prompt, agent logs, last message,
 * verification) for the dashboard.
 *
 * Every request path must be absolute and must resolve (after symlinks) inside
 * one of the configured allowed roots. Reads go through a file descriptor at an
 * explicit offset, so large files are never loaded whole.
 */

import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { ArtifactChunk } from '../status/dashboardTypes.js';

export interface ArtifactAccess {
  allowedRoots: string[];
  symphonyArtifactsOnly?: boolean;
}

export class ArtifactAccessError extends Error {
  readonly status: 400 | 403 | 404;

  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = 'ArtifactAccessError';
    this.status = status;
  }
}

export const DEFAULT_CHUNK_BYTES = 64 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_TAIL_BYTES = 32 * 1024;

export interface ResolvedArtifact {
  /** The path as requested (normalized). */
  requestedPath: string;
  realPath: string;
  stat: Stats;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

function isSymphonyArtifact(candidate: string, root: string): boolean {
  if (!isInside(candidate, root)) return false;
  const parts = path.relative(root, candidate).split(path.sep);
  const folder = parts[0] === '_archives' ? 2 : parts[0] === '_loops' ? 2 : 1;
  if (parts[0]?.startsWith('.') || (parts[0] !== '_archives' && parts[folder] !== '.symphony')) return false;
  const rest = parts.slice(folder + (parts[0] === '_archives' ? 0 : 1));
  const name = rest.at(-1) ?? '';
  const allowedName = /^(?:prompt|review_prompt|last_message)\.md$|^(?:verification|manifest)\.json$|^[a-z0-9][\w.-]*\.(?:log|jsonl|ndjson)$/i.test(name);
  return allowedName && (rest.length === 1 || (rest.length === 3 && rest[0] === 'runs' && !rest[1]?.startsWith('.')));
}

async function resolvedRoots(access: ArtifactAccess): Promise<{ lexical: string[]; real: string[] }> {
  const lexical: string[] = [];
  const real: string[] = [];
  for (const root of access.allowedRoots) {
    if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) continue;
    lexical.push(path.resolve(root));
    try {
      real.push(await fs.realpath(root));
    } catch {
      // A root that does not exist cannot contain any real file.
    }
  }
  return { lexical, real };
}

/**
 * Validates and resolves an artifact path. Throws ArtifactAccessError with
 * 400 (bad request / not a regular file), 403 (outside allowed roots, including
 * symlink escapes) or 404 (missing).
 */
export async function resolveArtifactFile(access: ArtifactAccess, filePath: string): Promise<ResolvedArtifact> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ArtifactAccessError(400, 'Artifact path is required');
  }
  if (filePath.includes('\0')) {
    throw new ArtifactAccessError(400, 'Artifact path contains a NUL byte');
  }
  if (!path.isAbsolute(filePath)) {
    throw new ArtifactAccessError(400, 'Artifact path must be absolute');
  }
  const requestedPath = path.resolve(filePath);
  const roots = await resolvedRoots(access);

  if (access.symphonyArtifactsOnly && ![...roots.lexical, ...roots.real].some(root => isSymphonyArtifact(requestedPath, root))) {
    throw new ArtifactAccessError(403, 'Path is not a Symphony artifact');
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(requestedPath);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Do not reveal whether paths outside the allowed roots exist.
      const lexicallyAllowed = [...roots.lexical, ...roots.real].some((root) => isInside(requestedPath, root));
      if (!lexicallyAllowed) throw new ArtifactAccessError(403, 'Artifact path is outside the allowed roots');
      throw new ArtifactAccessError(404, 'Artifact not found');
    }
    if (code === 'EACCES' || code === 'EPERM') throw new ArtifactAccessError(403, 'Artifact is not readable');
    if (code === 'ELOOP' || code === 'ENAMETOOLONG') throw new ArtifactAccessError(400, 'Artifact path cannot be resolved');
    throw error;
  }

  if (!roots.real.some((root) => isInside(realPath, root))) {
    throw new ArtifactAccessError(403, 'Artifact path is outside the allowed roots');
  }

  if (access.symphonyArtifactsOnly && !roots.real.some(root => isSymphonyArtifact(realPath, root))) {
    throw new ArtifactAccessError(403, 'Path is not a Symphony artifact');
  }

  let stat: Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') throw new ArtifactAccessError(404, 'Artifact not found');
    throw error;
  }
  if (stat.isDirectory()) throw new ArtifactAccessError(400, 'Artifact path is a directory');
  if (!stat.isFile()) throw new ArtifactAccessError(400, 'Artifact path is not a regular file');
  return { requestedPath, realPath, stat };
}

/** Reads up to `length` bytes at `offset` through a file descriptor. */
export async function readBytes(realPath: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(realPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total === length ? buffer : buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export function artifactKind(filePath: string): ArtifactChunk['kind'] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'text';
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Largest e <= end such that buf[0, e) does not end inside a multibyte character. */
export function completeUtf8End(buf: Buffer, end: number): number {
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i]! & 0xc0) === 0x80) {
    i -= 1;
    continuation += 1;
  }
  if (i < 0) return end;
  const length = utf8SequenceLength(buf[i]!);
  return length > 1 && i + length > end ? i : end;
}

/** Number of leading continuation bytes (at most 3) to skip so decoding starts on a character. */
export function leadingContinuationBytes(buf: Buffer): number {
  let i = 0;
  while (i < buf.length && i < 3 && (buf[i]! & 0xc0) === 0x80) i += 1;
  return i;
}

function parseNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new ArtifactAccessError(400, `${name} must be a non-negative integer`);
  }
  return num;
}

function parseLimit(value: unknown, name: string, fallback: number, max: number): number {
  const parsed = parseNonNegativeInteger(value, name);
  if (parsed === undefined) return fallback;
  if (parsed === 0) throw new ArtifactAccessError(400, `${name} must be greater than zero`);
  return Math.min(parsed, max);
}

async function readRange(
  resolved: ResolvedArtifact,
  offset: number,
  limit: number,
  alignStart: boolean,
): Promise<ArtifactChunk> {
  const size = resolved.stat.size;
  const base: Omit<ArtifactChunk, 'offset' | 'next_offset' | 'content' | 'truncated'> = {
    path: resolved.requestedPath,
    size,
    kind: artifactKind(resolved.requestedPath),
    mtime: Number.isFinite(resolved.stat.mtimeMs) ? resolved.stat.mtime.toISOString() : null,
  };
  if (offset >= size) {
    return { ...base, offset, next_offset: offset, content: '', truncated: false };
  }
  // Read a few extra bytes so a character straddling the limit can be completed when needed.
  const buf = await readBytes(resolved.realPath, offset, Math.min(limit + 3, size - offset));
  const start = alignStart ? leadingContinuationBytes(buf) : 0;
  let end = Math.min(start + limit, buf.length);
  if (offset + end < size) end = completeUtf8End(buf, end);
  if (end <= start && buf.length > start) {
    // The limit is smaller than one character: return that character rather than nothing.
    end = Math.min(buf.length, start + utf8SequenceLength(buf[start]!));
  }
  const nextOffset = offset + end;
  return {
    ...base,
    offset: offset + start,
    next_offset: nextOffset,
    content: buf.subarray(start, end).toString('utf8'),
    truncated: nextOffset < size,
  };
}

/** Reads one bounded chunk starting at `offset` (default 0, limit default 64 KiB, max 1 MiB). */
export async function readArtifactChunk(
  access: ArtifactAccess,
  filePath: string,
  options: { offset?: number; limit?: number },
): Promise<ArtifactChunk> {
  const offset = parseNonNegativeInteger(options.offset, 'offset') ?? 0;
  const limit = parseLimit(options.limit, 'limit', DEFAULT_CHUNK_BYTES, MAX_CHUNK_BYTES);
  const resolved = await resolveArtifactFile(access, filePath);
  return readRange(resolved, offset, limit, false);
}

/** Reads the last `bytes` bytes (default 32 KiB, max 1 MiB), starting on a character boundary. */
export async function tailArtifact(
  access: ArtifactAccess,
  filePath: string,
  options: { bytes?: number },
): Promise<ArtifactChunk> {
  const bytes = parseLimit(options.bytes, 'tail', DEFAULT_TAIL_BYTES, MAX_CHUNK_BYTES);
  const resolved = await resolveArtifactFile(access, filePath);
  const offset = Math.max(0, resolved.stat.size - bytes);
  return readRange(resolved, offset, bytes, offset > 0);
}

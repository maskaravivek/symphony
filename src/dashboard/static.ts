import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

let located: string | null = null;

/**
 * Finds the static UI directory by walking up from this module: `src/dashboard/ui/` when running
 * from source (tsx), `ui/` next to the bundle when running from `dist/`.
 */
export function locateUiDir(from: string = import.meta.url): string | null {
  if (located && from === import.meta.url) return located;
  let dir = path.dirname(from.startsWith('file:') ? fileURLToPath(from) : from);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const candidate of [path.join(dir, 'src', 'dashboard', 'ui'), path.join(dir, 'ui')]) {
      if (existsSync(path.join(candidate, 'index.html'))) {
        if (from === import.meta.url) located = candidate;
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves a URL path (relative to the UI root, still percent-encoded) to a file inside `uiDir`.
 * Returns null for traversal attempts, NUL bytes, dotfiles, or undecodable input.
 */
export function resolveUiPath(uiDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  const root = path.resolve(uiDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

/** Writes a static file. Returns false (writing nothing) when the file does not exist. */
export async function sendStaticFile(res: ServerResponse, filePath: string, head: boolean): Promise<boolean> {
  let body: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    body = head ? Buffer.alloc(0) : await fs.readFile(filePath);
    const type = contentTypeFor(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(head ? stat.size : body.length),
      'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'max-age=60',
      'X-Content-Type-Options': 'nosniff',
    });
  } catch {
    return false;
  }
  res.end(head ? undefined : body);
  return true;
}

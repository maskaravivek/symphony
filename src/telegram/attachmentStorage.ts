import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_IMAGE_BYTES, type DownloadedImage } from './media.js';

export interface AttachmentStorage { store(key: string, image: DownloadedImage): Promise<string> }

export async function loadAttachmentStorage(configPath: string): Promise<AttachmentStorage | null> {
  let raw: string;
  try { raw = await fs.readFile(configPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const config = JSON.parse(raw) as { url?: string; tokenFile?: string };
  if (!config.url || !config.tokenFile) throw new Error('Attachment config requires url and tokenFile');
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Attachment service must be an HTTPS origin');
  const tokenPath = path.resolve(path.dirname(configPath), config.tokenFile);
  if ((await fs.stat(tokenPath)).mode & 0o077) throw new Error('Attachment upload token file must be owner-only');
  const token = (await fs.readFile(tokenPath, 'utf8')).trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error('Invalid attachment upload token');
  return new CloudflareAttachmentStorage(url.origin, token);
}

export class CloudflareAttachmentStorage implements AttachmentStorage {
  constructor(private origin: string, private token: string) {}

  async store(key: string, image: DownloadedImage): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(key) || !['jpg', 'png', 'gif', 'webp'].includes(image.extension) || image.bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid image upload');
    const url = `${this.origin}/attachments/telegram/${key}.${image.extension}`;
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const verify = async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(45_000), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('Image publication could not be verified');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('Invalid stored image'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      if (digest(Buffer.concat(chunks)) !== digest(image.bytes)) throw new Error('Stored image differs from upload');
    };
    try {
      let response: Response;
      try {
        response = await fetch(`${this.origin}/attachments/${key}`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': `image/${image.extension === 'jpg' ? 'jpeg' : image.extension}` },
          body: Uint8Array.from(image.bytes).buffer, signal: AbortSignal.timeout(45_000), redirect: 'error',
        });
      } catch {
        // A lost response may follow a successful upload. Public content verification
        // proves completion; another attempt safely reuses the same object ID.
        await verify(); return url;
      }
      if (!response.ok) throw new Error('Attachment service rejected upload');
      await verify(); return url;
    } catch { throw new Error('Attachment upload failed. Check connectivity and attachment service configuration.'); }
  }
}

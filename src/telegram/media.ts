import type { TelegramMessage } from './api.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export class TelegramMediaError extends Error {}
export interface TelegramImage { file_id: string; file_unique_id: string; file_size?: number }
export interface DownloadedImage { bytes: Uint8Array; extension: 'jpg' | 'png' | 'gif' | 'webp' }

export function messageImage(message: TelegramMessage): TelegramImage | undefined {
  if (message.photo?.length) return [...message.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (message.document) {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(message.document.mime_type ?? '')) {
      throw new TelegramMediaError('Send a photo or a JPEG, PNG, GIF, or WebP image file. Other files are not supported.');
    }
    return message.document;
  }
  return undefined;
}

export function imageExtension(bytes: Uint8Array): DownloadedImage['extension'] {
  const b = Buffer.from(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new TelegramMediaError('The attachment is not a supported image. Send JPEG, PNG, GIF, or WebP.');
}

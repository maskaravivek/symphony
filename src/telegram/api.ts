import { MAX_IMAGE_BYTES, TelegramMediaError, imageExtension, type DownloadedImage, type TelegramImage } from './media.js';

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: Array<TelegramImage & { width: number; height: number }>;
  document?: TelegramImage & { mime_type?: string };
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApi {
  downloadImage?(fileId: string): Promise<DownloadedImage>;
  updates(offset: number): Promise<TelegramUpdate[]>;
  send(text: string): Promise<number>;
  react?(messageId: number): Promise<void>;
}

export class TelegramBotApi implements TelegramApi {
  constructor(private token: string, private chatId: number) {}

  async downloadImage(fileId: string): Promise<DownloadedImage> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if ((file.file_size ?? 0) > MAX_IMAGE_BYTES) throw new TelegramMediaError('Images must be at most 8 MiB each.');
    if (!file.file_path || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.split('/').includes('..')) {
      throw new Error('Telegram returned an invalid file path');
    }
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(45_000), redirect: 'error',
      });
    } catch { throw new Error('Telegram image download failed'); }
    if (!response.ok || !response.body) throw new Error('Telegram image download failed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) throw new TelegramMediaError('Images must be at most 8 MiB each.');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof TelegramMediaError) throw error;
      throw new Error('Telegram image download failed');
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    return { bytes, extension: imageExtension(bytes) };
  }

  async username(): Promise<string> {
    const bot = await this.call<{ username: string }>('getMe', {});
    return bot.username;
  }

  private async call<T>(method: string, body: object): Promise<T> {
    // Never include fetch errors or API URLs in logs: URLs contain the bot token.
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new Error(`Telegram ${method} network request failed`);
    }
    if (!response.ok) throw new Error(`Telegram ${method} failed (HTTP ${response.status})`);
    const payload = await response.json() as { ok: boolean; result: T };
    if (!payload.ok) throw new Error(`Telegram ${method} was rejected`);
    return payload.result;
  }

  async updates(offset: number): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
  }

  async react(messageId: number): Promise<void> {
    await this.call<boolean>('setMessageReaction', {
      chat_id: this.chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }],
      is_big: false,
    });
  }

  async send(text: string): Promise<number> {
    const message = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      text: text.slice(0, 4000),
      link_preview_options: { is_disabled: true },
    });
    return message.message_id;
  }
}

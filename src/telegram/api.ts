export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApi {
  updates(offset: number): Promise<TelegramUpdate[]>;
  send(text: string): Promise<number>;
}

export class TelegramBotApi implements TelegramApi {
  constructor(private token: string, private chatId: number) {}

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
        signal: AbortSignal.timeout(35_000),
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
    return this.call('getUpdates', { offset, timeout: 10, allowed_updates: ['message'] });
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

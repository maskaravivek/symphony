import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TelegramBotApi } from './api.js';

export async function pairTelegram(options: { tokenFile?: string; stateDir: string }): Promise<void> {
  const token = options.tokenFile ? (await fs.readFile(options.tokenFile, 'utf8')).trim() : process.env.SYMPHONY_TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Provide --token-file or SYMPHONY_TELEGRAM_BOT_TOKEN');
  const stateDir = path.resolve(options.stateDir);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const pairingPath = path.join(stateDir, 'pairing.json');
  // Never silently replace an existing authorization.
  try {
    await fs.access(pairingPath);
    throw new Error('This directory is already paired. Use a new --state-dir to pair a different account.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const api = new TelegramBotApi(token, 0);
  const username = await api.username();
  const challenge = randomBytes(16).toString('hex');
  console.log(`Open https://t.me/${username} and send this exact message in a private chat:\n/start ${challenge}\nWaiting up to 5 minutes. Keep this pairing code private.`);
  const deadline = Date.now() + 5 * 60_000;
  let offset = 0;
  while (Date.now() < deadline) {
    for (const update of await api.updates(offset)) {
      offset = update.update_id + 1;
      const message = update.message;
      if (message?.chat.type !== 'private' || !message.from || message.from.is_bot || message.text !== `/start ${challenge}`) continue;
      await fs.writeFile(pairingPath, JSON.stringify({ chatId: String(message.chat.id), userId: String(message.from.id) }), { mode: 0o600, flag: 'wx' });
      // Persist consumed updates so the bridge doesn't replay old pairing messages.
      await fs.writeFile(path.join(stateDir, 'telegram.json'), JSON.stringify({ offset, seen: {}, messages: {}, pending: {} }), { mode: 0o600, flag: 'wx' });
      await new TelegramBotApi(token, message.chat.id).send('Paired with Symphony. Start the bridge, then use /questions or /status.');
      console.log(`Pairing saved to ${pairingPath}. Start the telegram command with this same --state-dir.`);
      return;
    }
  }
  throw new Error('Telegram pairing timed out; no account was authorized');
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLogLevel(): LogLevel {
  const raw = process.env.SYMPHONY_LOG_LEVEL?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLogLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  // eslint-disable-next-line no-console
  console.log(line);
}

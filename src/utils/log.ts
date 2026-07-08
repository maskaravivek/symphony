type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFormat = 'pretty' | 'json';

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

const COLOR: Record<LogLevel | 'muted' | 'field', string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  muted: '\u001b[90m',
  field: '\u001b[2m',
};

const RESET = '\u001b[0m';

function currentLogLevel(): LogLevel {
  const raw = process.env.SYMPHONY_LOG_LEVEL?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function currentLogFormat(): LogFormat {
  const raw = process.env.SYMPHONY_LOG_FORMAT?.trim().toLowerCase();
  return raw === 'json' ? 'json' : 'pretty';
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function colorize(value: string, color: string, useColor: boolean): string {
  return useColor ? `${color}${value}${RESET}` : value;
}

function humanizeMessage(message: string): string {
  return message.replace(/_/g, ' ');
}

function shortPath(value: string): string {
  const home = process.env.HOME;
  if (home && value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return shortPath(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatValue).join(',');
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatFieldValue(key: string, value: unknown): string {
  const formatted = formatValue(value);
  if (key === 'issue_title') return truncate(formatted, 72);
  return formatted;
}

function fieldLabel(key: string): string {
  switch (key) {
    case 'repo_id':
      return 'repo';
    case 'issue_identifier':
      return 'issue';
    case 'issue_number':
      return 'issue';
    case 'issue_title':
      return 'title';
    case 'pr_number':
      return 'pr';
    case 'agent_provider':
      return 'agent';
    case 'merge_state_status':
      return 'merge';
    case 'hook_log_path':
      return 'hook_log';
    case 'workspace_path':
      return 'workspace';
    case 'config_path':
      return 'config';
    case 'workflow_path':
      return 'workflow';
    case 'unmerged_files':
      return 'unmerged';
    default:
      return key;
  }
}

function shouldOmitField(key: string, fields: LogFields): boolean {
  if (key === 'event') return true;
  if (key === 'tracker_kind') return true;
  if (key === 'issue_id') return true;
  if (key === 'issue_url') return true;
  if (key === 'issue_number' && fields.issue_identifier) return true;
  if ((key === 'owner' || key === 'repo') && (fields.issue_identifier || fields.repo_id)) return true;
  return false;
}

function orderedFieldKeys(fields: LogFields): string[] {
  const preferred = [
    'repo_id',
    'issue_identifier',
    'issue_title',
    'pr_number',
    'status',
    'reason',
    'agent_provider',
    'merge_state_status',
    'head_ref',
    'base_ref',
    'error',
    'signal',
    'code',
    'unmerged_files',
    'hook_log_path',
    'workspace_path',
    'config_path',
    'workflow_path',
  ];
  const keys = Object.keys(fields).filter((key) => !shouldOmitField(key, fields) && fields[key] !== undefined);
  return [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key)).sort()];
}

export function formatPrettyLogLine(level: LogLevel, message: string, fields: LogFields = {}, useColor = shouldUseColor()): string {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const prefix = [
    colorize(timestamp, COLOR.muted, useColor),
    colorize(LEVEL_LABEL[level], COLOR[level], useColor),
    humanizeMessage(message),
  ].join(' ');

  const details = orderedFieldKeys(fields)
    .map((key) => {
      const value = formatFieldValue(key, fields[key]);
      if (!value) return null;
      const renderedValue = key === 'pr_number' ? `#${value}` : value;
      return `${colorize(`${fieldLabel(key)}=`, COLOR.field, useColor)}${renderedValue}`;
    })
    .filter((part): part is string => part !== null);

  return details.length > 0 ? `${prefix} ${details.join(' ')}` : prefix;
}

export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLogLevel()]) return;
  const line =
    currentLogFormat() === 'json'
      ? JSON.stringify({
          ts: new Date().toISOString(),
          level,
          message,
          ...fields,
        })
      : formatPrettyLogLine(level, message, fields);
  // eslint-disable-next-line no-console
  console.log(line);
}

export interface PauseRequest {
  reason: string;
  question: string;
  options: string[];
}

function parseList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function parseFields(body: string): { reason: string | null; question: string | null; options: string[] } {
  let field: 'reason' | 'question' | 'options' | null = null;
  const parts = {
    reason: [] as string[],
    question: [] as string[],
    options: [] as string[],
  };

  for (const line of body.split('\n')) {
    const match = /^(reason|question|options):\s*(.*)$/i.exec(line.trimEnd());
    if (match) {
      field = match[1].toLowerCase() as 'reason' | 'question' | 'options';
      if (match[2]) parts[field].push(match[2]);
      continue;
    }
    if (field) parts[field].push(line);
  }

  return {
    reason: parts.reason.join('\n').trim() || null,
    question: parts.question.join('\n').trim() || null,
    options: parseList(parts.options.join('\n')),
  };
}

export function parsePauseRequest(message: string | null | undefined): PauseRequest | null {
  if (!message) return null;
  const start = message.indexOf('SYMPHONY_PAUSE');
  if (start === -1) return null;
  const afterStart = message.slice(start + 'SYMPHONY_PAUSE'.length);
  const end = afterStart.indexOf('END_SYMPHONY_PAUSE');

  const body = end === -1 ? afterStart : afterStart.slice(0, end);
  const fields = parseFields(body);
  if (!fields.question) return null;

  return {
    reason: fields.reason ?? 'needs-info',
    question: fields.question,
    options: fields.options,
  };
}

export function formatPauseComment(request: PauseRequest): string {
  const options = request.options.length > 0 ? `\n\nOptions:\n${request.options.map((option) => `- ${option}`).join('\n')}` : '';
  return `Symphony paused because the agent needs input.\n\nReason: ${request.reason}\n\nQuestion:\n${request.question}${options}`;
}

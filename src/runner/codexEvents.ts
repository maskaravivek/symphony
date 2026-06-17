function visit(value: unknown, predicate: (record: Record<string, unknown>) => string | null): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = visit(item, predicate);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = predicate(record);
  if (direct) return direct;

  for (const nested of Object.values(record)) {
    const found = visit(nested, predicate);
    if (found) return found;
  }
  return null;
}

export function extractCodexThreadId(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  return visit(parsed, (record) => {
    const type = typeof record.type === 'string' ? record.type : typeof record.event === 'string' ? record.event : null;
    const threadId =
      typeof record.thread_id === 'string'
        ? record.thread_id
        : typeof record.threadId === 'string'
          ? record.threadId
          : typeof record.id === 'string' && type === 'thread.started'
            ? record.id
            : null;
    if (type === 'thread.started' && threadId) return threadId;
    return null;
  });
}

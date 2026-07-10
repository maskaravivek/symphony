import type { ScheduledLoopConfig } from '../workflow/types.js';

export function dueScheduledLoops(
  loops: ScheduledLoopConfig[],
  lastTriggeredAtById: ReadonlyMap<string, string>,
  nowMs: number,
): ScheduledLoopConfig[] {
  return loops.filter((loop) => {
    if (!loop.enabled) return false;
    const lastTriggeredAt = lastTriggeredAtById.get(loop.id);
    if (!lastTriggeredAt) return true;
    const lastTriggeredAtMs = Date.parse(lastTriggeredAt);
    if (!Number.isFinite(lastTriggeredAtMs)) return true;
    return nowMs - lastTriggeredAtMs >= loop.interval_ms;
  });
}

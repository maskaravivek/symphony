export const NON_QUEUEABLE_LIFECYCLE_LABELS = ['blocked', 'interactive', 'needs-info', 'ready-for-human', 'symphony-failed'] as const;

export function hasNonQueueableLifecycleLabel(labels: string[]): boolean {
  const normalized = new Set(labels.map((label) => label.trim().toLowerCase()));
  return NON_QUEUEABLE_LIFECYCLE_LABELS.some((label) => normalized.has(label));
}

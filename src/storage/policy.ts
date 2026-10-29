import type { StorageMaintenanceConfig } from '../workflow/types.js';

export const GIB = 1024 ** 3;
export const DAY = 86_400_000;
export const DEFAULT_STORAGE_POLICY: StorageMaintenanceConfig = {
  enabled: true,
  interval_ms: DAY,
  min_free_gib: 20,
  idle_days: 7,
  retention_days: 30,
  max_artifact_gib: 2,
  max_pool_slots: 8,
  warm_pool_slots: 1,
  cache_root: null,
  max_cache_gib: 10,
};

export function storagePolicy(config?: Partial<StorageMaintenanceConfig>): StorageMaintenanceConfig {
  return { ...DEFAULT_STORAGE_POLICY, ...config };
}

/** Resource backpressure keeps work queued without consuming a retry attempt. */
export class DispatchDeferredError extends Error {}

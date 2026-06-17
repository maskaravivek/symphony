import { loadServerConfigFromFile } from '../server/loadServerConfig.js';
import type { ServerConfig, ServerRepoConfig } from '../server/types.js';
import { log } from '../utils/log.js';
import { sleep } from '../utils/sleep.js';
import { Orchestrator } from './orchestrator.js';

interface RuntimeEntry {
  repo: ServerRepoConfig;
  orchestrator: Orchestrator;
}

export class MultiRepoOrchestrator {
  private configPath: string;
  private lastGoodConfig: ServerConfig | null = null;
  private runtimes = new Map<string, RuntimeEntry>();
  private stopped = false;

  constructor(options: { configPath: string }) {
    this.configPath = options.configPath;
  }

  stop(): void {
    this.stopped = true;
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    this.stopped = true;
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((r) => r.orchestrator.shutdown(reason)));
    this.runtimes.clear();
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      await this.tickOnce().catch((err) => {
        log('error', 'multi_repo_tick_failed', {
          event: 'multi_repo_tick_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
      const interval = this.lastGoodConfig?.polling.interval_ms ?? 30_000;
      await sleep(interval);
    }
  }

  async tickOnce(): Promise<void> {
    const config = await this.loadConfigSafe();
    if (!config) return;

    await this.reconcileRuntimes(config);

    for (const entry of this.runtimes.values()) {
      const globalSlots = this.getGlobalAvailableSlots(config);
      if (globalSlots !== null && globalSlots <= 0) return;
      await entry.orchestrator.tickOnce({ maxNewDispatches: globalSlots }).catch((err) => {
        log('error', 'repo_tick_failed', {
          event: 'repo_tick_failed',
          repo_id: entry.repo.id,
          workflow_path: entry.repo.workflow,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async loadConfigSafe(): Promise<ServerConfig | null> {
    try {
      const config = await loadServerConfigFromFile(this.configPath);
      this.lastGoodConfig = config;
      return config;
    } catch (err) {
      log('error', 'server_config_load_failed', {
        event: 'server_config_load_failed',
        config_path: this.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.lastGoodConfig;
    }
  }

  private async reconcileRuntimes(config: ServerConfig): Promise<void> {
    const enabledRepos = config.repos.filter((r) => r.enabled);
    const enabledIds = new Set(enabledRepos.map((r) => r.id));

    for (const [id, entry] of this.runtimes) {
      const nextRepo = enabledRepos.find((r) => r.id === id);
      const changed = nextRepo && nextRepo.workflow !== entry.repo.workflow;

      if (!enabledIds.has(id) || changed) {
        await entry.orchestrator.shutdown(changed ? 'repo_config_changed' : 'repo_disabled');
        this.runtimes.delete(id);
        continue;
      }

      if (nextRepo) {
        entry.repo = nextRepo;
        entry.orchestrator.setMaxConcurrentAgentsOverride(nextRepo.max_concurrent_agents);
      }
    }

    for (const repo of enabledRepos) {
      if (this.runtimes.has(repo.id)) continue;
      this.runtimes.set(repo.id, {
        repo,
        orchestrator: new Orchestrator({
          workflowPath: repo.workflow,
          repoId: repo.id,
          maxConcurrentAgents: repo.max_concurrent_agents,
        }),
      });
    }
  }

  private getGlobalAvailableSlots(config: ServerConfig): number | null {
    const globalLimit = config.agent.max_concurrent_agents;
    if (globalLimit === null) return null;
    const running = [...this.runtimes.values()].reduce((sum, entry) => sum + entry.orchestrator.getRunningCount(), 0);
    return Math.max(0, globalLimit - running);
  }
}

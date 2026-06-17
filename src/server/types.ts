export interface ServerPollingConfig {
  interval_ms: number;
}

export interface ServerAgentConfig {
  max_concurrent_agents: number | null;
}

export interface ServerRepoConfig {
  id: string;
  workflow: string;
  max_concurrent_agents: number | null;
  enabled: boolean;
}

export interface ServerConfig {
  polling: ServerPollingConfig;
  agent: ServerAgentConfig;
  repos: ServerRepoConfig[];
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { SymphonyConfigError } from '../utils/errors.js';
import { expandHomeDir } from '../utils/fs.js';
import type { ServerConfig, ServerRepoConfig } from './types.js';

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, keyPath: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SymphonyConfigError(`${keyPath} must be a string`);
  return value;
}

function asBoolean(value: unknown, keyPath: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new SymphonyConfigError(`${keyPath} must be a boolean`);
  return value;
}

function asPositiveNumber(value: unknown, keyPath: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SymphonyConfigError(`${keyPath} must be a positive number`);
  }
  return value;
}

function resolveWorkflowPath(configPath: string, workflowPath: string): string {
  const expanded = expandHomeDir(workflowPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(path.dirname(configPath), expanded);
}

export function normalizeServerConfig(raw: unknown, configPath: string): ServerConfig {
  if (!isRecord(raw)) throw new SymphonyConfigError('symphony config must be a YAML object');

  const pollingRaw = isRecord(raw.polling) ? raw.polling : {};
  const agentRaw = isRecord(raw.agent) ? raw.agent : {};

  const reposRaw = raw.repos;
  if (!Array.isArray(reposRaw)) throw new SymphonyConfigError('repos must be an array');

  const seenIds = new Set<string>();
  const repos: ServerRepoConfig[] = reposRaw.map((entry, index) => {
    const keyPath = `repos[${index}]`;
    if (!isRecord(entry)) throw new SymphonyConfigError(`${keyPath} must be an object`);

    const id = asString(entry.id, `${keyPath}.id`)?.trim();
    if (!id) throw new SymphonyConfigError(`${keyPath}.id is required`);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new SymphonyConfigError(`${keyPath}.id may only contain letters, numbers, dots, underscores, and dashes`);
    }
    if (seenIds.has(id)) throw new SymphonyConfigError(`duplicate repo id: ${id}`);
    seenIds.add(id);

    const workflow = asString(entry.workflow, `${keyPath}.workflow`);
    if (!workflow) throw new SymphonyConfigError(`${keyPath}.workflow is required`);

    return {
      id,
      workflow: resolveWorkflowPath(configPath, workflow),
      max_concurrent_agents: asPositiveNumber(entry.max_concurrent_agents, `${keyPath}.max_concurrent_agents`),
      enabled: asBoolean(entry.enabled, `${keyPath}.enabled`) ?? true,
    };
  });

  return {
    polling: {
      interval_ms: asPositiveNumber(pollingRaw.interval_ms, 'polling.interval_ms') ?? 30000,
    },
    agent: {
      max_concurrent_agents: asPositiveNumber(agentRaw.max_concurrent_agents, 'agent.max_concurrent_agents'),
    },
    repos,
  };
}

export async function loadServerConfigFromFile(configPath: string): Promise<ServerConfig> {
  const rawText = await fs.readFile(configPath, 'utf8');
  const rawConfig = parseYaml(rawText);
  return normalizeServerConfig(rawConfig, configPath);
}

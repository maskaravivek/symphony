import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface EpisodeEventInput {
  repo_id: string;
  episode_id: string;
  event: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface EpisodeEvent extends Required<EpisodeEventInput> {
  sequence: number;
}

export interface EpisodeEventFilter {
  repo_id?: string;
  episode_id?: string;
  event?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

interface EpisodeEventRow {
  sequence: number;
  repo_id: string;
  episode_id: string;
  event: string;
  payload_json: string;
  created_at: string;
}

export class EpisodeStore {
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS episode_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS episode_events_repo_episode
        ON episode_events (repo_id, episode_id, sequence);
      CREATE INDEX IF NOT EXISTS episode_events_event
        ON episode_events (repo_id, event, sequence);
    `);
  }

  append(input: EpisodeEventInput): EpisodeEvent {
    const createdAt = input.created_at ?? new Date().toISOString();
    const payload = input.payload ?? {};
    const result = this.database
      .prepare(
        `INSERT INTO episode_events (repo_id, episode_id, event, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.repo_id, input.episode_id, input.event, JSON.stringify(payload), createdAt);

    return {
      sequence: Number(result.lastInsertRowid),
      repo_id: input.repo_id,
      episode_id: input.episode_id,
      event: input.event,
      payload,
      created_at: createdAt,
    };
  }

  list(filter: EpisodeEventFilter = {}): EpisodeEvent[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.repo_id) {
      clauses.push('repo_id = ?');
      values.push(filter.repo_id);
    }
    if (filter.episode_id) {
      clauses.push('episode_id = ?');
      values.push(filter.episode_id);
    }
    if (filter.event) {
      clauses.push('event = ?');
      values.push(filter.event);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 500, 5_000));
    values.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database
      .prepare(
        `SELECT sequence, repo_id, episode_id, event, payload_json, created_at
         FROM episode_events ${where}
         ORDER BY sequence ${filter.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .all(...values) as unknown as EpisodeEventRow[];

    return rows.map((row) => ({
      sequence: row.sequence,
      repo_id: row.repo_id,
      episode_id: row.episode_id,
      event: row.event,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  latest(filter: Omit<EpisodeEventFilter, 'limit'> = {}): EpisodeEvent | null {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.repo_id) {
      clauses.push('repo_id = ?');
      values.push(filter.repo_id);
    }
    if (filter.episode_id) {
      clauses.push('episode_id = ?');
      values.push(filter.episode_id);
    }
    if (filter.event) {
      clauses.push('event = ?');
      values.push(filter.event);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = this.database
      .prepare(
        `SELECT sequence, repo_id, episode_id, event, payload_json, created_at
         FROM episode_events ${where}
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(...values) as unknown as EpisodeEventRow | undefined;
    if (!row) return null;
    return {
      sequence: row.sequence,
      repo_id: row.repo_id,
      episode_id: row.episode_id,
      event: row.event,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      created_at: row.created_at,
    };
  }

  close(): void {
    this.database.close();
  }
}

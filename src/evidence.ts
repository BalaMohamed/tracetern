import type { Experiment } from './experiment.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot, harnessIdentity } from './revision.js';
import type { compare } from './scenario.js';

export type Result = ReturnType<typeof compare> | { schemaVersion: 1; verdict: 'inconclusive'; reason: string };
export interface Investigation {
  plan?: Experiment;
  reference: Snapshot;
  candidate: Snapshot;
  environment: Awaited<ReturnType<typeof harnessIdentity>>;
  result: Result;
  replayOf?: string;
}

export function openEvidence(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'runs.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs_v1 (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT`);
    return {
      save(record: Investigation) {
        const id = randomUUID();
        db.prepare('INSERT INTO runs_v1 VALUES (?, ?, ?)').run(id, new Date().toISOString(), JSON.stringify(record));
        return id;
      },
      load(id: string): Investigation {
        const row = db.prepare('SELECT payload FROM runs_v1 WHERE id = ?').get(id);
        if (typeof row?.payload !== 'string') throw new Error('Unknown investigation: ' + id);
        return JSON.parse(row.payload) as Investigation;
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

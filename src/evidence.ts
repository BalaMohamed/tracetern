import type { Planner, Proposal } from './planner.js';
import type { Experiment } from './experiment.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HarnessIdentity, Snapshot } from './revision.js';
import type { compare, Implementation } from './scenario.js';

type Comparison = ReturnType<typeof compare>;
type SavedComparison = Omit<Comparison, 'callMetric'> & { callMetric?: Comparison['callMetric'] };
export type Result = SavedComparison | { schemaVersion: 1; verdict: 'inconclusive'; reason: string };
export interface Investigation {
  plan?: Experiment;
  planner?: Planner;
  proposal?: Proposal;
  reference: Snapshot;
  candidate: Snapshot;
  environment: HarnessIdentity;
  result: Result;
  replayOf?: string;
  verificationOf?: string;
  fixtureImplementation?: Implementation;
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

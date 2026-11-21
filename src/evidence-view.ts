import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { defaultExperiment, type Experiment } from './experiment.js';
import type { Result } from './evidence.js';

type Completed = Exclude<Result, { verdict: 'inconclusive' }>;
type Row = Record<string, SQLOutputValue>;
export const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RunSummary {
  runId: string;
  createdAt: string;
  verdict: Result['verdict'];
  baseCommit: string;
  candidateCommit: string;
  fixtureImplementation: string | null;
  replayOf: string | null;
  verificationOf: string | null;
}

export interface RunEvidence extends RunSummary {
  fixture: string;
  sourcePath: string;
  planner: 'rule' | 'ollama' | null;
  plan: Experiment | null;
  observed: Pick<Completed, 'postgres' | 'reads' | 'mismatch' | 'callMetric'> | null;
}

const summaryColumns = `id, created_at,
  json_extract(payload, '$.result.verdict') AS verdict,
  json_extract(payload, '$.reference.commit') AS base_commit,
  json_extract(payload, '$.candidate.commit') AS candidate_commit,
  json_extract(payload, '$.fixtureImplementation') AS implementation,
  json_extract(payload, '$.replayOf') AS replay_of,
  json_extract(payload, '$.verificationOf') AS verification_of`;

function read<T>(directory: string, empty: T, inspect: (db: DatabaseSync) => T): T {
  const path = join(directory, 'runs.sqlite');
  if (!statSync(path, { throwIfNoEntry: false })) return empty;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'runs_v1'").get();
    return table ? inspect(db) : empty;
  } finally {
    db.close();
  }
}

function summary(row: Row): RunSummary {
  return {
    runId: row.id as string,
    createdAt: row.created_at as string,
    verdict: row.verdict as RunSummary['verdict'],
    baseCommit: row.base_commit as string,
    candidateCommit: row.candidate_commit as string,
    fixtureImplementation: row.implementation as string | null,
    replayOf: row.replay_of as string | null,
    verificationOf: row.verification_of as string | null,
  };
}

export function listRuns(directory: string): RunSummary[] {
  return read(directory, [], db => db.prepare(`
    SELECT ${summaryColumns} FROM runs_v1 ORDER BY rowid DESC LIMIT 25
  `).all().map(summary));
}

export function getRun(directory: string, runId: string): RunEvidence | undefined {
  if (!runIdPattern.test(runId)) return undefined;
  return read(directory, undefined, db => {
    const row = db.prepare(`
      SELECT ${summaryColumns},
        json_extract(payload, '$.environment.fixture') AS fixture,
        json_extract(payload, '$.candidate.sourcePath') AS source_path,
        json_extract(payload, '$.planner.kind') AS planner,
        json_extract(payload, '$.plan') AS plan,
        CASE WHEN json_extract(payload, '$.result.verdict') IN ('pass', 'regression')
          THEN json_extract(payload, '$.result') END AS completed
      FROM runs_v1 WHERE id = ?
    `).get(runId);
    if (!row) return undefined;

    const result = typeof row.completed === 'string' ? JSON.parse(row.completed) as Completed : null;
    const mismatch = result?.mismatch;
    return {
      ...summary(row),
      fixture: row.fixture as string,
      sourcePath: row.source_path as string,
      planner: row.planner as RunEvidence['planner'],
      plan: typeof row.plan === 'string' ? JSON.parse(row.plan) as Experiment : result && defaultExperiment,
      observed: result && {
        postgres: result.postgres,
        callMetric: result.callMetric,
        reads: result.reads,
        mismatch: mismatch ? {
          stage: mismatch.stage,
          readIndex: mismatch.readIndex,
          position: mismatch.position,
          expected: mismatch.expected && {
            id: mismatch.expected.id,
            customerName: mismatch.expected.customerName,
          },
          actual: mismatch.actual && {
            id: mismatch.actual.id,
            customerName: mismatch.actual.customerName,
          },
        } : null,
      },
    };
  });
}

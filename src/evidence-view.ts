import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { defaultExperiment, type Experiment } from './experiment.js';
import { datafusionFixture, runIdPattern, type EvidenceCheck, type LibrarySelection, type Result } from './evidence.js';
import { isLibraryFixture, type LibraryCase } from './library-cases.js';
import type { LibraryPlanning } from './library-planner.js';
import type { ReasonCode } from './execution.js';

type Completed = Exclude<Result, { verdict: 'inconclusive' }>;
type Row = Record<string, SQLOutputValue>;
export { runIdPattern };

export interface RunSummary {
  runId: string;
  createdAt: string;
  verdict: Result['verdict'];
  baseCommit: string;
  candidateCommit: string;
  fixtureImplementation: string | null;
  fixture: string;
  replayOf: string | null;
  verificationOf: string | null;
}

export interface RunEvidence extends RunSummary {
  sourcePath: string | null;
  planner: 'rule' | 'ollama' | null;
  plan: Experiment | null;
  observed: Pick<Completed, 'postgres' | 'reads' | 'mismatch' | 'callMetric'> | null;
  checks?: EvidenceCheck[];
  planning?: LibraryPlanning;
  selection?: LibrarySelection;
  libraryPlan?: LibraryCase[];
  reason?: string;
  reasonCode?: ReasonCode;
}

// Only publish fixed descriptions. Historical reasons and runner diagnostics can contain local data.
const reasons: Record<ReasonCode, string> = {
  'no-coverage': 'No supported saved experiment covered the change.',
  'shared-failure': 'Both revisions exhibited the same failure with passing controls.',
  'invalid-input': 'The runner could not use the supplied inputs.',
  'incompatible-replay': 'The replay environment is incompatible with the saved run.',
  'artifact-invalid': 'A saved artifact was missing or failed its integrity check.',
  'execution-failed': 'The experiment could not complete.',
  'invalid-observations': 'The worker returned invalid observations.',
  'reference-failed': 'The baseline failed a contract or differed from the saved observations.',
  timeout: 'The experiment exceeded its time limit.',
  cancelled: 'The experiment was cancelled.',
};

const summaryColumns = `id, created_at,
  json_extract(payload, '$.result.verdict') AS verdict,
  json_extract(payload, '$.reference.commit') AS base_commit,
  json_extract(payload, '$.candidate.commit') AS candidate_commit,
  json_extract(payload, '$.fixtureImplementation') AS implementation,
  json_extract(payload, '$.replayOf') AS replay_of,
  json_extract(payload, '$.verificationOf') AS verification_of,
  json_extract(payload, '$.environment.fixture') AS fixture`;

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
    fixture: row.fixture as string,
    replayOf: row.replay_of as string | null,
    verificationOf: row.verification_of as string | null,
  };
}

export function listRuns(directory: string): RunSummary[] {
  return read(directory, [], db => db.prepare(`
    SELECT ${summaryColumns} FROM runs_v1 ORDER BY rowid DESC LIMIT 25
  `).all().map(summary));
}

// Return one original result per revision pair, mode and experiment plan.
// Replays and follow-up verifications retain their evidence but add no examples.
export function retrievalRuns(directory: string): RunSummary[] {
  return read(directory, [], db => db.prepare(`
    SELECT ${summaryColumns} FROM runs_v1
    WHERE rowid IN (
      SELECT MAX(rowid) FROM runs_v1
      WHERE json_extract(payload, '$.replayOf') IS NULL
        AND json_extract(payload, '$.verificationOf') IS NULL
        AND json_extract(payload, '$.result.verdict') IN ('pass', 'regression')
      GROUP BY json_extract(payload, '$.environment.fixture'),
        json_extract(payload, '$.reference.commit'), json_extract(payload, '$.candidate.commit'),
        json_extract(payload, '$.fixtureImplementation'), json_extract(payload, '$.plan')
    )
    ORDER BY rowid DESC
  `).all().map(summary));
}

export function getRun(directory: string, runId: string): RunEvidence | undefined {
  if (!runIdPattern.test(runId)) return undefined;
  return read(directory, undefined, db => {
    const row = db.prepare(`
      SELECT ${summaryColumns},
        json_extract(payload, '$.candidate.sourcePath') AS source_path,
        json_extract(payload, '$.planner.kind') AS planner,
        json_extract(payload, '$.plan') AS plan,
        json_extract(payload, '$.planning') AS planning,
        json_extract(payload, '$.selection') AS selection,
        json_extract(payload, '$.result.reasonCode') AS reason_code,
        CASE WHEN json_extract(payload, '$.result.verdict') IN ('pass', 'regression')
          OR json_type(payload, '$.result.checks') = 'array'
          THEN json_extract(payload, '$.result') END AS completed
      FROM runs_v1 WHERE id = ?
    `).get(runId);
    if (!row) return undefined;
    const reasonCode = typeof row.reason_code === 'string' && Object.hasOwn(reasons, row.reason_code)
      ? row.reason_code as ReasonCode : undefined;
    const outcome = row.verdict === 'inconclusive'
      ? { reason: reasonCode ? reasons[reasonCode] : 'The runner could not reach a verdict.', reasonCode }
      : {};
    const sourcePath = row.source_path as string | null;

    if (row.fixture === datafusionFixture || isLibraryFixture(row.fixture)) {
      const result = typeof row.completed === 'string' ? JSON.parse(row.completed) as Pick<RunEvidence, 'checks'> : undefined;
      return {
        ...summary(row), ...outcome, sourcePath, planner: null,
        plan: null, observed: null, checks: result?.checks,
        libraryPlan: isLibraryFixture(row.fixture) && typeof row.plan === 'string'
          ? JSON.parse(row.plan) as LibraryCase[] : undefined,
        selection: typeof row.selection === 'string' ? JSON.parse(row.selection) as LibrarySelection : undefined,
        planning: typeof row.planning === 'string' ? JSON.parse(row.planning) as LibraryPlanning : undefined,
      };
    }

    const result = typeof row.completed === 'string' ? JSON.parse(row.completed) as Completed : null;
    const mismatch = result?.mismatch;
    return {
      ...summary(row),
      ...outcome, sourcePath,
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

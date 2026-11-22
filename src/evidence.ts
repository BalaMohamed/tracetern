import type { Planner, Proposal } from './planner.js';
import type { Experiment } from './experiment.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HarnessIdentity, Snapshot } from './revision.js';
import type { compare, Implementation } from './scenario.js';
import { isLibraryFixture, type LibraryCase, type LibraryFixture, type LibraryResult } from './library-cases.js';
import type { CoverageTarget } from './coverage.js';
import type { LibraryPlanning } from './library-planner.js';

import type { DataFusionInvestigation } from './datafusion.js';
import { InvestigationError, type ReasonCode } from './execution.js';

export const datafusionFixture = 'datafusion-parquet-pushdown/v1';
export type EvidenceCheck = Omit<LibraryResult['checks'][number], 'id'> & { id: string };
type SavedRun = Investigation | LibraryInvestigation | DataFusionInvestigation;

type Comparison = ReturnType<typeof compare>;
type SavedComparison = Omit<Comparison, 'callMetric'> & { callMetric?: Comparison['callMetric'] };
export type Inconclusive = { schemaVersion: 1; verdict: 'inconclusive'; reason: string; reasonCode?: ReasonCode };
export type Result = SavedComparison | Inconclusive;
export interface Investigation {
  adapter?: never;
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
  referenceOrdersSha256?: string;
}

export type LibrarySelection = { exampleRunId: string; coverage: CoverageTarget[] };

export interface LibraryInvestigation {
  adapter: LibraryFixture;
  plan: LibraryCase[];
  planning?: LibraryPlanning;
  selection?: LibrarySelection;
  reference: Snapshot;
  candidate: Snapshot;
  environment: HarnessIdentity;
  result: LibraryResult | (Inconclusive & { checks?: LibraryResult['checks'] });
  replayOf?: string;
  verificationOf?: string;
}

export function openEvidence(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'runs.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs_v1 (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT`);
    function load(id: string): SavedRun {
      if (!runIdPattern.test(id)) throw new InvestigationError('invalid-input', 'Unknown investigation: invalid run ID');
      const row = db.prepare('SELECT payload FROM runs_v1 WHERE id = ?').get(id);
      if (typeof row?.payload !== 'string') throw new InvestigationError('invalid-input', 'Unknown investigation: ' + id);
      return JSON.parse(row.payload) as SavedRun;
    }
    return {
      save(record: SavedRun) {
        const id = randomUUID();
        db.prepare('INSERT INTO runs_v1 VALUES (?, ?, ?)').run(id, new Date().toISOString(), JSON.stringify(record));
        return id;
      },
      load(id: string): Investigation {
        const record = load(id);
        if (record.adapter !== undefined) throw new Error('Expected an Orders investigation');
        return record;
      },
      loadDataFusion(id: string): DataFusionInvestigation {
        const record = load(id);
        if (record.adapter !== datafusionFixture) throw new Error('Expected a DataFusion investigation');
        return record;
      },
      loadLibrary(id: string): LibraryInvestigation {
        const record = load(id);
        if (record.adapter === undefined || record.adapter === datafusionFixture || !isLibraryFixture(record.adapter)) throw new Error('Expected a library investigation');
        return record;
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

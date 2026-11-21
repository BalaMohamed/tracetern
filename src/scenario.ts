import { defaultExperiment, observationStages, type Experiment } from './experiment.js';
import type { QueryGroups } from './query-groups.js';

export const implementations = ['batch', 'cache', 'n-plus-one'] as const;
export type Implementation = (typeof implementations)[number];
export const stages = ['cold', 'warm', 'after-rename'] as const;
export type Stage = (typeof stages)[number];

export interface Order {
  id: number;
  customerName: string;
}

export interface Observation {
  stage: Stage;
  reads: number;
  queryGroups?: QueryGroups;
  orders: Order[];
}

export interface Run {
  implementation: Implementation;
  postgres: string;
  observations: Observation[];
}

export interface Mismatch {
  stage: Stage;
  position: number;
  readIndex?: number;
  expected: Order | null;
  actual: Order | null;
}

// The fixture contract is independent of the SQL implementation under test.
export function firstMismatch(run: Run, plan: Experiment = defaultExperiment): Mismatch | undefined {
  const stages = observationStages(plan);
  if (run.observations.length !== stages.length ||
      !stages.every((stage, index) => run.observations[index]?.stage === stage)) {
    throw new Error('Incomplete or unordered replay');
  }
  for (const frame of run.observations) {
    if (!Array.isArray(frame.orders) || !Number.isSafeInteger(frame.reads) || frame.reads < 0) {
      throw new Error('Malformed observations for ' + frame.stage);
    }
    if (frame.orders.some(row => !row || !Number.isSafeInteger(row.id) || typeof row.customerName !== 'string')) {
      throw new Error('Malformed order in ' + frame.stage);
    }
  }
  for (const [readIndex, frame] of run.observations.entries()) {
    const { stage } = frame;
    for (let i = 0; i < Math.max(100, frame.orders.length); i++) {
      const customer = 100 - i;
      const expected = i >= 100 ? null : {
        id: i + 1,
        customerName: stage === 'after-rename' && customer === plan.customerId ? 'Avery' : 'Customer ' + customer,
      };
      const actual = frame.orders[i] ?? null;
      if (actual?.id !== expected?.id || actual?.customerName !== expected?.customerName) {
        return { stage, readIndex, position: i, expected, actual };
      }
    }
  }
}

export function compare(reference: Run, candidate: Run, plan: Experiment = defaultExperiment) {
  if (reference.postgres !== candidate.postgres) throw new Error('Database versions differ');
  if (firstMismatch(reference, plan)) throw new Error('Reference violates the fixture contract');
  const mismatch = firstMismatch(candidate, plan);
  return {
    schemaVersion: 1,
    fixture: 'orders-list/v1',
    node: process.version,
    postgres: reference.postgres,
    reference: reference.implementation,
    candidate: candidate.implementation,
    verdict: mismatch ? 'regression' as const : 'pass' as const,
    mismatch: mismatch ?? null,
    reads: reference.observations.map((baseline, index) => {
      const trial = candidate.observations[index]!;
      return {
        stage: baseline.stage,
        reference: baseline.reads,
        candidate: trial.reads,
        queryGroups: baseline.queryGroups && trial.queryGroups
          ? { reference: baseline.queryGroups, candidate: trial.queryGroups }
          : undefined,
      };
    }),
  };
}

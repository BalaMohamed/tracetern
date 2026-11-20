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
  expected: Order | null;
  actual: Order | null;
}

// The fixture contract is independent of the SQL implementation under test.
export function firstMismatch(run: Run): Mismatch | undefined {
  if (run.observations.length !== stages.length ||
      !stages.every((stage, index) => run.observations[index]?.stage === stage)) {
    throw new Error('Incomplete or unordered replay');
  }
  for (const frame of run.observations) {
    const { stage } = frame;
    for (let i = 0; i < Math.max(100, frame.orders.length); i++) {
      const customer = 100 - i;
      const expected = i >= 100 ? null : {
        id: i + 1,
        customerName: stage === 'after-rename' && customer === 1 ? 'Avery' : 'Customer ' + customer,
      };
      const actual = frame.orders[i] ?? null;
      if (actual?.id !== expected?.id || actual?.customerName !== expected?.customerName) {
        return { stage, position: i, expected, actual };
      }
    }
  }
}

export function compare(reference: Run, candidate: Run) {
  if (reference.postgres !== candidate.postgres) throw new Error('Database versions differ');
  if (firstMismatch(reference)) throw new Error('Reference violates the fixture contract');
  const mismatch = firstMismatch(candidate);
  return {
    schemaVersion: 1,
    fixture: 'orders-list/v1',
    node: process.version,
    postgres: reference.postgres,
    reference: reference.implementation,
    candidate: candidate.implementation,
    verdict: mismatch ? 'regression' as const : 'pass' as const,
    mismatch: mismatch ?? null,
    reads: stages.map((stage, i) => ({
      stage, reference: reference.observations[i]!.reads, candidate: candidate.observations[i]!.reads,
    })),
  };
}

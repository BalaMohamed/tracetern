export const libraryFixture = 'tanstack-query-keys/v1';
export const zustandFixture = 'zustand-vanilla/v1';
export type LibraryFixture = typeof libraryFixture | typeof zustandFixture;

export function isLibraryFixture(value: unknown): value is LibraryFixture {
  return value === libraryFixture || value === zustandFixture;
}

// A missing cache value or timestamp is recorded as null.
export const expectedLookups = {
  'equivalent-object-keys': ['open page 2'],
  'distinct-array-keys': ['first ordering', 'second ordering'],
  'restore-baseline-cache': ['saved open orders'],
  // Stable one-query control, then two requested queries during a pending update.
  'optimistic-query-count': ['1', '1', '2', '2'],
  'dehydration-timestamp': [
    '900', '900', 'clock read',
    '444', '444', 'clock unused',
    '123', '123', 'clock unused',
    '0', '0', 'clock unused',
  ],
  'zustand-null-update': ['2:kept', '1', '1', 'null', 'null'],
} as const;

export type LibraryCase = keyof typeof expectedLookups;
export const libraryPlan = Object.keys(expectedLookups) as LibraryCase[];
export const defaultLibraryPlan: LibraryCase[] = [
  'equivalent-object-keys', 'distinct-array-keys', 'restore-baseline-cache',
];
export type LibraryLookups = Partial<Record<LibraryCase, (string | null)[]>>;

export function validateLibraryPlan(plan: unknown): LibraryCase[] {
  if (!Array.isArray(plan) || plan.length === 0 || plan.length > libraryPlan.length) {
    throw new Error('Expected at least one known library experiment');
  }
  const selected = libraryPlan.filter(id => plan.includes(id));
  if (selected.length !== plan.length || selected.some((id, index) => plan[index] !== id)) {
    throw new Error('Library experiments must be unique known IDs in suite order');
  }
  return selected;
}

export interface LibraryResult {
  schemaVersion: 1;
  fixture: LibraryFixture;
  verdict: 'pass' | 'regression';
  checks: {
    id: LibraryCase;
    expected: readonly string[];
    reference: (string | null)[];
    candidate: (string | null)[];
    matched: boolean;
    repaired?: true;
    contractAdded?: true;
  }[];
}

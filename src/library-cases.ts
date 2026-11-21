export const libraryFixture = 'tanstack-query-keys/v1';

// Each result is a public getQueryData lookup. A cache miss is recorded as null.
export const expectedLookups = {
  'equivalent-object-keys': ['open page 2'],
  'distinct-array-keys': ['first ordering', 'second ordering'],
  'restore-baseline-cache': ['saved open orders'],
} as const;

export type LibraryCase = keyof typeof expectedLookups;
export const libraryPlan = Object.keys(expectedLookups) as LibraryCase[];
export type LibraryLookups = Record<LibraryCase, (string | null)[]>;

export interface LibraryResult {
  schemaVersion: 1;
  fixture: typeof libraryFixture;
  verdict: 'pass' | 'regression';
  checks: {
    id: LibraryCase;
    expected: readonly string[];
    reference: (string | null)[];
    candidate: (string | null)[];
    matched: boolean;
  }[];
}

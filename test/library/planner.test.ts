import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLibraryPlan } from '../../src/library-cases.js';
import { keyGuide, observerGuide, persistenceGuide, selectLibraryExperiments, timestampGuide } from '../../src/library-planner.js';

const docs = new Map([
  [keyGuide, '# Query keys\nThe order of keys in objects does not matter: these are considered equal.\nArray item order matters!'],
  [persistenceGuide, 'Attempts to hydrate a previously persisted query cache.'],
  [observerGuide, 'The combine option can combine the results of the queries into a single value.'],
]);

test('planner joins a changed hunk to documented key contracts and cites both revisions', () => {
  const path = 'packages/query-core/src/utils.ts';
  const patch = `diff --git a/${path} b/${path}
@@ -52 +53 @@ export function hashKey(key: QueryKey) {
-  return canonical(key);
+  return JSON.stringify(key);
`;
  const plan = selectLibraryExperiments(patch, docs);
  assert.deepEqual(plan.experiments.map(experiment => experiment.id), [
    'equivalent-object-keys', 'distinct-array-keys', 'restore-baseline-cache',
  ]);
  assert.deepEqual(plan.experiments[0]?.change, {
    path, line: 52, revision: 'base', excerpt: '-  return canonical(key);',
  });
  assert.equal(plan.experiments[1]?.contract.line, 3);
  assert.equal(plan.experiments[2]?.contract.path, persistenceGuide);
  assert.deepEqual(selectLibraryExperiments(patch, new Map()).experiments, []);
});

test('observer notification changes select the observer experiment with a combine citation', () => {
  const path = 'packages/query-core/src/queriesObserver.ts';
  const patch = `diff --git a/${path} b/${path}\n@@ -40,0 +41 @@\n+  this.#observerMatches.map(readHash);\n`;
  const [experiment, ...others] = selectLibraryExperiments(patch, docs).experiments;
  assert.equal(others.length, 0);
  assert.equal(experiment?.id, 'optimistic-query-count');
  assert.equal(experiment?.contract.path, observerGuide);
});

test('timestamp planning cites the new contract and prefers the baseline when it already exists', () => {
  const path = 'packages/query-core/src/hydration.ts';
  const patch = `diff --git a/${path} b/${path}\n@@ -3,0 +4 @@\n+  dehydratedAt?: number;\n`;
  const candidateDocs = new Map([[timestampGuide, 'Pass it as `dehydratedAt` without reading the current time.']]);
  const newPlan = selectLibraryExperiments(patch, docs, candidateDocs);
  assert.deepEqual(newPlan.experiments.map(({ id, contract }) => [id, contract.revision]), [
    ['dehydration-timestamp', 'candidate'],
  ]);
  const baseDocs = new Map([...docs, ...candidateDocs]);
  assert.equal(selectLibraryExperiments(patch, baseDocs, candidateDocs).experiments[0]?.contract.revision, 'base');
  assert.deepEqual(selectLibraryExperiments(patch, docs).experiments, []);
});

test('a hash mention in a test or unrelated source file yields no experiment', () => {
  for (const path of [
    'packages/query-core/src/__tests__/utils.test.ts',
    'packages/query-core/src/queriesObserver.ts',
  ]) {
    const patch = `diff --git a/${path} b/${path}\n@@ -0,0 +12 @@\n+  return hashKey(key);\n`;
    assert.deepEqual(selectLibraryExperiments(patch, docs).experiments, []);
  }
});

test('library plans reject unknown, duplicate and unordered operation IDs', () => {
  assert.deepEqual(validateLibraryPlan(['distinct-array-keys']), ['distinct-array-keys']);
  for (const invalid of [[], ['shell'], ['distinct-array-keys', 'distinct-array-keys'],
    ['restore-baseline-cache', 'distinct-array-keys']]) {
    assert.throws(() => validateLibraryPlan(invalid));
  }
});

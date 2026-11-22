import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { datafusionFixture, openEvidence, type LibraryInvestigation } from '../src/evidence.js';
import type { DataFusionInvestigation } from '../src/datafusion.js';
import { rankExperiments, suggestExperiments } from '../src/retrieval.js';

import { libraryFixture, zustandFixture } from '../src/library-cases.js';

const probe = {
  commit: 'a'.repeat(40), sourcePath: 'schema_rewriter.rs', pushdown: true,
  runtime: { binding: 'fixture', engine: 'fixture', python: 'fixture', arrow: 'fixture', nativeSha256: 'fixture' },
  observations: { nested: [2], pruned: 2, unoptimized: [2], inferred: [2], scalar: [2] },
};
function checks(...ids: string[]) {
  return ids.map(id => ({ id, expected: ['2'], reference: ['2'], candidate: ['2'], matched: true }));
}
const evidence: DataFusionInvestigation = {
  adapter: datafusionFixture, fixtureImplementation: 'fixed', reference: probe, candidate: probe,
  environment: { fixture: datafusionFixture, harnessSha256: 'fixture' },
  parquet: { sha256: 'fixture', base64: '' },
  result: { schemaVersion: 1, fixture: datafusionFixture, verdict: 'pass',
    checks: checks('adapted struct IDs', 'rows pruned by Parquet pushdown') },
};
function patch(path: string, line: string) {
  return `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old()
+${line}
`;
}

test('diff retrieval counts original experiment variants once and cites changed production code', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-retrieval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, '.tracetern');
  const store = openEvidence(directory);
  const id = store.save(evidence);
  const duplicate = store.save(evidence);
  const replay = store.save({ ...evidence, replayOf: id });
  store.save({ ...evidence, replayOf: replay });
  store.save({ ...evidence, fixtureImplementation: 'disabled',
    result: { ...evidence.result, verdict: 'regression' } });
  store.close();

  const path = 'datafusion/datasource-parquet/src/projection_read_plan.rs';
  const diff = patch(path, 'checkStructPredicate(schema)');
  const file = join(cwd, 'change.patch');
  await writeFile(file, diff);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'suggest', file, '--json'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const { suggestions } = JSON.parse(result.stdout);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].distinctCases, 2);
  assert.equal(suggestions[0].example.runId, duplicate);
  assert.deepEqual(suggestions[0].matching, [{ path, concepts: ['predicate', 'struct', 'schema'] }]);
  assert.deepEqual(suggestExperiments(patch(path, '// struct predicate schema'), directory).suggestions, []);
  assert.deepEqual(suggestExperiments(patch('tests/pushdown.rs', 'checkStructPredicate(schema)'), directory).suggestions, []);
  assert.deepEqual(suggestExperiments(patch('other/src/main.rs', 'checkStructPredicate(schema)'), directory).suggestions, []);

  let order: string[] = [datafusionFixture];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/tags')) {
      return Response.json({ models: [{ name: 'fixture:latest', digest: 'model-digest', size: 1024 }] });
    }
    assert.equal(url, 'http://127.0.0.1:11434/api/generate');
    const prompt = JSON.parse(JSON.parse(String(init.body)).prompt);
    assert.deepEqual(prompt.candidates.map((item: { fixture: string }) => item.fixture), [datafusionFixture]);
    assert.equal(prompt.diff, diff);
    return Response.json({ done: true, response: JSON.stringify(order) });
  });
  const ranked = await rankExperiments(diff, 'fixture:latest', directory);
  assert.equal(ranked.method, 'ollama/v1');
  assert.equal(ranked.suggestions[0]?.example.runId, duplicate);
  assert.deepEqual(ranked.suggestions, suggestions);
  order = [];
  assert.match((await rankExperiments(diff, 'fixture:latest', directory)).reason!, /abstained/);
  order = ['invented-fixture'];
  await assert.rejects(rankExperiments(diff, 'fixture:latest', directory), /invalid or duplicate/);
});


test('local reranking can reverse the lexical order without changing saved evidence', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-ranking-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = openEvidence(cwd);
  const snapshot = { commit: probe.commit, tree: 'tree', sourcePath: 'src/vanilla.ts',
    lockSha256: 'lock', moduleSha256: 'module', module: 'saved module' };
  store.save(evidence);
  const zustand = store.save({ adapter: zustandFixture, reference: snapshot, candidate: snapshot,
    plan: ['zustand-null-update'], result: { fixture: zustandFixture, schemaVersion: 1, verdict: 'pass',
      checks: [{ id: 'zustand-null-update', expected: ['2'], reference: ['2'], candidate: ['2'], matched: true }] },
    environment: { fixture: zustandFixture, node: process.version, harnessSha256: 'harness', lockSha256: 'lock' },
  });
  store.close();

  const diff = patch('datafusion/datasource-parquet/src/row_filter.rs', 'checkStructPredicate(schema)')
    + patch('src/vanilla.ts', 'replaceStore()');
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.endsWith('/api/tags')
    ? { models: [{ name: 'fixture:latest', digest: 'model-digest', size: 1024 }] }
    : { done: true, response: JSON.stringify([zustandFixture, datafusionFixture]) }));
  const report = await rankExperiments(diff, 'fixture:latest', cwd);
  assert.deepEqual('lexicalOrder' in report && report.lexicalOrder, [datafusionFixture, zustandFixture]);
  assert.deepEqual(report.suggestions.map(item => item.fixture), [zustandFixture, datafusionFixture]);
  assert.equal(report.suggestions[0]?.example.runId, zustand);
});

test('coverage requires observed checks and rejects adjacent unsupported behavior', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-coverage-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, '.tracetern');
  const store = openEvidence(directory);
  const snapshot = { commit: probe.commit, tree: 'tree', sourcePath: 'src/utils/hash.ts',
    lockSha256: 'lock', moduleSha256: 'module', module: 'saved module' };
  const checkIds = ['equivalent-object-keys', 'distinct-array-keys'] as const;
  const cacheRun = {
    adapter: libraryFixture, reference: snapshot, candidate: snapshot,
    plan: [...checkIds],
    result: { fixture: libraryFixture, schemaVersion: 1 as const, verdict: 'pass' as const,
      checks: checkIds.map(id => ({ ...checks(id)[0]!, id })) },
    environment: { fixture: libraryFixture, node: process.version, harnessSha256: 'harness', lockSha256: 'lock' },
  } satisfies LibraryInvestigation;
  store.save(evidence);
  const original = store.save(cacheRun);
  store.save({ ...cacheRun, plan: ['equivalent-object-keys'],
    result: { ...cacheRun.result, checks: cacheRun.result.checks.slice(0, 1) } } satisfies LibraryInvestigation);
  store.close();

  const comet = patch('native/core/src/execution/operators/dynamic_filter/parquet_reader/schema_adapter.rs',
    'preserveConversionError(schema)');
  const blocked = suggestExperiments(comet, directory);
  assert.equal(blocked.targets[0]?.behavior, 'Parquet join conversion errors');
  assert.deepEqual(blocked.suggestions, []);

  const swr = patch('src/utils/hash.ts', 'return stableHash(key)');
  const suggestions = suggestExperiments(swr, directory).suggestions;
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.example.runId, original);
  assert.deepEqual(suggestions[0]?.coverage[0]?.checks, checkIds);

  const file = join(cwd, 'outside-repo.patch');
  const reportFile = join(cwd, 'weights.json');
  await writeFile(file, swr);
  await writeFile(reportFile, JSON.stringify({ schemaVersion: 1, weights: [-100, 0, 0, 0, 0] }));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'suggest', file, '--learned', reportFile, '--json'], {
    cwd, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const ranked = JSON.parse(result.stdout);
  assert.equal(ranked.method, 'learned/v1');
  assert.equal(ranked.suggestions[0]?.example.runId, original);
  assert.ok(ranked.suggestions[0]?.score < 0.5);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { datafusionFixture, openEvidence } from '../src/evidence.js';
import type { DataFusionInvestigation } from '../src/datafusion.js';
import { suggestExperiments } from '../src/retrieval.js';

const probe = {
  commit: 'a'.repeat(40), sourcePath: 'schema_rewriter.rs', pushdown: true,
  runtime: { binding: 'fixture', engine: 'fixture', python: 'fixture', arrow: 'fixture', nativeSha256: 'fixture' },
  observations: { nested: [2], pruned: 2, unoptimized: [2], inferred: [2], scalar: [2] },
};
const evidence: DataFusionInvestigation = {
  adapter: datafusionFixture, fixtureImplementation: 'fixed', reference: probe, candidate: probe,
  environment: { fixture: datafusionFixture, harnessSha256: 'fixture' },
  parquet: { sha256: 'fixture', base64: '' },
  result: { schemaVersion: 1, fixture: datafusionFixture, verdict: 'pass', checks: [] },
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
});

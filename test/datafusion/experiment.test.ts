import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openEvidence } from '../../src/evidence.js';
import { getRun } from '../../src/evidence-view.js';

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

test('real Parquet scan distinguishes wrong rows, disabled pushdown, and the upstream fix', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-datafusion-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, '.tracetern');
  function run(exitCode: number, ...args: string[]) {
    const child = spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd, encoding: 'utf8', timeout: 90_000, env: { ...process.env, PATH: '' },
    });
    assert.equal(child.status, exitCode, child.stderr + child.stdout);
    return JSON.parse(child.stdout);
  }

  for (const mode of ['broken', 'disabled', 'fixed'] as const) {
    const exitCode = mode === 'fixed' ? 0 : 1;
    const original = run(exitCode, 'datafusion', mode);
    const evidence = getRun(directory, original.runId);
    assert.equal(evidence?.fixtureImplementation, mode);
    assert.deepEqual(evidence?.checks, original.checks);
    const checks = new Map(evidence!.checks!.map(check => [check.id, check]));
    for (const control of ['unoptimized', 'scalar', 'inferred']) {
      assert.deepEqual(checks.get(control + ' control IDs')?.candidate, ['2']);
    }
    const rows = checks.get('adapted struct IDs')!;
    const pruned = checks.get('rows pruned by Parquet pushdown')!;
    assert.deepEqual(rows.reference, ['1', '2', '3']);
    assert.deepEqual(rows.candidate, mode === 'broken' ? ['1', '2', '3'] : ['2']);
    assert.equal(rows.matched, mode !== 'broken');
    assert.deepEqual(pruned.candidate, mode === 'fixed' ? ['2'] : ['0']);
    assert.equal(pruned.matched, mode === 'fixed');
    const replay = run(exitCode, 'replay', original.runId);
    assert.equal(replay.reproduced, true);
    assert.equal(replay.replayOf, original.runId);
    assert.notEqual(replay.runId, original.runId);
    assert.deepEqual(replay.checks, original.checks);

    if (mode === 'fixed') {
      const store = openEvidence(directory);
      try {
        const record = store.loadDataFusion(original.runId);
        const altered = store.save({ ...record, parquet: { ...record.parquet, base64: 'AAAA' } });
        const badArtifact = run(2, 'replay', altered);
        assert.match(badArtifact.reason, /Parquet digest mismatch/);
        assert.equal(badArtifact.reasonCode, 'artifact-invalid');
        const otherRuntime = store.save({ ...record, candidate: { ...record.candidate,
          runtime: { ...record.candidate.runtime, nativeSha256: 'changed' } } });
        const badRuntime = run(2, 'replay', otherRuntime);
        assert.match(badRuntime.reason, /recorded engines/);
        assert.equal(badRuntime.reasonCode, 'incompatible-replay');
      } finally {
        store.close();
      }
    }
  }
});

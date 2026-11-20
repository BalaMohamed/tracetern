import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, stages, type Run } from '../src/scenario.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
for (const [name, exit, counts] of [
  ['cache', 1, [101, 1, 1]],
  ['batch', 0, [2, 2, 2]],
  ['n-plus-one', 0, [101, 101, 101]],
] as const) {
  test('replay through CLI: ' + name, () => {
    const result = spawnSync(process.execPath, [cli, name, '--json'], { encoding: 'utf8', timeout: 70_000 });
    assert.equal(result.status, exit, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.reads.map((s: {candidate: number}) => s.candidate), counts);
    assert.deepEqual(report.reads.map((s: {reference: number}) => s.reference), [2,2,2]);
    if (exit === 1) {
      assert.equal(report.verdict, 'regression');
      assert.equal(report.mismatch.stage, 'after-rename');
      assert.deepEqual(report.mismatch.expected, { id: 100, customerName: 'Avery' });
      assert.deepEqual(report.mismatch.actual, { id: 100, customerName: 'Customer 1' });
    } else {
      assert.equal(report.verdict, 'pass');
      assert.equal(report.mismatch, null);
    }
  });
}

test('a broken reference cannot confirm a regression', () => {
  const broken: Run = { implementation: 'batch', postgres: 'fixture',
    observations: stages.map(stage => ({ stage, reads: 0, orders: [] })) };
  assert.throws(() => compare(broken, broken), /Reference violates/);
});

test('missing runner environment yields inconclusive', () => {
  const env = { ...process.env };
  delete env.TRACETERN_SOCKET;
  const result = spawnSync(process.execPath, [cli, 'cache', '--json'], { encoding: 'utf8', env });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).verdict, 'inconclusive');
});

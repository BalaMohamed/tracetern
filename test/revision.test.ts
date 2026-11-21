import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'dist/src/cli.js');

test('compare trusted commits, retain distinct evidence, and replay after HEAD and the checkout change', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-git-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=TraceTern Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', ...args,
  ], { cwd, encoding: 'utf8' }).trim();
  function run(status: number, ...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8', timeout: 75_000 });
    assert.equal(result.status, status, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  }
  git('init', '-q');
  await mkdir(join(cwd, 'src'));
  const path = join(cwd, 'src/orders.ts');
  const source = await readFile(join(root, 'src/orders.ts'), 'utf8');
  await writeFile(path, source);
  await writeFile(join(cwd, 'package-lock.json'), await readFile(join(root, 'package-lock.json')));
  git('add', '--', 'src/orders.ts', 'package-lock.json');
  git('commit', '-qm', 'Fixture baseline');
  const base = git('rev-parse', 'HEAD');

  const demo = run(1, 'record', 'cache');
  assert.equal(demo.plan.customerId, 1);
  assert.equal(run(1, 'replay', demo.runId).reproduced, true);

  // A genuine source change changes the implementation under the same worker input.
  const cached = source.replace('export function ordersService', 'function buildService')
    + "\nexport const ordersService = (db: Client) => buildService(db, 'cache');\n";
  await writeFile(path, cached);
  git('add', '--', 'src/orders.ts');
  git('commit', '-qm', 'Cache names between requests');
  const candidate = git('rev-parse', 'HEAD');
  const first = run(1, 'compare', base, 'HEAD');
  assert.equal(first.baseCommit, base);
  assert.equal(first.candidateCommit, candidate);
  assert.equal(first.mismatch.actual.customerName, 'Customer 1');
  assert.equal(first.mismatch.expected.customerName, 'Avery');
  assert.deepEqual(first.reads.map((r: {candidate: number}) => r.candidate), [101, 1, 1]);

  const rule = run(1, 'plan', base, candidate, 'rule');
  assert.deepEqual(rule.plan.steps, ['read','rename','read']);
  assert.equal(run(1, 'replay', rule.runId).reproduced, true);
  if (process.env.TRACETERN_TEST_MODEL) {
    const model = runPlannerTrial(process.env.TRACETERN_TEST_MODEL);
    console.log('Local planner trial', JSON.stringify({ verdict: model.verdict, plan: model.plan,
      reproduced: model.reproduced, ruleVerdict: rule.verdict }));
  }
  function runPlannerTrial(modelTag: string) {
    const trial = spawnSync(process.execPath, [cli, 'plan', base, candidate, 'ollama', modelTag, '--json'],
      { cwd, encoding: 'utf8', timeout: 160_000 });
    assert.ok(trial.status === 0 || trial.status === 1, trial.stderr + trial.stdout);
    const model = JSON.parse(trial.stdout);
    assert.ok(model.proposal.modelDigest);
    const repeated = run(trial.status, 'replay', model.runId);
    assert.equal(repeated.reproduced, true);
    return repeated;
  }

  await writeFile(path, source);
  git('add', '--', 'src/orders.ts');
  git('commit', '-qm', 'Restore batching');
  await writeFile(path, 'throw new Error("Dirty working copy must not be executed");');
  const fixed = run(0, 'compare', base, 'HEAD');
  assert.equal(fixed.verdict, 'pass');
  const verified = run(0, 'verify', rule.runId, 'HEAD');
  assert.equal(verified.verificationOf, rule.runId);
  assert.equal(verified.baseCommit, base);
  assert.equal(verified.candidateCommit, fixed.candidateCommit);
  assert.deepEqual(verified.plan, rule.plan);
  assert.equal(verified.reproduced, undefined);
  const replay = run(1, 'replay', first.runId);
  assert.equal(replay.replayOf, first.runId);
  assert.equal(replay.reproduced, true);
  assert.notEqual(replay.runId, first.runId);
  assert.equal(replay.candidateCommit, candidate);
  assert.equal(await readFile(path, 'utf8'), 'throw new Error("Dirty working copy must not be executed");');

  await writeFile(path, 'export function ordersService() { return { reads: () => 0, list: () => ({}) }; }');
  git('add', '--', 'src/orders.ts');
  git('commit', '-qm', 'Return a malformed payload');
  const malformed = run(2, 'compare', base, 'HEAD');
  assert.match(malformed.reason, /Malformed observations/);

  await writeFile(join(cwd, 'package-lock.json'), '{}');
  git('add', '--', 'package-lock.json');
  git('commit', '-qm', 'Change dependency lock');
  const incompatible = run(2, 'compare', base, 'HEAD');
  assert.equal(incompatible.verdict, 'inconclusive');
  assert.ok(incompatible.runId);
  assert.match(incompatible.reason, /dependency lock/);
  assert.match(run(2, 'replay', 'absent').reason, /Unknown investigation/);
});

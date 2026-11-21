import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEvidence } from '../src/evidence.js';

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
    return runWith(cli, status, ...args);
  }
  function runWith(entryPoint: string, status: number, ...args: string[]) {
    const result = spawnSync(process.execPath, [entryPoint, ...args, '--json'], { cwd, encoding: 'utf8', timeout: 75_000 });
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

  await writeFile(path, source.replace('reads: () => readCount', 'reads: () => 0'));
  git('add', '--', 'src/orders.ts');
  git('commit', '-qm', 'Report zero reads without changing queries');
  const counterChange = run(0, 'compare', base, 'HEAD');
  assert.equal(counterChange.callMetric, 'postgres-client-calls');
  assert.deepEqual(counterChange.reads.map((read: { candidate: number }) => read.candidate), [2, 2, 2]);

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

  const alternate = join(cwd, 'alternate-runner');
  const compiled = join(alternate, 'dist/src');
  await cp(join(root, 'dist/src'), compiled, { recursive: true });
  await mkdir(join(alternate, 'scripts'));
  await cp(join(root, 'scripts/with-postgres.sh'), join(alternate, 'scripts/with-postgres.sh'));
  await cp(join(root, 'package-lock.json'), join(alternate, 'package-lock.json'));
  await symlink(join(root, 'node_modules'), join(alternate, 'node_modules'), 'dir');

  const alternateCli = join(compiled, 'cli.js');
  await appendFile(alternateCli, '\n// CLI presentation changed.\n');
  const afterCliChange = runWith(alternateCli, 1, 'replay', rule.runId);
  assert.equal(afterCliChange.reproduced, true);
  assert.equal(afterCliChange.measurementsMatch, true);

  await writeFile(join(compiled, 'planner.js'), 'export function propose() { throw new Error("Planner must not run"); }\n');
  const afterPlannerChange = runWith(alternateCli, 1, 'replay', rule.runId);
  assert.equal(afterPlannerChange.reproduced, true);
  assert.equal(afterPlannerChange.measurementsMatch, true);
  assert.deepEqual(afterPlannerChange.plan, rule.plan);
  const alternateVerification = runWith(alternateCli, 0, 'verify', rule.runId, fixed.candidateCommit);
  assert.equal(alternateVerification.verificationOf, rule.runId);

  const store = openEvidence(join(cwd, '.tracetern'));
  try {
    const saved = store.load(rule.runId);
    const fromCli = store.load(afterCliChange.runId);
    const fromPlanner = store.load(afterPlannerChange.runId);
    assert.notEqual(fromCli.environment.harnessSha256, saved.environment.harnessSha256);
    assert.notEqual(fromPlanner.environment.harnessSha256, fromCli.environment.harnessSha256);
    assert.equal(fromPlanner.environment.replaySha256, saved.environment.replaySha256);

    if (saved.result.verdict === 'inconclusive') throw new Error(saved.result.reason);
    saved.result.reads[0]!.candidate++;
    const changedMeasurements = runWith(alternateCli, 1, 'replay', store.save(saved));
    assert.equal(changedMeasurements.reproduced, true);
    assert.equal(changedMeasurements.measurementsMatch, false);

    const legacy = store.load(rule.runId);
    delete legacy.environment.replaySha256;
    const legacyReplay = runWith(alternateCli, 2, 'replay', store.save(legacy));
    assert.match(legacyReplay.reason, /older recording requires the original runner build/);
  } finally {
    store.close();
  }

  await appendFile(join(compiled, 'scenario.js'), '\n// Replay code changed.\n');
  const changedRunner = runWith(alternateCli, 2, 'replay', rule.runId);
  assert.match(changedRunner.reason, /compatible replay code/);

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

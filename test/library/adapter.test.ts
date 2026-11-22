import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getRun, listRuns } from '../../src/evidence-view.js';
import type { LibraryResult } from '../../src/library-cases.js';
import { keyGuide } from '../../src/library-planner.js';

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const env = { ...process.env };
delete env.TRACETERN_SOCKET;

function run(cwd: string, status: number, ...args: string[]) {
  // On replay, even git and PostgreSQL launchers are absent from PATH.
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd, encoding: 'utf8', env: args[0] === 'replay' ? { ...env, PATH: '' } : env, timeout: 90_000,
  });
  assert.equal(result.status, status, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

test('library comparison retains a candidate-only lookup failure and replays without Git or PostgreSQL', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-library-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const repository = join(cwd, 'source');
  const source = join(repository, 'packages/query-core/src');
  await mkdir(source, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=TraceTern Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  await writeFile(join(repository, 'pnpm-lock.yaml'), 'importers:\n  packages/query-core:\n    dependencies: {}\n');
  const fixture = `
import { hashKey as hash } from './utils';
export class QueryClient {
  entries = new Map<string, string>();
  setQueryData(key: unknown[], data: string) { this.entries.set(hash(key), data); }
  getQueryData(key: unknown[]) { return this.entries.get(hash(key)); }
  clear() { this.entries.clear(); }
}
export function dehydrate(client: QueryClient) {
  return { queries: [...client.entries].map(([key, data]) => ({ key, data })) };
}
export function hydrate(client: QueryClient, state: ReturnType<typeof dehydrate>) {
  for (const { key, data } of state.queries) client.entries.set(key, data);
}`;
  const entry = join(source, 'index.ts');
  const utils = join(source, 'utils.ts');
  const hasher = `export function hashKey(key: unknown[]) {
  return JSON.stringify(key, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}`;
  await writeFile(entry, fixture);
  await writeFile(utils, hasher);
  await mkdir(dirname(join(repository, keyGuide)), { recursive: true });
  await writeFile(join(repository, keyGuide), 'The order of keys in objects does not matter: these are considered equal.\nArray item order matters!\n');
  git('add', '--', 'pnpm-lock.yaml', 'packages/query-core/src/index.ts', 'packages/query-core/src/utils.ts', keyGuide);
  git('commit', '-qm', 'Canonicalize object properties');
  const base = git('rev-parse', 'HEAD');
  await writeFile(utils, hasher.replace('Object.entries(value).sort(([left], [right]) => left.localeCompare(right))', 'Object.entries(value)'));
  git('add', '--', 'packages/query-core/src/utils.ts');
  git('commit', '-qm', 'Remove key canonicalization');
  const record = run(cwd, 1, 'compare-library', repository, base, 'HEAD');
  // A change matched the key contracts. Missing persistence docs and a throwing hydration
  // implementation exercise abstention and prove the unused experiment is never called.
  await writeFile(entry, fixture.replace('  return { queries:', '  throw new Error("Hydration must not run");\n  return { queries:'));
  git('add', '--', 'packages/query-core/src/index.ts');
  git('commit', '-qm', 'Fail if the unselected hydration experiment runs');
  await writeFile(join(repository, keyGuide), 'Uncommitted text must not affect planning.');
  const planned = run(cwd, 1, 'plan-library', repository, base, 'HEAD');
  assert.deepEqual(planned.plan, ['equivalent-object-keys', 'distinct-array-keys']);
  assert.equal(run(cwd, 2, 'plan-library', repository, base, base).planning.experiments.length, 0);
  await rename(repository, join(cwd, 'moved-checkout'));

  const replay = run(cwd, 1, 'replay', record.runId);
  assert.equal(replay.reproduced, true);
  assert.equal(replay.replayOf, record.runId);
  assert.deepEqual(replay.checks, record.checks);
  const plannedReplay = run(cwd, 1, 'replay', planned.runId);
  assert.equal(plannedReplay.reproduced, true);
  assert.deepEqual(plannedReplay.planning, planned.planning);
  assert.deepEqual(plannedReplay.checks, planned.checks);
  assert.deepEqual(record.checks.map(({ id, matched }: { id: string; matched: boolean }) => [id, matched]), [
    ['equivalent-object-keys', false],
    ['distinct-array-keys', true],
    ['restore-baseline-cache', true],
  ]);

  const directory = join(cwd, '.tracetern');
  const projected = getRun(directory, replay.runId);
  assert.deepEqual(projected?.checks, record.checks);
  assert.equal(projected?.observed, null);
  assert.deepEqual(getRun(directory, plannedReplay.runId)?.planning, planned.planning);
  assert.equal(listRuns(directory)[0]?.fixture, 'tanstack-query-keys/v1');
  assert.doesNotMatch(JSON.stringify(projected), /moduleSha256|entries = new Map/);
});

const upstream = process.env.TRACETERN_TANSTACK_REPO;
test('pinned TanStack Query change preserves all three public behaviors and replays without PostgreSQL', {
  skip: upstream ? false : 'Set TRACETERN_TANSTACK_REPO to a repository containing the two documented commits',
}, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-tanstack-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const base = '33fe7c476276cbefa86786bbcc2d445fdf382614';
  const candidate = 'e34066220996e1150535108646b3f24109feece7';
  const record = run(cwd, 0, 'compare-library', resolve(upstream!), base, candidate);
  assert.equal(record.baseCommit, base);
  assert.equal(record.candidateCommit, candidate);
  assert.deepEqual(record.checks.map(({ matched }: { matched: boolean }) => matched), [true, true, true]);
  const replay = run(cwd, 0, 'replay', record.runId);
  assert.equal(replay.reproduced, true);
  assert.deepEqual(replay.checks, record.checks);
});

const observerRepo = process.env.TRACETERN_OBSERVER_REPO;
test('observer experiment distinguishes a repair from a regression and replays both', {
  skip: observerRepo ? false : 'Set TRACETERN_OBSERVER_REPO to a repository containing both PR #12633 commits',
}, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-observer-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const base = '816a0aab2e904cd5364d3b0f278582eccc660318';
  const candidate = 'aab2d96e3a90f8f7515400fe3a86f9da40eb7107';
  const upstream = resolve(observerRepo!);
  const repaired = run(cwd, 0, 'plan-library', upstream, base, candidate);
  assert.deepEqual(repaired.plan, ['optimistic-query-count']);
  assert.deepEqual(repaired.checks, [{
    id: 'optimistic-query-count', expected: ['1', '1', '2', '2'], reference: ['1', '1', '2', '1'],
    candidate: ['1', '1', '2', '2'], matched: true, repaired: true,
  }]);
  assert.equal(run(cwd, 0, 'replay', repaired.runId).reproduced, true);

  const reverted = run(cwd, 1, 'plan-library', upstream, candidate, base);
  assert.equal(reverted.checks[0]?.matched, false);
  assert.equal(reverted.checks[0]?.repaired, undefined);
  assert.deepEqual(reverted.checks[0]?.candidate, ['1', '1', '2', '1']);
  assert.equal(run(cwd, 1, 'replay', reverted.runId).reproduced, true);
});

const timestampRepo = process.env.TRACETERN_TIMESTAMP_REPO;
test('dehydration timestamp distinguishes new support and catches a broken zero override on replay', {
  skip: timestampRepo ? false : 'Set TRACETERN_TIMESTAMP_REPO to a repository containing both PR #11395 commits',
}, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-timestamp-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const upstream = resolve(timestampRepo!);
  const base = '799a33cdadad19d008e57c6a60e716701860a9bd';
  const candidate = 'a97345fc7fa1d0deb0dec0a234877a59f1ce6750';
  const timestampCheck = (result: LibraryResult) =>
    result.checks.find(check => check.id === 'dehydration-timestamp');
  const result = run(cwd, 0, 'plan-library', upstream, base, candidate);
  const supported = timestampCheck(result);
  assert.deepEqual(supported, {
    id: 'dehydration-timestamp',
    expected: ['900', '900', 'clock read', '444', '444', 'clock unused', '123', '123', 'clock unused', '0', '0', 'clock unused'],
    reference: ['900', '900', 'clock read', '900', '900', 'clock read', '900', '900', 'clock read', '900', '900', 'clock read'],
    candidate: ['900', '900', 'clock read', '444', '444', 'clock unused', '123', '123', 'clock unused', '0', '0', 'clock unused'],
    matched: true, contractAdded: true,
  });
  const replay = run(cwd, 0, 'replay', result.runId);
  assert.equal(replay.reproduced, true);
  assert.deepEqual(replay.checks, result.checks);

  const repository = join(cwd, 'mutation');
  await mkdir(repository);
  const paths = ['packages/query-core/src', 'pnpm-lock.yaml', 'docs/framework/react/guides/advanced-ssr.md'];
  const archive = execFileSync('git', ['-C', upstream, 'archive', candidate, '--', ...paths], { maxBuffer: 8 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', repository], { input: archive });
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=TraceTern Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '--', ...paths);
  git('commit', '-qm', 'Capture upstream timestamp support');
  const working = git('rev-parse', 'HEAD');
  const path = 'packages/query-core/src/hydration.ts';
  const original = await readFile(join(repository, path), 'utf8');
  const broken = original.replace('options.dehydratedAt ??', 'options.dehydratedAt ||');
  assert.notEqual(broken, original);
  await writeFile(join(repository, path), broken);
  git('add', '--', path);
  git('commit', '-qm', 'Incorrectly treat zero as an absent timestamp');
  const failure = run(cwd, 1, 'plan-library', repository, working, 'HEAD');
  assert.ok(supported);
  assert.deepEqual(timestampCheck(failure), {
    id: 'dehydration-timestamp', expected: supported.expected, reference: supported.candidate,
    candidate: ['900', '900', 'clock read', '444', '444', 'clock unused', '123', '123', 'clock unused', '444', '444', 'clock unused'],
    matched: false,
  });
  const failedReplay = run(cwd, 1, 'replay', failure.runId);
  assert.equal(failedReplay.reproduced, true);
  assert.deepEqual(failedReplay.checks, failure.checks);
});

const zustandRepo = process.env.TRACETERN_ZUSTAND_REPO;
test('Zustand null update repair and reverse regression replay with the shared library runner', {
  skip: zustandRepo ? false : 'Set TRACETERN_ZUSTAND_REPO to a repository containing both PR #2213 revisions',
}, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-zustand-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const upstream = resolve(zustandRepo!);
  const base = 'f5561dfb05babb89773128d00fabda74ddd145d4';
  const candidate = '949b505a4b5414d5b249c413e9847bb0df559a42';
  const repaired = run(cwd, 0, 'compare-library', upstream, base, candidate, '--adapter', 'zustand');
  assert.equal(repaired.fixture, 'zustand-vanilla/v1');
  assert.deepEqual(repaired.checks, [{
    id: 'zustand-null-update',
    expected: ['2:kept', '1', '1', 'null', 'null'],
    reference: ['2:kept', '1', '1', '{"count":1}', '{"0":"v","1":"a","2":"l","3":"u","4":"e"}'],
    candidate: ['2:kept', '1', '1', 'null', 'null'],
    matched: true,
    repaired: true,
  }]);
  const replay = run(cwd, 0, 'replay', repaired.runId);
  assert.equal(replay.reproduced, true);
  assert.deepEqual(replay.checks, repaired.checks);
  const projected = getRun(join(cwd, '.tracetern'), replay.runId);
  assert.equal(projected?.fixture, 'zustand-vanilla/v1');
  assert.equal(projected?.sourcePath, 'src/vanilla.ts');
  assert.deepEqual(projected?.checks, repaired.checks);

  const reverted = run(cwd, 1, 'compare-library', upstream, candidate, base, '--adapter', 'zustand');
  assert.equal(reverted.checks[0]?.matched, false);
  assert.deepEqual(reverted.checks[0]?.candidate, repaired.checks[0]?.reference);
  assert.equal(run(cwd, 1, 'replay', reverted.runId).reproduced, true);
});

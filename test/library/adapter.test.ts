import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getRun, listRuns } from '../../src/evidence-view.js';
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

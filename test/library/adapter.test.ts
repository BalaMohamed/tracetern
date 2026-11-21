import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getRun, listRuns } from '../../src/evidence-view.js';

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
const hash = (key: unknown[]) => JSON.stringify(key, (_, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
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
  await writeFile(entry, fixture);
  git('add', '--', 'pnpm-lock.yaml', 'packages/query-core/src/index.ts');
  git('commit', '-qm', 'Canonicalize object properties');
  const base = git('rev-parse', 'HEAD');
  await writeFile(entry, fixture.replace('Object.entries(value).sort(([left], [right]) => left.localeCompare(right))', 'Object.entries(value)'));
  git('add', '--', 'packages/query-core/src/index.ts');
  git('commit', '-qm', 'Remove key canonicalization');
  const record = run(cwd, 1, 'compare-library', repository, base, 'HEAD');
  await rename(repository, join(cwd, 'moved-checkout'));

  const replay = run(cwd, 1, 'replay', record.runId);
  assert.equal(replay.reproduced, true);
  assert.equal(replay.replayOf, record.runId);
  assert.deepEqual(replay.checks, record.checks);
  assert.deepEqual(record.checks.map(({ id, matched }: { id: string; matched: boolean }) => [id, matched]), [
    ['equivalent-object-keys', false],
    ['distinct-array-keys', true],
    ['restore-baseline-cache', true],
  ]);

  const directory = join(cwd, '.tracetern');
  const projected = getRun(directory, replay.runId);
  assert.deepEqual(projected?.checks, record.checks);
  assert.equal(projected?.observed, null);
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

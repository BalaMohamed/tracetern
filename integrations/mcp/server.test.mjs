import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = fileURLToPath(new URL('./server.mjs', import.meta.url));

async function connect(t, repository, mode = [], env) {
  const client = new Client({ name: 'tracetern-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [server, repository, ...mode], stderr: 'pipe', env,
  });
  t.after(() => transport.close());
  await client.connect(transport);
  return client;
}

test('MCP reads a recorded case, replays it, and verifies a committed fix', { timeout: 25_000 }, async t => {
  const repository = await mkdtemp(join(tmpdir(), 'tracetern-mcp-test-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=TraceTern Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  await mkdir(join(repository, 'src'));
  const source = await readFile(join(root, 'src/orders.ts'), 'utf8');
  const servicePath = join(repository, 'src/orders.ts');
  await writeFile(servicePath, source);
  await writeFile(join(repository, 'package-lock.json'), await readFile(join(root, 'package-lock.json')));
  git('add', '--', 'src/orders.ts', 'package-lock.json');
  git('commit', '-qm', 'Record fixture');
  const recorded = spawnSync('bash', [
    join(root, 'scripts/with-postgres.sh'), process.execPath, join(root, 'dist/src/cli.js'), 'record', 'cache', '--json',
  ], { cwd: repository, encoding: 'utf8', timeout: 15_000 });
  assert.equal(recorded.status, 1, recorded.stderr + recorded.stdout);
  const { runId } = JSON.parse(recorded.stdout);

  const reader = await connect(t, repository);
  assert.deepEqual((await reader.listTools()).tools.map(tool => tool.name).sort(), ['get_run', 'list_runs']);
  const list = await reader.callTool({ name: 'list_runs', arguments: {} });
  assert.equal(list.structuredContent.runs[0].runId, runId);
  const details = await reader.callTool({ name: 'get_run', arguments: { runId } });
  const { run } = details.structuredContent;
  assert.equal(run.verdict, 'regression');
  assert.equal(run.observed.mismatch.expected.customerName, 'Avery');
  assert.equal(run.observed.reads[0].queryGroups.candidate.customer, 100);
  assert.equal(run.observed.callMetric, 'postgres-client-calls');
  assert.equal(run.sourcePath, 'src/orders.ts');
  assert.doesNotMatch(JSON.stringify(details), /moduleSha256|SELECT name|fixture@example/);
  await reader.close();

  const runner = await connect(t, repository, ['--enable-execution']);
  assert.deepEqual((await runner.listTools()).tools.map(tool => tool.name).sort(),
    ['get_run', 'list_runs', 'replay_run', 'verify_candidate']);
  const replay = await runner.callTool({ name: 'replay_run', arguments: { runId } });
  assert.ok(replay.structuredContent, JSON.stringify(replay));
  assert.equal(replay.structuredContent.reproduced, true);
  assert.equal(replay.structuredContent.measurementsMatch, true);
  assert.equal(replay.structuredContent.run.replayOf, runId);
  assert.notEqual(replay.structuredContent.run.runId, runId);

  await writeFile(servicePath, source.replace('export function ordersService', 'function buildService')
    + "\nexport const ordersService = (db: Client) => buildService(db, 'batch');\n");
  git('add', '--', 'src/orders.ts');
  git('commit', '-qm', 'Batch customer reads');
  const commit = git('rev-parse', 'HEAD');
  const verification = await runner.callTool({ name: 'verify_candidate', arguments: { runId, commit } });
  assert.ok(verification.structuredContent, JSON.stringify(verification));
  const checked = verification.structuredContent.run;
  assert.equal(checked.verificationOf, runId);
  assert.equal(checked.candidateCommit, commit);
  assert.equal(checked.verdict, 'pass');
  assert.deepEqual(checked.observed.reads.map(read => read.candidate), [2, 2, 2]);
  assert.deepEqual(checked.plan, run.plan);
  await runner.close();
});

const upstream = process.env.TRACETERN_TANSTACK_REPO;
test('MCP reads and replays pinned library evidence with an empty PATH', {
  timeout: 25_000, skip: upstream ? false : 'Set TRACETERN_TANSTACK_REPO to run the upstream library case',
}, async t => {
  const repository = await mkdtemp(join(tmpdir(), 'tracetern-mcp-library-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const recorded = spawnSync(process.execPath, [
    join(root, 'dist/src/cli.js'), 'compare-library', resolve(upstream),
    '33fe7c476276cbefa86786bbcc2d445fdf382614', 'e34066220996e1150535108646b3f24109feece7', '--json',
  ], { cwd: repository, encoding: 'utf8', timeout: 15_000 });
  assert.equal(recorded.status, 0, recorded.stderr + recorded.stdout);
  const { runId, checks } = JSON.parse(recorded.stdout);

  const runner = await connect(t, repository, ['--enable-execution'], { PATH: '' });
  const details = await runner.callTool({ name: 'get_run', arguments: { runId } });
  assert.deepEqual(details.structuredContent.run.checks, checks);
  const replay = await runner.callTool({ name: 'replay_run', arguments: { runId } });
  assert.equal(replay.structuredContent?.reproduced, true, JSON.stringify(replay));
  assert.deepEqual(replay.structuredContent.run.checks, checks);
  assert.equal(replay.structuredContent.run.replayOf, runId);
  await runner.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openEvidence, type Investigation } from '../src/evidence.js';
import type { RunEvidence, RunSummary } from '../src/evidence-view.js';

const viewer = fileURLToPath(new URL('../src/viewer.js', import.meta.url));

test('viewer serves saved and legacy evidence without source or process diagnostics', { timeout: 10_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracetern-viewer-'));
  const directory = join(cwd, '.tracetern');
  const processHandle = spawn(process.execPath, [viewer], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(processHandle, 'exit');
  const stdout = createInterface({ input: processHandle.stdout });
  t.after(async () => {
    processHandle.kill();
    await exited;
    await rm(cwd, { recursive: true, force: true });
  });
  let diagnostics = '';
  processHandle.stderr.on('data', data => { diagnostics += data; });
  const [baseUrl] = await Promise.race([
    once(stdout, 'line', { signal: t.signal }),
    exited.then(() => { throw new Error('Viewer exited before listening: ' + diagnostics); }),
  ]);
  stdout.close();
  const url = new URL(baseUrl as string);
  assert.equal(url.hostname, '127.0.0.1');
  const request = (path: string, options?: RequestInit) => fetch(new URL(path, url), options);

  assert.deepEqual(await (await request('/api/runs')).json(), { runs: [] });
  await assert.rejects(stat(directory), { code: 'ENOENT' });

  const source = {
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourcePath: 'src/orders.ts',
    lockSha256: 'lock', moduleSha256: 'module', module: 'private-fixture-source-canary',
  };
  const record: Investigation = {
    reference: source,
    candidate: source,
    environment: { fixture: 'orders-list/v1', node: process.version, harnessSha256: 'harness', lockSha256: 'lock' },
    result: { schemaVersion: 1, fixture: 'orders-list/v1', node: process.version, postgres: '17',
      reference: 'batch', candidate: 'cache', verdict: 'regression',
      reads: [{ stage: 'after-rename', reference: 2, candidate: 1, queryGroups: undefined }],
      mismatch: {
        stage: 'after-rename', position: 99,
        expected: { id: 100, customerName: 'Avery' }, actual: { id: 100, customerName: 'Customer 1' },
      } },
  };
  const store = openEvidence(directory);
  const legacy = store.save(record);
  const inconclusive = store.save({
    ...record,
    result: { schemaVersion: 1, verdict: 'inconclusive', reason: 'private-runner-diagnostic-canary' },
  });
  store.close();

  const { runs } = await (await request('/api/runs')).json() as { runs: RunSummary[] };
  assert.deepEqual(runs.map(run => run.runId), [inconclusive, legacy]);
  const saved = await (await request('/api/runs/' + legacy)).json() as RunEvidence;
  assert.equal(saved.verdict, 'regression');
  assert.deepEqual(saved.plan?.steps, ['read', 'read', 'rename', 'read']);
  assert.equal(saved.observed?.mismatch?.actual?.customerName, 'Customer 1');
  assert.equal(saved.observed?.reads[0]?.queryGroups, undefined);
  assert.equal(saved.observed?.callMetric, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /private-fixture-source-canary/);

  const failed = await (await request('/api/runs/' + inconclusive)).text();
  assert.equal(JSON.parse(failed).observed, null);
  assert.doesNotMatch(failed, /private-runner-diagnostic-canary/);

  const page = await request('/?run=' + legacy);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.match(await page.text(), /TraceTern/);
  assert.equal((await request('/view.js')).status, 200);
  assert.equal((await request('/style.css')).status, 200);
  assert.equal((await request('/api/runs', { method: 'POST' })).status, 405);
  assert.equal((await request('/api/runs/unknown')).status, 404);
});

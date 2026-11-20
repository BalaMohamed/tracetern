import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propose } from '../src/planner.js';
import type { Snapshot } from '../src/revision.js';

const reference: Snapshot = {
  commit: 'base', tree: 'base-tree', sourcePath: 'src/orders.ts', lockSha256: 'lock',
  moduleSha256: 'base-module', module: 'const current = readOrders();',
};
const candidate = { ...reference, module: reference.module + '\nconst cache = new Map();' };
const planner = { kind: 'ollama', model: 'fixture:latest' } as const;
const tags = { models: [{ name: planner.model, digest: 'fixture-digest', size: 1024 }] };

test('the rule chooses a freshness probe only for cache-like additions', async () => {
  assert.deepEqual((await propose({kind: 'rule'}, reference, reference)).experiment.steps, ['read','read']);
  assert.deepEqual((await propose({kind: 'rule'}, reference, candidate)).experiment.steps, ['read','rename','read']);
});

test('Ollama proposal carries the planning inputs and accepts a bounded experiment', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/tags')) return Response.json(tags);
    assert.equal(url, 'http://127.0.0.1:11434/api/generate');
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, planner.model);
    assert.equal(body.stream, false);
    assert.match(JSON.parse(body.prompt).added, /new Map/);
    return Response.json({done: true, response: JSON.stringify({steps: ['read','rename','read'], customerId: 73})});
  });
  const proposal = await propose(planner, reference, candidate);
  assert.equal(proposal.modelDigest, tags.models[0]!.digest);
  assert.equal(proposal.experiment.customerId, 73);
});

test('a model returning an unsupported operation cannot supply executable instructions', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.endsWith('/api/tags') ? tags :
    {done: true, response: JSON.stringify({steps: ['read','sql','read'], customerId: 1})}));
  await assert.rejects(propose(planner, reference, candidate), /read\/rename/);
});

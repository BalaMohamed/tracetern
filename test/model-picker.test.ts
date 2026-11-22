import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogForMemory } from '../src/model-catalog.js';
import { chooseModel, selectedModel } from '../src/model-picker.js';

test('the recommendation order groups variants by estimated memory fit', () => {
  const small = catalogForMemory(8, new Set(['qwen3.5:4b']));
  assert.equal(small.catalog.length, 27);
  assert.equal(small.catalog[0]?.tag, 'qwen3.5:4b');
  assert.equal(small.catalog[0]?.installed, true);
  assert.equal(small.catalog.find(entry => entry.tag === 'qwen3-coder:30b')?.fit, 'large');
  const large = catalogForMemory(32, new Set());
  assert.equal(large.catalog.find(entry => entry.tag === 'qwen3-coder:30b')?.fit, 'suggested');
});

test('picking installs an exact tag once and only persists a successful selection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await selectedModel(directory), undefined);
  const previous = { tag: 'installed:latest', size: 100, digest: 'old' };
  const catalog = { ...catalogForMemory(8, new Set()), installed: [previous] };
  let pulls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/tags')) {
      return Response.json({ models: [{ name: 'new:latest', size: 200, digest: 'new' }] });
    }
    pulls++;
    const { model } = JSON.parse(String(init.body));
    return new Response(model === 'new:latest' ? '{"status":"success"}\n' : '{"error":"model missing"}\n');
  });
  await chooseModel('installed', catalog, () => {}, directory);
  assert.equal(pulls, 0);
  assert.equal(await selectedModel(directory), previous.tag);
  assert.equal((await chooseModel('new', catalog, () => {}, directory)).tag, 'new:latest');
  assert.equal(pulls, 1);
  await assert.rejects(chooseModel('missing', catalog, () => {}, directory), /model missing/);
  assert.equal(await selectedModel(directory), 'new:latest');
});

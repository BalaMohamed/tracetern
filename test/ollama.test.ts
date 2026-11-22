import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browseModels, pullModel } from '../src/ollama.js';

const model = { name: 'qwen2.5-coder:0.5b', digest: 'fixture-digest', size: 398_000_000 };
const tags = { models: [model,
  { ...model, name: 'fixture:cloud' },
  { ...model, name: 'fixture:hosted', remote_host: 'https://example.invalid' },
] };

test('model catalog combines published choices with installed local artifacts', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return Response.json(tags);
  });
  const result = await browseModels();
  assert.deepEqual(result.installed, [{ tag: model.name, digest: model.digest, size: model.size }]);
  assert.ok(result.catalog.some(item => item.tag === model.name && item.installed));
  assert.ok(result.catalog.some(item => item.tag !== model.name && !item.installed));
});

test('pull streams progress and checks the installed artifact before returning', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/tags')) return Response.json(tags);
    assert.equal(url, 'http://127.0.0.1:11434/api/pull');
    assert.deepEqual(JSON.parse(String(init.body)), { model: model.name, stream: true });
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"status":"pulling layer","total":10,'));
        controller.enqueue(encoder.encode('"completed":5}\n{"status":"success"}\n'));
        controller.close();
      },
    });
    return new Response(body);
  });
  const updates: unknown[] = [];
  const result = await pullModel(model.name, (status, percent) => updates.push([status, percent]));
  assert.deepEqual(updates, [['pulling layer', 50], ['success', undefined]]);
  assert.equal(result.digest, model.digest);
  await assert.rejects(pullModel('fixture:cloud', () => {}), /exact local/);
});

test('a truncated pull stream cannot report a successful installation', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"status":"pulling manifest"}\n'));
  await assert.rejects(pullModel(model.name, () => {}), /before reporting success/);
});

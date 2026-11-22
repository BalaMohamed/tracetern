import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../src/execution.js';

test('times out a worker and discards its raw stderr', async () => {
  await assert.rejects(runProcess('Fixture worker', process.execPath, [
    '-e', 'console.error("private stderr"); setInterval(() => {}, 1000);',
  ], { timeout: 200, maxBuffer: 1024 }), {
    code: 'timeout', message: 'Fixture worker timed out',
  });
});

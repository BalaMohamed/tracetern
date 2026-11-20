import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationStages, validateExperiment } from '../src/experiment.js';

test('read labels follow rename state within the supplied budget', () => {
  const plan = validateExperiment({ steps: ['read','rename','read','read'], customerId: 17 });
  assert.deepEqual(observationStages(plan), ['cold','after-rename','after-rename']);
});

test('invalid operations, out-of-fixture IDs and excessive budgets are rejected', () => {
  for (const steps of [['query'], ['read','rename'], ['read','rename','rename','read'],
    ['read','sql','read'], Array(5).fill('read')]) {
    assert.throws(() => validateExperiment({ steps, customerId: 1 }));
  }
  for (const customerId of [0, 101, 1.5, '2']) {
    assert.throws(() => validateExperiment({ steps: ['read','read'], customerId }));
  }
  assert.throws(() => validateExperiment({ steps: ['read','read'], customerId: 1, sql: 'anything' }));
});

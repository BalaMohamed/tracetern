import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkInput, fitRanker, scoreOrder, type Example } from '../src/experiment-ranker.js';
import { expandCases, validateCases } from '../src/ranking-benchmark.js';

const example = {
  split: 'train' as const, repo: 'owner/first', pr: 1,
  base: 'a'.repeat(40), head: 'b'.repeat(40), diffSha256: 'd'.repeat(64),
  labels: {}, rationale: 'Public change with no relevant experiment',
};
const holdout = { ...example, split: 'test' as const, repo: 'owner/second',
  head: 'c'.repeat(40), diffSha256: 'e'.repeat(64) };

test('dataset validation rejects repository overlap and duplicate PR evidence', () => {
  assert.doesNotThrow(() => validateCases([example, holdout]));
  assert.throws(() => validateCases([example, { ...holdout, repo: 'Owner/First', pr: 2 }]), /crosses/);
  assert.throws(() => validateCases([example, { ...holdout, diffSha256: example.diffSha256 }]), /Duplicate/);
  assert.throws(() => validateCases([example, { ...holdout, head: example.head }]), /Duplicate/);
  assert.throws(() => validateCases([example, { ...holdout, labels: { unknown: 'direct' } }]), /Invalid label/);
});

test('expansion retains pilot training and rejects prior holdout repositories and patches', () => {
  const newHoldout = { ...holdout, repo: 'owner/third', head: 'f'.repeat(40), diffSha256: 'a'.repeat(64) };
  assert.deepEqual(expandCases([example, holdout], [newHoldout]), [example, newHoldout]);
  assert.throws(() => expandCases([example, holdout], [holdout]), /reuses a pilot/);
  assert.throws(() => expandCases([example, holdout], [{ ...newHoldout, diffSha256: holdout.diffSha256 }]), /reuses a pilot/);
});

test('the learned ranker fits labeled pairs deterministically and can abstain', () => {
  const training: Example[] = [
    { features: [1, 0, 0, 0], relevant: true },
    { features: [0, 1, 0, 0], relevant: false },
  ];
  const fit = fitRanker(training);
  assert.deepEqual(fit.weights, fitRanker(training).weights);
  assert.ok(fit.score([0.9, 0, 0, 0]) > 0.5);
  assert.ok(fit.score([0.1, 0.9, 0, 0]) < 0.5);
});

test('production excerpts exclude test files and the metric credits only relevant labels', () => {
  const entry = (file: string, added: string) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before()\n+${added}\n`;
  const input = benchmarkInput(entry('engine/src/main.rs', 'structPredicate()')
    + entry('engine/tests/filter.rs', 'labelTargetPruning()')
    + entry('engine/src/filters/tests.rs', 'labelTargetRustModule()')
    + entry('engine/src/filters/test_utils.rs', 'labelTargetRustHelper()'));
  assert.match(input.excerpt, /structPredicate/);
  assert.doesNotMatch(input.excerpt, /labelTarget/);
  assert.equal(scoreOrder([], {}).top, 'abstained');
  assert.equal(scoreOrder(['other'], { chosen: 'control' }).top, 'irrelevant');
  assert.equal(scoreOrder(['chosen'], { chosen: 'direct' }).ndcg, 1);
  assert.ok(scoreOrder(['other', 'chosen'], { chosen: 'direct' }).ndcg! < 1);
  const sourceOnly = benchmarkInput(entry('.changeset/context.md', 'titleContainsParquet')
    + entry('src/something.config.ts', 'configContainsPushdown')
    + entry('src/filter.rs', 'realPredicate()'), true);
  assert.deepEqual(sourceOnly.excerpts, [{ path: 'src/filter.rs', code: 'before()\nrealPredicate()' }]);
});

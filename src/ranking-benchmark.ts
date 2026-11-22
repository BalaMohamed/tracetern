import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from './revision.js';
import { experimentProfiles, rankExperimentIds } from './retrieval.js';
import { benchmarkInput, fitRanker, scoreOrder, type Grade } from './experiment-ranker.js';

interface Case {
  split: 'train' | 'test';
  repo: string;
  pr: number;
  base: string;
  head: string;
  diffSha256: string;
  labels: Record<string, Grade>;
  rationale: string;
}
const sha = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
export function validateCases(cases: Case[]) {
  const fixtures = new Set(experimentProfiles.map(item => item.fixture));
  const repos = new Map<string, Case['split']>();
  const prs = new Set<string>();
  const diffs = new Set<string>();
  const heads = new Set<string>();
  for (const item of cases) {
    const key = item.repo.toLowerCase();
    const id = key + '#' + item.pr;
    if ((item.split !== 'train' && item.split !== 'test') ||
      !/^[\w.-]+\/[\w.-]+$/.test(item.repo) || !Number.isSafeInteger(item.pr) || item.pr < 1 ||
      !sha.test(item.base) || !sha.test(item.head) || item.base === item.head ||
      !sha256.test(item.diffSha256) || !item.rationale?.trim()) throw new Error('Invalid PR record: ' + id);
    if (prs.has(id) || diffs.has(item.diffSha256) || heads.has(item.head)) throw new Error('Duplicate PR example: ' + id);
    if (repos.has(key) && repos.get(key) !== item.split) throw new Error('Repository crosses the train/test split: ' + key);
    for (const [fixture, grade] of Object.entries(item.labels)) {
      if (!fixtures.has(fixture) || (grade !== 'direct' && grade !== 'control')) throw new Error('Invalid label for ' + id);
    }
    prs.add(id);
    diffs.add(item.diffSha256);
    heads.add(item.head);
    repos.set(key, item.split);
  }
  if (new Set(repos.values()).size !== 2) throw new Error('Expected separate train and test repositories');
}

async function benchmark(model?: string) {
  const { schemaVersion, cases }: { schemaVersion: number; cases: Case[] } =
    JSON.parse(await readFile('evaluation/ranking/cases.json', 'utf8'));
  if (schemaVersion !== 1) throw new Error('Unsupported dataset version');
  validateCases(cases);

  async function inputs(item: Case) {
    const path = join('.tracetern/ranking-diffs', item.repo.replace('/', '-') + '-' + item.pr + '.diff');
    const diff = await readFile(path);
    if (digest(diff) !== item.diffSha256) throw new Error('Diff digest mismatch for ' + item.repo + '#' + item.pr);
    return benchmarkInput(diff.toString('utf8'));
  }
  const train = cases.filter(item => item.split === 'train');
  const test = cases.filter(item => item.split === 'test');
  const examples = (await Promise.all(train.map(async item => (await inputs(item)).candidates.map(candidate => ({
    features: candidate.features, relevant: item.labels[candidate.fixture] !== undefined,
  }))))).flat();
  const ranker = fitRanker(examples);
  let modelDigest: string | undefined;
  const rows: (Pick<Case, 'repo' | 'pr' | 'labels'> & { orders: Record<string, string[]> })[] = [];
  for (const item of test) {
    const { excerpt, candidates } = await inputs(item);
    const ordered = (score: (candidate: typeof candidates[number]) => number, threshold: number) => candidates
      .map(candidate => ({ fixture: candidate.fixture, score: score(candidate) }))
      .filter(candidate => candidate.score >= threshold)
      .sort((left, right) => right.score - left.score || left.fixture.localeCompare(right.fixture))
      .map(candidate => candidate.fixture);
    const orders: Record<string, string[]> = {
      keyword: ordered(candidate => candidate.keywordScore, 2),
      learned: ordered(candidate => ranker.score(candidate.features), 0.5),
    };
    if (model) {
      const options = candidates.map(({ fixture, scope }) => ({ fixture, scope }));
      const start = performance.now();
      try {
        const ranked = await rankExperimentIds(excerpt, model, options);
        if (modelDigest && modelDigest !== ranked.modelDigest) throw new Error('Ollama model changed during trial');
        modelDigest = ranked.modelDigest;
        orders.ollama = ranked.order;
      } catch (error) {
        throw new Error('Ollama failed on ' + item.repo + '#' + item.pr, { cause: error });
      }
      process.stderr.write('Ollama ' + item.repo + '#' + item.pr + ' ' + Math.round(performance.now() - start) + 'ms\n');
    }
    rows.push({ repo: item.repo, pr: item.pr, labels: item.labels, orders });
  }
  const metrics = Object.fromEntries(Object.keys(rows[0]!.orders).map(method => {
    const scores = rows.map(row => scoreOrder(row.orders[method]!, row.labels));
    const relevant = scores.filter(score => score.hasUseful);
    return [method, {
      usefulAt1: scores.filter(score => score.top === 'direct' || score.top === 'control').length,
      irrelevantAt1: scores.filter(score => score.top === 'irrelevant').length,
      abstentions: scores.filter(score => score.top === 'abstained').length,
      correctAbstentions: scores.filter(score => score.top === 'abstained' && !score.hasUseful).length,
      meanNdcgOnUsefulCases: relevant.length ? relevant.reduce((sum, score) => sum + score.ndcg!, 0) / relevant.length : null,
    }];
  }));
  return { schemaVersion, trainingCases: train.length, trainingPairs: examples.length,
    testCases: test.length, weights: ranker.weights, model, modelDigest, metrics, cases: rows };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--ollama' && args[1])) {
      throw new Error('Usage: npm run evaluate:ranking -- [--ollama <tag>]');
    }
    console.log(JSON.stringify(await benchmark(args[1]), null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}

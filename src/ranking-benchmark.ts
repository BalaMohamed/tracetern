import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { digest } from './revision.js';
import { buildCoverageShortlist, coverageTargets, keepCovered, type RecordedCoverage } from './coverage.js';
import { experimentProfiles, productionChanges, rankExperimentIds } from './retrieval.js';
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

const datasets = ['pilot', 'expanded', 'coverage', 'shortlist', 'beta'] as const;
type Dataset = (typeof datasets)[number];

function isDataset(value: string | undefined): value is Dataset {
  return datasets.some(dataset => dataset === value);
}

export function expandCases(pilot: Case[], additions: Case[]) {
  validateCases(pilot);
  const priorRepos = new Set(pilot.map(item => item.repo.toLowerCase()));
  const priorHeads = new Set(pilot.map(item => item.head));
  const priorDiffs = new Set(pilot.map(item => item.diffSha256));
  const cases = [...pilot.filter(item => item.split === 'train'), ...additions];
  for (const item of additions) {
    if (priorRepos.has(item.repo.toLowerCase()) || priorHeads.has(item.head) || priorDiffs.has(item.diffSha256)) {
      throw new Error('Expanded dataset reuses a pilot repository or PR: ' + item.repo + '#' + item.pr);
    }
  }
  validateCases(cases);
  return cases;
}

async function readCases(path: string) {
  const { schemaVersion, cases }: { schemaVersion: number; cases: Case[] } =
    JSON.parse(await readFile(path, 'utf8'));
  if (schemaVersion !== 1) throw new Error('Unsupported dataset schema: ' + path);
  return cases;
}

async function benchmark(dataset: Dataset, model?: string) {
  const started = performance.now();
  const pilot = await readCases('evaluation/ranking/cases.json');
  let cases = pilot;
  if (dataset !== 'pilot') {
    cases = expandCases(pilot, await readCases('evaluation/ranking/cases-expanded.json'));
  }
  if (dataset !== 'pilot' && dataset !== 'expanded') {
    let prior = [...cases, ...pilot.filter(item => item.split === 'test')];
    for (const next of ['coverage', 'shortlist', 'beta'] as const) {
      const additions = await readCases('evaluation/ranking/cases-' + next + '.json');
      cases = expandCases(prior, additions);
      if (next === dataset) break;
      prior = [...prior, ...additions];
    }
  }
  validateCases(cases);

  async function inputs(item: Case) {
    const path = join('.tracetern/ranking-diffs', item.repo.replace('/', '-') + '-' + item.pr + '.diff');
    const diff = await readFile(path);
    if (digest(diff) !== item.diffSha256) throw new Error('Diff digest mismatch for ' + item.repo + '#' + item.pr);
    const patch = diff.toString('utf8');
    const bounded = dataset === 'beta' && item.split === 'test';
    const input = benchmarkInput(patch, bounded);
    const changes = bounded
      ? new Map(input.excerpts.map(({ path, code }) => [path, code.split('\n')]))
      : productionChanges(patch);
    return { ...input, targets: coverageTargets(changes) };
  }
  const train = cases.filter(item => item.split === 'train');
  const test = cases.filter(item => item.split === 'test');
  const examples = (await Promise.all(train.map(async item => (await inputs(item)).candidates.map(candidate => ({
    features: candidate.features, relevant: item.labels[candidate.fixture] !== undefined,
  }))))).flat();
  const ranker = fitRanker(examples);
  const bank: { schemaVersion: number; records: RecordedCoverage[] } | undefined = dataset === 'shortlist' || dataset === 'beta'
    ? JSON.parse(await readFile('evaluation/ranking/saved-coverage.json', 'utf8')) : undefined;
  if (bank && bank.schemaVersion !== 1) throw new Error('Unsupported saved coverage schema');
  let modelDigest: string | undefined;
  const rows: (Pick<Case, 'repo' | 'pr' | 'labels'> & {
    orders: Record<string, string[]>;
    selectionMs?: Record<string, number>;
    ollamaRequests?: number;
  })[] = [];
  for (const item of test) {
    const { excerpt, candidates, targets } = await inputs(item);
    const timings: Record<string, number> = {};
    function measure<T>(method: string, work: () => T): T {
      const start = performance.now();
      const value = work();
      timings[method] = performance.now() - start;
      return value;
    }
    const shortlist = bank ? measure('coverageShortlist', () => buildCoverageShortlist(bank.records, targets)) : undefined;
    const eligible = candidates.filter(candidate => shortlist?.has(candidate.fixture));
    const ordered = (pool: typeof candidates, score: (candidate: typeof candidates[number]) => number,
        threshold = -Infinity) => pool
      .map(candidate => ({ fixture: candidate.fixture, score: score(candidate) }))
      .filter(candidate => candidate.score >= threshold)
      .sort((left, right) => right.score - left.score || left.fixture.localeCompare(right.fixture))
      .map(candidate => candidate.fixture);
    const orders: Record<string, string[]> = {
      keyword: measure('keyword', () => ordered(candidates, candidate => candidate.keywordScore, 2)),
      learned: measure('learned', () => ordered(candidates, candidate => ranker.score(candidate.features), 0.5)),
    };
    if (shortlist) {
      if (dataset === 'beta') {
        orders.recordedCoverage = measure('recordedCoverage', () =>
          ordered(eligible, candidate => shortlist.get(candidate.fixture)!.coverage.length));
      }
      orders.keywordShortlist = measure('keywordShortlist', () => ordered(eligible, candidate => candidate.keywordScore));
      orders.learnedShortlist = measure('learnedShortlist', () => ordered(eligible, candidate => ranker.score(candidate.features)));
    }
    let ollamaRequests = 0;
    if (model) {
      const start = performance.now();
      async function ollama(options: Parameters<typeof rankExperimentIds>[2]) {
        if (!options.length) return [];
        ollamaRequests++;
        const ranked = await rankExperimentIds(excerpt, model!, options);
        if (modelDigest && modelDigest !== ranked.modelDigest) throw new Error('Ollama model changed during trial');
        modelDigest = ranked.modelDigest;
        return ranked.order;
      }
      try {
        orders.ollama = await ollama(candidates.map(({ fixture, scope }) => ({ fixture, scope })));
        timings.ollama = performance.now() - start;
        if (shortlist) {
          const options = eligible.map(({ fixture, scope }) => ({ fixture, scope, coverage: shortlist.get(fixture)!.coverage }));
          const shortlistStart = performance.now();
          orders.ollamaShortlist = await ollama(options);
          timings.ollamaShortlist = performance.now() - shortlistStart;
        }
      } catch (error) {
        throw new Error('Ollama failed on ' + item.repo + '#' + item.pr, { cause: error });
      }
      process.stderr.write('Ollama ' + item.repo + '#' + item.pr + ' ' + Math.round(performance.now() - start) + 'ms\n');
    }
    if (dataset === 'coverage') {
      for (const [method, order] of Object.entries(orders)) {
        orders[method + 'Covered'] = keepCovered(order, targets);
      }
    }
    rows.push({ repo: item.repo, pr: item.pr, labels: item.labels, orders,
      ...(dataset === 'beta' ? { selectionMs: timings, ollamaRequests } : {}),
    });
  }
  const metrics = Object.fromEntries(Object.keys(rows[0]!.orders).map(method => {
    const scores = rows.map(row => scoreOrder(row.orders[method]!, row.labels));
    const relevant = scores.filter(score => score.hasUseful);
    return [method, {
      usefulAt1: scores.filter(score => score.top === 'direct' || score.top === 'control').length,
      ...(dataset === 'beta' ? {
        directAt1: scores.filter(score => score.top === 'direct').length,
        controlAt1: scores.filter(score => score.top === 'control').length,
        missedUsefulAt1: scores.filter(score => score.hasUseful && score.top !== 'direct' && score.top !== 'control').length,
      } : {}),
      irrelevantAt1: scores.filter(score => score.top === 'irrelevant').length,
      abstentions: scores.filter(score => score.top === 'abstained').length,
      correctAbstentions: scores.filter(score => score.top === 'abstained' && !score.hasUseful).length,
      meanNdcgOnUsefulCases: relevant.length ? relevant.reduce((sum, score) => sum + score.ndcg!, 0) / relevant.length : null,
    }];
  }));
  return { schemaVersion: 1, dataset, trainingCases: train.length, trainingPairs: examples.length,
    testCases: test.length, weights: ranker.weights, model, modelDigest, metrics, cases: rows,
    ...(dataset === 'beta' ? {
      evaluatorResources: {
        wallMs: performance.now() - started,
        maxRssKiB: process.resourceUsage().maxRSS,
        ollamaRequests: rows.reduce((sum, row) => sum + (row.ollamaRequests ?? 0), 0),
      },
    } : {}),
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { dataset: { type: 'string', default: 'pilot' }, ollama: { type: 'string' } } });
    if (!isDataset(values.dataset)) {
      throw new Error('Dataset must be one of: ' + datasets.join(', '));
    }
    console.log(JSON.stringify(await benchmark(values.dataset, values.ollama), null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}

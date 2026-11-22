import { datafusionFixture } from './evidence.js';
import { getRun, retrievalRuns, type RunEvidence } from './evidence-view.js';
import { libraryFixture, zustandFixture } from './library-cases.js';

const contracts = {
  'Parquet row filtering': { fixture: datafusionFixture,
    checks: ['adapted struct IDs', 'rows pruned by Parquet pushdown'] },
  'cache key identity': { fixture: libraryFixture, checks: ['equivalent-object-keys', 'distinct-array-keys'] },
  'query observer updates': { fixture: libraryFixture, checks: ['optimistic-query-count'] },
  'dehydration timestamp': { fixture: libraryFixture, checks: ['dehydration-timestamp'] },
  'vanilla store notifications and replacement': { fixture: zustandFixture, checks: ['zustand-null-update'] },
  'Orders response freshness and database calls': { fixture: 'orders-list/v1', checks: [] },
} as const;

type SupportedBehavior = keyof typeof contracts;
type Behavior = SupportedBehavior | 'Parquet join conversion errors' | 'dynamic Parquet filtering' | 'Parquet Bloom filters';
export type CoverageTarget = { behavior: Behavior; path: string; fixture?: string; checks: readonly string[] };

export function coverageTargets(files: ReadonlyMap<string, readonly string[]>): CoverageTarget[] {
  const targets = new Map<Behavior, CoverageTarget>();
  function add(behavior: Behavior, path: string) {
    const contract = Object.hasOwn(contracts, behavior) ? contracts[behavior as SupportedBehavior] : undefined;
    if (!targets.has(behavior)) targets.set(behavior, { behavior, path, fixture: contract?.fixture, checks: contract?.checks ?? [] });
  }
  for (const [path, lines] of files) {
    if (!lines.length) continue;
    const code = lines.join('\n');
    const parquet = /parquet|physical-expr-adapter/i.test(path);
    if (parquet && /bloom|\bsbbf\b/i.test(path + ' ' + code)) {
      add('Parquet Bloom filters', path);
    } else if (parquet && /(?:dynamic_filter|hash_join)/i.test(path)) {
      add(/schema_adapter|conversion|overflow|unsupported|schema\w*error/i.test(path + ' ' + code)
        ? 'Parquet join conversion errors' : 'dynamic Parquet filtering', path);
    } else if (parquet && (/predicate|row[_ ]?filter|pushdown/i.test(code) ||
        (/projection_read_plan/i.test(path) && /struct|field_path/i.test(code)))) {
      add('Parquet row filtering', path);
    }
    const structuralHash = /(?:constructor\s*=+\s*Array|Array\.isArray)/.test(code) &&
      /(?:constructor\s*=+\s*Object|Object\.keys)/.test(code);
    if (structuralHash || (/\b(?:stableHash|hashKey)\b/.test(code) && /(?:hash|serializ|utils)\.[jt]sx?$/i.test(path))) {
      add('cache key identity', path);
    }
    if (/\/query-core\/src\/queriesObserver\.[jt]s$/.test(path)) add('query observer updates', path);
    if (/\/query-core\/src\/hydration\.[jt]s$/.test(path) && /dehydratedAt/.test(code)) add('dehydration timestamp', path);
    if (/(?:^|\/)src\/vanilla\.[jt]s$/.test(path) && /setState|replaceStore|subscribe|unsubscribe/.test(code)) {
      add('vanilla store notifications and replacement', path);
    }
    if (/(?:^|\/)src\/orders\.ts$/.test(path) && /cache|batch|customer|name/.test(code)) {
      add('Orders response freshness and database calls', path);
    }
  }
  return [...targets.values()];
}

export interface RecordedCoverage {
  runId: string;
  fixture: string;
  verdict: RunEvidence['verdict'];
  passedChecks: string[];
  measuredOrders: boolean;
}

export function readRecordedCoverage(directory: string): RecordedCoverage[] {
  return retrievalRuns(directory).flatMap(summary => {
    const run = getRun(directory, summary.runId);
    return run ? [{
      runId: run.runId, fixture: run.fixture, verdict: run.verdict,
      passedChecks: run.checks?.filter(check => check.matched).map(check => check.id) ?? [],
      measuredOrders: run.verdict === 'pass' && run.observed?.callMetric === 'postgres-client-calls',
    }] : [];
  });
}

export function buildCoverageShortlist(records: readonly RecordedCoverage[], targets: readonly CoverageTarget[]) {
  const shortlist = new Map<string, { record: RecordedCoverage; coverage: CoverageTarget[] }>();
  for (const record of records) {
    const coverage = targets.filter(target => target.fixture === record.fixture && (target.checks.length
      ? target.checks.every(check => record.passedChecks.includes(check))
      : record.measuredOrders));
    if (coverage.length === 0) continue;
    const previous = shortlist.get(record.fixture);
    if (!previous || coverage.length > previous.coverage.length ||
        (coverage.length === previous.coverage.length && record.verdict === 'pass' && previous.record.verdict !== 'pass')) {
      shortlist.set(record.fixture, { record, coverage });
    }
  }
  return shortlist;
}

export function keepCovered(order: readonly string[], targets: readonly CoverageTarget[]) {
  return order.filter(fixture => targets.some(target => target.fixture === fixture));
}

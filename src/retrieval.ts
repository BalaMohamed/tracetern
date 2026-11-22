import { datafusionFixture } from './evidence.js';
import { libraryFixture, zustandFixture } from './library-cases.js';
import { retrievalRuns } from './evidence-view.js';

const profiles = [
  { fixture: datafusionFixture, paths: /(?:datasource-parquet|physical-expr-adapter)\/src\//,
    concepts: ['pushdown', 'predicate', 'struct', 'schema', 'filter', 'projection', 'parquet'],
    scope: 'Compare scalar and nested struct filters across declared and inferred schemas. Check returned IDs and rows pruned inside the Parquet scan.' },
  { fixture: libraryFixture, paths: /packages\/query-core\/src\//,
    concepts: ['cache', 'query', 'hash', 'hydrate', 'observer', 'timestamp'],
    scope: 'Replay the saved Query Core checks. The run lists the exact cache, hydration or observer behaviors exercised.' },
  { fixture: zustandFixture, paths: /(?:^|\/)src\/vanilla\.ts$/,
    concepts: ['store', 'state', 'null', 'subscribe', 'merge', 'replace'],
    scope: 'Check null replacement, shallow merge, subscriber notification and unsubscribe in a vanilla store.' },
  { fixture: 'orders-list/v1', paths: /(?:^|\/)src\/orders\.ts$/,
    concepts: ['orders', 'customer', 'cache', 'batch', 'rename', 'freshness', 'query'],
    scope: 'Compare ordered responses and PostgreSQL client calls before and after a customer rename.' },
];

function changedFiles(diff: string) {
  const files = new Map<string, Set<string>>();
  let words: Set<string> | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('--- ')) {
      words = undefined;
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').split('\t')[0]!;
      if (path === '/dev/null' || /(?:^|\/)(?:test|tests|test_files|__tests__|docs)(?:\/|$)|\.(?:test|spec)\./.test(path)) continue;
      words = new Set();
      files.set(path, words);
    } else if (words && /^[+-]/.test(line)) {
      const code = line.slice(1).trimStart();
      if (/^(?:\/\/|\/\*|\*)/.test(code)) continue;
      const terms = code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z]+/g) ?? [];
      for (const term of terms) words.add(term);
    }
  }
  return files;
}

export function suggestExperiments(diff: string, directory = '.tracetern') {
  const files = changedFiles(diff);
  const runs = retrievalRuns(directory);
  const suggestions = profiles.flatMap(profile => {
    const matching = [...files].filter(([path]) => profile.paths.test(path)).flatMap(([path, words]) => {
      const concepts = profile.concepts.filter(concept => words.has(concept));
      return concepts.length >= 2 ? [{ path, concepts }] : [];
    });
    const cases = runs.filter(run => run.fixture === profile.fixture);
    const exemplar = cases.find(run => run.verdict === 'pass') ?? cases[0];
    if (!exemplar || matching.length === 0) return [];
    const score = new Set(matching.flatMap(match => match.concepts)).size;
    return [{ fixture: profile.fixture, scope: profile.scope, score, matching,
      distinctCases: cases.length, example: exemplar }];
  }).sort((left, right) => right.score - left.score || left.fixture.localeCompare(right.fixture));
  return {
    schemaVersion: 1,
    method: 'lexical/v1',
    suggestions,
    reason: suggestions.length ? null : 'No completed saved experiment matched the changed paths and code terms.',
  };
}

import type { LibraryCase } from './library-cases.js';

export const plannerVersion = 'diff-and-docs/v1';
export const keyGuide = 'docs/framework/react/guides/query-keys.md';
export const persistenceGuide = 'docs/framework/react/plugins/persistQueryClient.md';
export const observerGuide = 'docs/framework/react/reference/functions/useQueries.md';
export const timestampGuide = 'docs/framework/react/guides/advanced-ssr.md';
export const plannerPaths = ['packages/query-core/src', 'packages/query-persist-client-core/src'];

type Citation = { path: string; line: number; revision: 'base' | 'candidate'; excerpt: string };
export interface LibraryPlanning {
  version: typeof plannerVersion;
  experiments: { id: LibraryCase; change: Citation; contract: Citation }[];
}

function matchingChange(diff: string, paths: RegExp, pattern: RegExp): Citation | undefined {
  let path = '';
  let before = 0;
  let after = 0;
  let context = '';
  for (const line of diff.split('\n')) {
    const file = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (file) {
      path = file[2]!;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      context = hunk[3]!;
      continue;
    }
    if (/^[+-](?!\+\+ |-- )/.test(line)) {
      const added = line.startsWith('+');
      const position = added ? after++ : before++;
      if (paths.test(path) && (pattern.test(line) || pattern.test(context))) {
        return { path, line: position, revision: added ? 'candidate' : 'base', excerpt: line.slice(0, 240) };
      }
    } else if (line.startsWith(' ')) {
      before++;
      after++;
    }
  }
}

export function selectLibraryExperiments(diff: string, docs: ReadonlyMap<string, string>, candidateDocs?: ReadonlyMap<string, string>): LibraryPlanning {
  const hashes = matchingChange(diff, /^packages\/query-core\/src\/(?:utils|queryClient|queryCache)\.ts$/,
    /\b(?:hashKey|queryHash|stableHash|queryKeyHashFn|hashQueryKeyByOptions)\b/);
  const hydration = matchingChange(diff,
    /^packages\/(?:query-core\/src\/(?:hydration|utils)\.ts|query-persist-client-core\/src\/persist\.ts)$/,
    /\b(?:hydrate|dehydrate|queryHash|hashKey|persistQueryClientRestore)\b/);
  const observers = matchingChange(diff, /^packages\/query-core\/src\/queriesObserver\.ts$/,
    /\b(?:combineResult|notify|getOptimisticResult|observerMatches)\b/);
  const timestamps = matchingChange(diff, /^packages\/query-core\/src\/hydration\.ts$/, /\bdehydratedAt\b/);
  const experiments: LibraryPlanning['experiments'] = [];

  function add(id: LibraryCase, change: Citation | undefined, path: string, promise: RegExp, allowNewContract = false) {
    if (!change) return;
    const findContract = (text: string | undefined, revision: Citation['revision']): Citation | undefined => {
      const lines = text?.split('\n') ?? [];
      const index = lines.findIndex(line => promise.test(line));
      if (index >= 0) return { path, line: index + 1, revision, excerpt: lines[index]!.trim().slice(0, 240) };
    };
    const contract = findContract(docs.get(path), 'base') ??
      (allowNewContract ? findContract(candidateDocs?.get(path), 'candidate') : undefined);
    if (contract) experiments.push({ id, change, contract });
  }

  add('equivalent-object-keys', hashes, keyGuide, /order of keys in objects.*considered equal/i);
  add('distinct-array-keys', hashes, keyGuide, /array item order matters/i);
  add('restore-baseline-cache', hydration, persistenceGuide, /hydrate.*previously persisted.*cache/i);
  add('optimistic-query-count', observers, observerGuide, /combine.*the results of the queries/i);
  add('dehydration-timestamp', timestamps, timestampGuide, /pass it as `dehydratedAt`.*without reading the current time/i, true);
  return { version: plannerVersion, experiments };
}

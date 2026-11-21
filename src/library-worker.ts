import { readFile } from 'node:fs/promises';
import { expectedLookups, type LibraryLookups } from './library-cases.js';

type Key = readonly unknown[];
interface Client {
  setQueryData(key: Key, value: string, options?: { updatedAt: number }): void;
  getQueryData(key: Key): string | undefined;
  clear(): void;
}
interface CacheState {
  queries: { dehydratedAt?: number }[];
}
interface QueryCore {
  QueryClient: new (options: { defaultOptions: { queries: { gcTime: number } } }) => Client;
  dehydrate(client: Client): CacheState;
  hydrate(client: Client, state: CacheState): void;
}

const [entry, baselineFile] = process.argv.slice(2);
if (!entry) throw new Error('Missing library artifact');
const core: QueryCore = await import(entry);
const createClient = () => new core.QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
const lookup = (client: Client, key: Key) => client.getQueryData(key) ?? null;

const cache = createClient();
const restored = createClient();
try {
  cache.setQueryData(['orders', { status: 'open', page: 2 }], expectedLookups['equivalent-object-keys'][0]);
  const equivalent = lookup(cache, ['orders', { page: 2, status: 'open' }]);
  cache.setQueryData(['orders', 'open', 2], expectedLookups['distinct-array-keys'][0]);
  cache.setQueryData(['orders', 2, 'open'], expectedLookups['distinct-array-keys'][1]);
  const distinct = [lookup(cache, ['orders', 'open', 2]), lookup(cache, ['orders', 2, 'open'])];

  let state: CacheState;
  if (baselineFile) {
    state = JSON.parse(await readFile(baselineFile, 'utf8'));
  } else {
    const source = createClient();
    try {
      const updatedAt = 1_700_000_000_000;
      source.setQueryData(['persisted', { status: 'open' }], expectedLookups['restore-baseline-cache'][0], { updatedAt });
      state = core.dehydrate(source);
      // Fix the snapshot clock so replay uses the same serialized input.
      for (const query of state.queries) query.dehydratedAt = updatedAt + 1;
      state = JSON.parse(JSON.stringify(state));
    } finally {
      source.clear();
    }
  }
  core.hydrate(restored, state);
  const observations: LibraryLookups = {
    'equivalent-object-keys': [equivalent],
    'distinct-array-keys': distinct,
    'restore-baseline-cache': [lookup(restored, ['persisted', { status: 'open' }])],
  };
  process.stdout.write(JSON.stringify({ observations, snapshot: baselineFile ? undefined : state }));
} finally {
  cache.clear();
  restored.clear();
}

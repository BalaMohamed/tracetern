import { readFile } from 'node:fs/promises';
import { expectedLookups, validateLibraryPlan, type LibraryLookups } from './library-cases.js';

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

const [entry, savedPlan, baselineFile] = process.argv.slice(2);
if (!entry || !savedPlan) throw new Error('Missing library artifact or experiment plan');
const plan = validateLibraryPlan(JSON.parse(savedPlan));
const core: QueryCore = await import(entry);
const createClient = () => new core.QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
const lookup = (client: Client, key: Key) => client.getQueryData(key) ?? null;

function seedSnapshot(client: Client): CacheState {
  const updatedAt = 1_700_000_000_000;
  client.setQueryData(['persisted', { status: 'open' }], expectedLookups['restore-baseline-cache'][0], { updatedAt });
  const state = core.dehydrate(client);
  // Fix the snapshot clock so replay uses the same serialized input.
  for (const query of state.queries) query.dehydratedAt = updatedAt + 1;
  return JSON.parse(JSON.stringify(state));
}

const observations: LibraryLookups = {};
let snapshot: CacheState | undefined;
for (const id of plan) {
  const cache = createClient();
  try {
    switch (id) {
      case 'equivalent-object-keys':
        cache.setQueryData(['orders', { status: 'open', page: 2 }], expectedLookups[id][0]);
        observations[id] = [lookup(cache, ['orders', { page: 2, status: 'open' }])];
        break;
      case 'distinct-array-keys':
        cache.setQueryData(['orders', 'open', 2], expectedLookups[id][0]);
        cache.setQueryData(['orders', 2, 'open'], expectedLookups[id][1]);
        observations[id] = [lookup(cache, ['orders', 'open', 2]), lookup(cache, ['orders', 2, 'open'])];
        break;
      case 'restore-baseline-cache': {
        snapshot = baselineFile ? undefined : seedSnapshot(cache);
        const state = snapshot ?? JSON.parse(await readFile(baselineFile!, 'utf8'));
        cache.clear();
        core.hydrate(cache, state);
        observations[id] = [lookup(cache, ['persisted', { status: 'open' }])];
        break;
      }
    }
  } finally {
    cache.clear();
  }
}
process.stdout.write(JSON.stringify({ observations, snapshot }));

import { readFile } from 'node:fs/promises';
import { expectedLookups, validateLibraryPlan, type LibraryLookups } from './library-cases.js';

type Key = readonly unknown[];
interface Client {
  setQueryData(key: Key, value: string, options?: { updatedAt: number }): void;
  getQueryData(key: Key): string | undefined;
  clear(): void;
  getQueryCache(): { find(filter: { queryKey: Key }): { promise?: Promise<unknown> } | undefined };
}
type QueryOptions = { queryKey: Key; queryFn: () => Promise<string> };
type CombineCount = (results: unknown[]) => number;
type DehydrateOptions = { dehydratedAt: number };
interface Observer {
  subscribe(listener: () => void): () => void;
  setQueries(queries: QueryOptions[], options: { combine: CombineCount }): void;
  getOptimisticResult(queries: QueryOptions[], combine: CombineCount): [unknown[], (results: unknown[]) => number];
}
interface CacheState {
  queries: { dehydratedAt?: number }[];
}
interface QueryCore {
  QueryClient: new (options: { defaultOptions: { queries: { gcTime: number }; dehydrate?: DehydrateOptions } }) => Client;
  QueriesObserver: new (client: Client, queries: QueryOptions[], options: { combine: CombineCount }) => Observer;
  dehydrate(client: Client, options?: DehydrateOptions): CacheState;
  hydrate(client: Client, state: CacheState): void;
}

const [entry, savedPlan, baselineFile] = process.argv.slice(2);
if (!entry || !savedPlan) throw new Error('Missing library artifact or experiment plan');
const plan = validateLibraryPlan(JSON.parse(savedPlan));
const core: QueryCore = await import(entry);
const createClient = (dehydrate?: DehydrateOptions) =>
  new core.QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, dehydrate } });
const lookup = (client: Client, key: Key) => client.getQueryData(key) ?? null;

function seedSnapshot(client: Client): CacheState {
  const updatedAt = 1_700_000_000_000;
  client.setQueryData(['persisted', { status: 'open' }], expectedLookups['restore-baseline-cache'][0], { updatedAt });
  const state = core.dehydrate(client);
  // Fix the snapshot clock so replay uses the same serialized input.
  for (const query of state.queries) query.dehydratedAt = updatedAt + 1;
  return JSON.parse(JSON.stringify(state));
}

async function observeQueryCount(expanded: boolean): Promise<string[]> {
  const client = createClient();
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const initial = [{ queryKey: ['first'], queryFn: () => pending }];
  const requested = expanded ? [...initial, { queryKey: ['second'], queryFn: async () => 'second' }] : initial;
  const combine: CombineCount = results => results.length;
  const observer = new core.QueriesObserver(client, initial, { combine });
  const stop = observer.subscribe(() => {});
  try {
    observer.setQueries(initial, { combine });
    const count = () => {
      const [raw, combined] = observer.getOptimisticResult(requested, combine);
      return String(combined(raw));
    };
    const before = count();
    const inFlight = client.getQueryCache().find({ queryKey: initial[0]!.queryKey })?.promise;
    if (!inFlight) throw new Error('Observer fixture did not start a query');
    finish('resolved');
    await inFlight;
    if (client.getQueryData(initial[0]!.queryKey) !== 'resolved') throw new Error('Observer fixture query did not settle');
    return [before, count()];
  } finally {
    stop();
    client.clear();
  }
}

function observeTimestamp(clientDefault?: number, override?: number): (string | null)[] {
  const client = createClient(clientDefault === undefined ? undefined : { dehydratedAt: clientDefault });
  const now = Date.now;
  let readClock = false;
  try {
    client.setQueryData(['posts'], 'posts', { updatedAt: 55 });
    client.setQueryData(['comments'], 'comments', { updatedAt: 56 });
    Date.now = () => {
      readClock = true;
      return 900;
    };
    const { queries } = core.dehydrate(client, override === undefined ? undefined : { dehydratedAt: override });
    const timestamps = queries.map(({ dehydratedAt }) => typeof dehydratedAt === 'number' ? String(dehydratedAt) : null);
    return [...timestamps, readClock ? 'clock read' : 'clock unused'];
  } finally {
    Date.now = now;
    client.clear();
  }
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
      case 'optimistic-query-count':
        observations[id] = [...await observeQueryCount(false), ...await observeQueryCount(true)];
        break;
      case 'dehydration-timestamp':
        observations[id] = [
          ...observeTimestamp(), ...observeTimestamp(444),
          ...observeTimestamp(444, 123), ...observeTimestamp(444, 0),
        ];
        break;
    }
  } finally {
    cache.clear();
  }
}
process.stdout.write(JSON.stringify({ observations, snapshot }));

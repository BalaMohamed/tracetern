import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('Pass the base and candidate Query Core bundles');

async function observe(path, speculate) {
  const { QueryClient, QueriesObserver } = await import(pathToFileURL(resolve(path)));
  const client = new QueryClient();
  const a = client.defaultQueryOptions({ queryKey: ['a'], enabled: false });
  const b = client.defaultQueryOptions({ queryKey: ['b'], enabled: false });
  const combine = results => ({ value: results[0]?.data });
  client.setQueryData(['a'], 1);
  client.setQueryData(['b'], 2);
  const observer = new QueriesObserver(client, [a], { combine });
  observer.setQueries([a], { combine });

  const notifications = [];
  const unsubscribe = observer.subscribe(results => notifications.push(results[0].data));
  try {
    function optimistic(options) {
      const [results, combineResult] = observer.getOptimisticResult([options], combine);
      return combineResult(results).value;
    }
    const initial = optimistic(a);
    const speculative = speculate ? optimistic(b) : null;
    client.setQueryData(['a'], 2);
    return { initial, speculative, current: observer.getCurrentResult()[0].data, notifications };
  } finally {
    unsubscribe();
    client.clear();
  }
}

for (const [index, path] of paths.entries()) {
  const side = index === 0 ? 'base' : 'candidate';
  const control = await observe(path, false);
  const speculative = await observe(path, true);
  assert.deepEqual(control, { initial: 1, speculative: null, current: 2, notifications: [2] });
  assert.deepEqual(speculative, index === 0
    ? { initial: 1, speculative: 1, current: 2, notifications: [2] }
    : { initial: 1, speculative: 2, current: 2, notifications: [] });
  console.log(JSON.stringify({ side, control, speculative }));
}

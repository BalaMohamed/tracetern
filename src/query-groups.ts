import type { Client } from 'pg';

export interface QueryGroups {
  orders: number;
  customer: number;
  customerBatch: number;
  other: number;
}

function groupFor(query: unknown): keyof QueryGroups {
  const text = typeof query === 'object' && query !== null && 'text' in query ? query.text : query;
  if (typeof text !== 'string') return 'other';

  switch (text.trim().replace(/\s+/g, ' ').replace(/;$/, '').toLowerCase()) {
    case 'select id, customer_id from pg_temp.orders order by id':
      return 'orders';
    case 'select name from pg_temp.customers where id = $1':
      return 'customer';
    case 'select id, name from pg_temp.customers where id = any($1::int[])':
      return 'customerBatch';
    default:
      return 'other';
  }
}

// Observe calls at the client boundary, without retaining SQL text or arguments.
export function trackQueries(client: Client) {
  const execute = client.query;
  let current: QueryGroups | undefined;

  client.query = function (this: Client, ...args: unknown[]) {
    if (current) current[groupFor(args[0])]++;
    return Reflect.apply(execute, this, args);
  } as typeof client.query;

  return {
    async during<T>(read: () => Promise<T>) {
      const groups: QueryGroups = { orders: 0, customer: 0, customerBatch: 0, other: 0 };
      current = groups;
      try {
        return { value: await read(), groups };
      } finally {
        current = undefined;
      }
    },
  };
}

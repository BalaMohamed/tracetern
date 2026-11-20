import type { Client } from 'pg';
import type { Implementation, Order } from './scenario.js';

// Each instance belongs to one running application. The cache variant deliberately
// omits invalidation so the comparison includes a known freshness regression.
export function ordersService(db: Client, implementation: Implementation) {
  const cache = new Map<number, string>();
  let readCount = 0;
  async function read<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
    readCount++;
    return (await db.query<T>(sql, values)).rows;
  }
  return {
    reads: () => readCount,
    async list(): Promise<Order[]> {
      const orders = await read<{ id: number; customer_id: number }>(
        'SELECT id, customer_id FROM pg_temp.orders ORDER BY id',
      );
      const names = implementation === 'cache' ? cache : new Map<number, string>();
      if (implementation === 'batch') {
        const ids = [...new Set(orders.map(order => order.customer_id))];
        const customers = await read<{ id: number; name: string }>(
          'SELECT id, name FROM pg_temp.customers WHERE id = ANY($1::int[])', [ids],
        );
        for (const customer of customers) names.set(customer.id, customer.name);
      }
      const result: Order[] = [];
      for (const order of orders) {
        if (implementation === 'n-plus-one' || (implementation === 'cache' && !names.has(order.customer_id))) {
          const [customer] = await read<{ name: string }>(
            'SELECT name FROM pg_temp.customers WHERE id = $1', [order.customer_id],
          );
          if (!customer) throw new Error('Missing fixture customer');
          names.set(order.customer_id, customer.name);
        }
        const customerName = names.get(order.customer_id);
        if (customerName === undefined) throw new Error('Missing fixture customer');
        result.push({ id: order.id, customerName });
      }
      return result;
    },
  };
}

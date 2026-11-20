import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from 'pg';
import { ordersService } from './orders.js';
import { implementations, type Implementation, type Observation, type Run } from './scenario.js';

import { defaultExperiment, observationStages, validateExperiment } from './experiment.js';

async function replay(implementation: Implementation): Promise<Run> {
  const host = process.env.TRACETERN_SOCKET;
  if (!host?.startsWith('/')) throw new Error('Start the private cluster with scripts/with-postgres.sh');
  const db = new Client({ host, port: 5432, database: 'postgres', user: 'tracetern', ssl: false,
    connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  await db.connect();
  const service = makeService(db, implementation);
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/orders') { res.writeHead(404).end(); return; }
    try {
      const rows = await service.list();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : 'Request failed');
    }
  });
  try {
    await db.query(`
      CREATE TEMP TABLE customers (id integer PRIMARY KEY, name text NOT NULL);
      CREATE TEMP TABLE orders (id integer PRIMARY KEY, customer_id integer REFERENCES customers);
      INSERT INTO customers SELECT i, 'Customer ' || i FROM generate_series(1,100) i;
      INSERT INTO orders SELECT i, 101 - i FROM generate_series(1,100) i;
    `);
    const version = await db.query<{server_version: string}>('SHOW server_version');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
    const observations: Observation[] = [];
    const stages = observationStages(plan);
    for (const step of plan.steps) {
      if (step === 'rename') {
        await db.query("UPDATE pg_temp.customers SET name='Avery' WHERE id=$1", [plan.customerId]);
        continue;
      }
      const stage = stages[observations.length]!;
      const before = service.reads();
      const response = await fetch('http://127.0.0.1:' + address.port + '/orders', {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Orders request failed: ' + await response.text());
      observations.push({ stage, reads: service.reads() - before, orders: await response.json() });
    }
    return { implementation, postgres: version.rows[0]!.server_version, observations };
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await db.end();
  }
}

const plan = validateExperiment(process.argv[4] ? JSON.parse(process.argv[4]) : defaultExperiment);
const makeService: typeof ordersService = process.argv[3]
  ? (await import(process.argv[3])).ordersService : ordersService;
const name = implementations.find(value => value === process.argv[2]);
if (!name) throw new Error('Unknown fixture implementation');
process.stdout.write(JSON.stringify(await replay(name)));

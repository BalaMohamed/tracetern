import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compare, implementations, type Implementation, type Run } from './scenario.js';

const execute = promisify(execFile);
async function runWorker(name: Implementation): Promise<Run> {
  const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
  const { stdout } = await execute(process.execPath, [worker, name], { timeout: 30_000 });
  return JSON.parse(stdout) as Run;
}

const args = process.argv.slice(2);
const json = args.includes('--json');
try {
  const candidate = implementations.find(value => value === args[0]);
  if (!candidate || args.length !== (json ? 2 : 1)) {
    throw new Error('Usage: tracetern <cache|batch|n-plus-one> [--json]');
  }
  const reference = await runWorker('batch');
  const report = compare(reference, await runWorker(candidate));
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('orders-list/v1  ·  batch reference → ' + candidate);
    for (const row of report.reads) {
      console.log(row.stage.padEnd(15) + row.reference + ' → ' + row.candidate + ' SQL reads');
    }
    console.log('Verdict: ' + report.verdict);
    if (report.mismatch) console.log(JSON.stringify(report.mismatch));
  }
  process.exitCode = report.verdict === 'pass' ? 0 : 1;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ schemaVersion: 1, verdict: 'inconclusive', reason }));
  else console.error('Inconclusive: ' + reason);
  process.exitCode = 2;
}

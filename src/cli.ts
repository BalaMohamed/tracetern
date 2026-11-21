import { compare, implementations } from './scenario.js';
import { investigate, runWorker } from './investigation.js';

async function dispatch(args: string[]) {
  const [command, first, second] = args;
  if (command === 'plan' && first && second) {
    const [kind, model] = args.slice(3);
    if (kind === 'rule' && args.length === 4) {
      return investigate({ command: 'compare', base: first, candidate: second, planner: { kind } });
    }
    if (kind === 'ollama' && model && args.length === 5) {
      return investigate({ command: 'compare', base: first, candidate: second, planner: { kind, model } });
    }
    throw new Error('Usage: tracetern plan <base> <candidate> rule|ollama <model-tag>');
  }
  if (command === 'compare' && first && second && args.length === 3) {
    return investigate({ command, base: first, candidate: second });
  }
  if (command === 'record' && args.length === 2) {
    const implementation = implementations.find(value => value === first);
    if (implementation) return investigate({ command, implementation });
  }
  if (command === 'verify' && first && second && args.length === 3) {
    return investigate({ command, runId: first, candidate: second });
  }
  if (command === 'replay' && first && args.length === 2) {
    return investigate({ command, runId: first });
  }
  const name = implementations.find(value => value === args[0]);
  if (!name || args.length !== 1) {
    throw new Error('Usage: tracetern <cache|batch|n-plus-one> | record <implementation> | compare <base> <candidate> | replay <run-id> | verify <run-id> <candidate> [--json]');
  }
  return compare(await runWorker('batch'), await runWorker(name));
}

const args = process.argv.slice(2);
const flag = args.indexOf('--json');
const json = flag >= 0;
if (json) args.splice(flag, 1);
try {
  const report = await dispatch(args);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if ('runId' in report) {
      console.log('Investigation ' + report.runId);
      console.log(report.baseCommit.slice(0, 12) + ' → ' + report.candidateCommit.slice(0, 12));
      if (report.plan && report.planner) {
        console.log(report.planner.kind + ' plan: ' + report.plan.steps.join(' → ') + ' (customer ' + report.plan.customerId + ')');
      }
      if (report.verificationOf) console.log('Checking the experiment from ' + report.verificationOf);
      if (report.reproduced !== undefined) console.log('Matches saved behavior: ' + report.reproduced);
      if (report.measurementsMatch !== undefined) console.log('Matches saved call counts: ' + report.measurementsMatch);
    }
    if (report.verdict === 'inconclusive') {
      console.error('Inconclusive: ' + report.reason);
    } else {
      console.log('orders-list/v1  ·  ' + report.reference + ' reference → ' + report.candidate);
      for (const row of report.reads) {
        console.log(row.stage.padEnd(15) + row.reference + ' → ' + row.candidate + ' PostgreSQL client calls');
      }
      console.log('Verdict: ' + report.verdict);
      if (report.mismatch) console.log(JSON.stringify(report.mismatch));
    }
  }
  process.exitCode = { pass: 0, regression: 1, inconclusive: 2 }[report.verdict];
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ schemaVersion: 1, verdict: 'inconclusive', reason }));
  else console.error('Inconclusive: ' + reason);
  process.exitCode = 2;
}

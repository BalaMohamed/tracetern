import { open } from 'node:fs/promises';
import { compare, implementations } from './scenario.js';
import { investigate, runWorker } from './investigation.js';
import { getRun } from './evidence-view.js';
import { investigateLibrary } from './library.js';
import { isLibraryFixture, zustandFixture } from './library-cases.js';

import { investigateDataFusion } from './datafusion.js';
import { datafusionFixture } from './evidence.js';
import { rankExperiments, suggestExperiments } from './retrieval.js';
import { browseModels, pullModel } from './ollama.js';

async function readDiff(path: string) {
  const file = await open(path);
  try {
    const maxBytes = 1024 * 1024;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) return buffer.toString('utf8', 0, size);
      size += bytesRead;
    }
    throw new Error('Diff exceeds 1 MiB');
  } finally {
    await file.close();
  }
}

async function dispatch(args: string[]) {
  const [command, first, second] = args;
  if (command === 'datafusion' && args.length === 2 && (first === 'broken' || first === 'fixed' || first === 'disabled')) {
    return investigateDataFusion({ mode: first });
  }
  if (command === 'compare-library' && first && second && args[3] &&
      args.length === 6 && args[4] === '--adapter' && args[5] === 'zustand') {
    return investigateLibrary({ repository: first, base: second, candidate: args[3], fixture: zustandFixture });
  }
  if ((command === 'compare-library' || command === 'plan-library') && first && second && args.length === 4) {
    return investigateLibrary({ repository: first, base: second, candidate: args[3]!, select: command === 'plan-library' });
  }
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
    const fixture = getRun('.tracetern', first)?.fixture;
    if (fixture === datafusionFixture) return investigateDataFusion({ replayOf: first });
    if (isLibraryFixture(fixture)) return investigateLibrary({ replayOf: first });
    return investigate({ command, runId: first });
  }
  const name = implementations.find(value => value === args[0]);
  if (!name || args.length !== 1) {
    throw new Error('Usage: tracetern <cache|batch|n-plus-one> | datafusion <broken|fixed|disabled> | suggest <diff-file> [--ollama <model-tag>] | models [pull <model-tag>] | record <implementation> | compare <base> <candidate> | compare-library <repository> <base> <candidate> [--adapter zustand] | plan-library <repository> <base> <candidate> | replay <run-id> | verify <run-id> <candidate> [--json]');
  }
  return compare(await runWorker('batch'), await runWorker(name));
}

const args = process.argv.slice(2);
const flag = args.indexOf('--json');
const json = flag >= 0;
if (json) args.splice(flag, 1);
try {
  if (args[0] === 'models') {
    if (args.length === 1) {
      const report = await browseModels();
      if (json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log('Installed local models');
        for (const model of report.installed) console.log('  ' + model.tag + ' · ' + (model.size / 1e9).toFixed(2) + ' GB');
        if (!report.installed.length) console.log('  None');
        console.log('Ollama catalog · approximate download size');
        for (const model of report.catalog) {
          console.log('  ' + model.tag + ' · ' + model.downloadGB + ' GB' + (model.installed ? ' · installed' : ''));
        }
      }
    } else if (args.length === 3 && args[1] === 'pull' && args[2]) {
      const result = await pullModel(args[2], (status, percent) => {
        if (!json) console.error(status + (percent === undefined ? '' : ' · ' + percent + '%'));
      });
      console.log(json ? JSON.stringify(result, null, 2) : 'Installed ' + result.tag + ' · ' + result.digest);
    } else {
      throw new Error('Usage: tracetern models [pull <model-tag>] [--json]');
    }
  } else if (args[0] === 'suggest') {
    const [, patch, flag, model] = args;
    if (!patch || (args.length !== 2 && !(args.length === 4 && flag === '--ollama' && model))) {
      throw new Error('Usage: tracetern suggest <diff-file> [--ollama <model-tag>] [--json]');
    }
    const diff = await readDiff(patch);
    const report = model ? await rankExperiments(diff, model) : suggestExperiments(diff);
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (report.reason) console.log(report.reason);
    else for (const item of report.suggestions) {
      console.log(item.fixture + ' · ' + item.distinctCases + ' distinct saved cases');
      console.log(item.scope);
      for (const match of item.matching) console.log(match.path + ' · ' + match.concepts.join(', '));
      console.log('Replay saved case: tracetern replay ' + item.example.runId);
    }
    process.exitCode = report.suggestions.length ? 0 : 2;
  } else {
    process.exitCode = await runComparison(args, json);
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ schemaVersion: 1, verdict: 'inconclusive', reason }));
  else console.error('Inconclusive: ' + reason);
  process.exitCode = 2;
}

async function runComparison(args: string[], json: boolean) {
  const report = await dispatch(args);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if ('planning' in report && report.planning) {
      for (const { id, change, contract } of report.planning.experiments) {
        console.log(id + ' · ' + change.revision + ' ' + change.path + ':' + change.line +
          ' → ' + contract.path + ':' + contract.line);
      }
    }
    if ('mode' in report) console.log(report.baselineEngine + ' → ' + report.candidateEngine + ' (' + report.mode + ')');
    if ('runId' in report) {
      console.log('Investigation ' + report.runId);
      console.log(report.baseCommit.slice(0, 12) + ' → ' + report.candidateCommit.slice(0, 12));
      if ('planner' in report && report.plan && report.planner) {
        console.log(report.planner.kind + ' plan: ' + report.plan.steps.join(' → ') + ' (customer ' + report.plan.customerId + ')');
      }
      if ('verificationOf' in report && report.verificationOf) console.log('Checking the experiment from ' + report.verificationOf);
      if (report.reproduced !== undefined) console.log('Matches saved behavior: ' + report.reproduced);
      if ('measurementsMatch' in report && report.measurementsMatch !== undefined) console.log('Matches saved call counts: ' + report.measurementsMatch);
    }
    if (report.verdict === 'inconclusive') {
      console.error('Inconclusive: ' + report.reason);
    } else if ('checks' in report) {
      console.log(report.fixture);
      for (const check of report.checks) {
        const outcome = check.contractAdded ? (check.matched ? 'new contract met' : 'new contract failed')
          : check.repaired ? 'baseline failure repaired' : check.matched ? 'matched' : 'differs';
        console.log(check.id + ': ' + outcome + ' · ' + JSON.stringify(check.candidate));
      }
      console.log('Verdict: ' + report.verdict);
    } else {
      console.log('orders-list/v1  ·  ' + report.reference + ' reference → ' + report.candidate);
      for (const row of report.reads) {
        console.log(row.stage.padEnd(15) + row.reference + ' → ' + row.candidate + ' PostgreSQL client calls');
      }
      console.log('Verdict: ' + report.verdict);
      if (report.mismatch) console.log(JSON.stringify(report.mismatch));
    }
  }
  return 'mode' in report && report.reproduced === false ? 2 : { pass: 0, regression: 1, inconclusive: 2 }[report.verdict];
}

import { open } from 'node:fs/promises';
import { compare, implementations } from './scenario.js';
import { investigate, runWorker } from './investigation.js';
import { getRun } from './evidence-view.js';
import { investigateLibrary } from './library.js';
import { isLibraryFixture, zustandFixture } from './library-cases.js';

import { investigateDataFusion } from './datafusion.js';
import { datafusionFixture } from './evidence.js';
import { rankerWeights, rankLearnedExperiments } from './experiment-ranker.js';
import { rankExperiments, suggestExperiments } from './retrieval.js';
import { modelCommand, selectedModel } from './model-picker.js';
import { inconclusive, InvestigationError } from './execution.js';

const cancellation = new AbortController();
const cancel = () => cancellation.abort();

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
    return investigateDataFusion({ mode: first }, undefined, cancellation.signal);
  }
  if (command === 'compare-library' && first && second && args[3] &&
      args.length === 6 && args[4] === '--adapter' && args[5] === 'zustand') {
    return investigateLibrary({ repository: first, base: second, candidate: args[3], fixture: zustandFixture }, cancellation.signal);
  }
  if (command === 'run-suggested' && first && second && args[3] && args.length === 4) {
    return investigateLibrary({ repository: first, base: second, candidate: args[3], shortlist: true }, cancellation.signal);
  }
  if (command === 'verify-library' && first && second && args[3] && args.length === 4) {
    return investigateLibrary({ verificationOf: first, repository: second, candidate: args[3] }, cancellation.signal);
  }
  if ((command === 'compare-library' || command === 'plan-library') && first && second && args.length === 4) {
    return investigateLibrary({ repository: first, base: second, candidate: args[3]!, select: command === 'plan-library' }, cancellation.signal);
  }
  if (command === 'plan' && first && second) {
    const [kind, model] = args.slice(3);
    if (kind === 'rule' && args.length === 4) {
      return investigate({ command: 'compare', base: first, candidate: second, planner: { kind } }, cancellation.signal);
    }
    if (kind === 'ollama' && (args.length === 4 || args.length === 5)) {
      const tag = model ?? await selectedModel();
      if (!tag) throw new Error('Select a local model with models pick or pass its exact tag');
      return investigate({ command: 'compare', base: first, candidate: second, planner: { kind, model: tag } }, cancellation.signal);
    }
    throw new Error('Usage: tracetern plan <base> <candidate> rule|ollama <model-tag>');
  }
  if (command === 'compare' && first && second && args.length === 3) {
    return investigate({ command, base: first, candidate: second }, cancellation.signal);
  }
  if (command === 'record' && args.length === 2) {
    const implementation = implementations.find(value => value === first);
    if (implementation) return investigate({ command, implementation }, cancellation.signal);
  }
  if (command === 'verify' && first && second && args.length === 3) {
    return investigate({ command, runId: first, candidate: second }, cancellation.signal);
  }
  if (command === 'replay' && first && args.length === 2) {
    const fixture = getRun('.tracetern', first)?.fixture;
    if (!fixture) throw new InvestigationError('invalid-input', 'Unknown investigation or invalid run ID');
    if (fixture === datafusionFixture) return investigateDataFusion({ replayOf: first }, undefined, cancellation.signal);
    if (isLibraryFixture(fixture)) return investigateLibrary({ replayOf: first }, cancellation.signal);
    return investigate({ command, runId: first }, cancellation.signal);
  }
  const name = implementations.find(value => value === args[0]);
  if (!name || args.length !== 1) {
    throw new InvestigationError('invalid-input', 'Usage: tracetern <cache|batch|n-plus-one> | datafusion <broken|fixed|disabled> | suggest <diff-file> [--ollama [model-tag] | --learned <ranking-report>] | models [pick [model-tag] | pull <model-tag>] | record <implementation> | compare <base> <candidate> | compare-library <repository> <base> <candidate> [--adapter zustand] | plan-library <repository> <base> <candidate> | run-suggested <repository> <base> <candidate> | verify-library <run-id> <repository> <candidate> | replay <run-id> | verify <run-id> <candidate> [--json]');
  }
  return compare(await runWorker('batch', undefined, undefined, cancellation.signal),
    await runWorker(name, undefined, undefined, cancellation.signal));
}

const args = process.argv.slice(2);
const flag = args.indexOf('--json');
const json = flag >= 0;
if (json) args.splice(flag, 1);
try {
  if (args[0] === 'models') {
    await modelCommand(args.slice(1), json);
  } else if (args[0] === 'suggest') {
    const [, patch, flag, option] = args;
    const useOllama = flag === '--ollama' && (args.length === 3 || args.length === 4);
    const useLearned = flag === '--learned' && args.length === 4 && option;
    if (!patch || (args.length !== 2 && !useOllama && !useLearned)) {
      throw new Error('Usage: tracetern suggest <diff-file> [--ollama [model-tag] | --learned <ranking-report>] [--json]');
    }
    const tag = useOllama ? option ?? await selectedModel() : undefined;
    if (useOllama && !tag) throw new Error('Select a local model with models pick or pass its exact tag');
    const diff = await readDiff(patch);
    const report = useLearned
      ? rankLearnedExperiments(diff, rankerWeights(JSON.parse(await readDiff(useLearned))))
      : tag ? await rankExperiments(diff, tag) : suggestExperiments(diff);
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (report.reason) {
      console.log(report.reason);
      for (const target of report.targets) console.log(target.behavior + ' · ' + target.path);
    }
    else for (const item of report.suggestions) {
      console.log(item.fixture + ' · ' + item.distinctCases + ' distinct saved cases');
      console.log(item.scope);
      for (const rule of item.coverage) console.log('Covered: ' + rule.behavior + ' · ' + rule.path);
      for (const match of item.matching) console.log(match.path + ' · ' + match.concepts.join(', '));
      console.log('Replay saved case: tracetern replay ' + item.example.runId);
    }
    process.exitCode = report.suggestions.length ? 0 : 2;
  } else {
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    process.exitCode = await runComparison(args, json);
  }
} catch (error) {
  const result = inconclusive(error);
  if (json) console.log(JSON.stringify(result));
  else console.error('Inconclusive: ' + result.reason);
  process.exitCode = 2;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
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
    if ('selection' in report && report.selection) {
      console.log('Selected from saved run ' + report.selection.exampleRunId);
      for (const target of report.selection.coverage) console.log(target.behavior + ' · ' + target.path);
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
    }
    if ('checks' in report && report.checks) {
      if ('fixture' in report) console.log(report.fixture);
      for (const check of report.checks) {
        const outcome = check.contractAdded ? (check.matched ? 'new contract met' : 'new contract failed')
          : check.repaired ? 'baseline failure repaired' : check.matched ? 'matched' : 'differs';
        console.log(check.id + ': ' + outcome + ' · ' + JSON.stringify(check.candidate));
      }
      console.log('Verdict: ' + report.verdict);
    } else if ('reads' in report) {
      console.log('orders-list/v1  ·  ' + report.reference + ' reference → ' + report.candidate);
      for (const row of report.reads) {
        console.log(row.stage.padEnd(15) + row.reference + ' → ' + row.candidate + ' PostgreSQL client calls');
      }
      console.log('Verdict: ' + report.verdict);
      if (report.mismatch) console.log(JSON.stringify(report.mismatch));
    }
  }
  if ('reproduced' in report && report.reproduced === false) return 2;
  return { pass: 0, regression: 1, inconclusive: 2 }[report.verdict];
}

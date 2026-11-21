import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { compare, type Implementation, type Run } from './scenario.js';
import { digest, harnessIdentity, snapshot, type Snapshot } from './revision.js';
import { openEvidence, type Investigation, type Result } from './evidence.js';
import { defaultExperiment, validateExperiment, type Experiment } from './experiment.js';
import { propose, type Planner, type Proposal } from './planner.js';

const execute = promisify(execFile);
export async function runWorker(name: Implementation, modulePath?: string, plan: Experiment = defaultExperiment): Promise<Run> {
  const args = [fileURLToPath(new URL('./worker.js', import.meta.url)), name];
  if (modulePath) args.push(pathToFileURL(modulePath).href, JSON.stringify(plan));
  const { stdout } = await execute(process.execPath, args, { timeout: 30_000 });
  return JSON.parse(stdout) as Run;
}

async function pairedRun(
  reference: Snapshot,
  candidate: Snapshot,
  plan: Experiment,
  implementation: Implementation,
) {
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-revisions-'));
  async function run(side: string, artifact: Snapshot, mode: Implementation) {
    if (digest(artifact.module) !== artifact.moduleSha256) throw new Error('Module digest mismatch: ' + side);
    const path = join(directory, side + '.mjs');
    await writeFile(path, artifact.module, { flag: 'wx', mode: 0o600 });
    return runWorker(mode, path, plan);
  }
  try {
    const baseline = await run('reference', reference, 'batch');
    const trial = await run('candidate', candidate, implementation);
    return compare(baseline, trial, plan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Request =
  | { command: 'compare'; base: string; candidate: string; planner?: Planner }
  | { command: 'record'; implementation: Implementation }
  | { command: 'replay'; runId: string }
  | { command: 'verify'; runId: string; candidate: string };

async function selectSnapshots(request: Request, original: Investigation | undefined) {
  if (request.command === 'compare') {
    return Promise.all([snapshot(request.base), snapshot(request.candidate)] as const);
  }
  if (request.command === 'record') {
    const fixture = await snapshot('HEAD');
    return [fixture, fixture] as const;
  }
  if (!original) throw new Error('Missing investigation to rerun');
  const candidate = request.command === 'verify' ? await snapshot(request.candidate) : original.candidate;
  return [original.reference, candidate] as const;
}

function compareWithSavedResult(saved: Result | undefined, result: Result) {
  if (!saved || saved.verdict === 'inconclusive' || result.verdict === 'inconclusive') return {};
  return {
    reproduced: saved.verdict === result.verdict && isDeepStrictEqual(saved.mismatch, result.mismatch),
    measurementsMatch: saved.callMetric === result.callMetric && isDeepStrictEqual(saved.reads, result.reads),
  };
}

export async function investigate(request: Request) {
  const environment = await harnessIdentity();
  const store = openEvidence('.tracetern');
  try {
    const original = 'runId' in request ? store.load(request.runId) : undefined;
    const [reference, candidate] = await selectSnapshots(request, original);
    const replayOf = request.command === 'replay' ? request.runId : undefined;
    const verificationOf = request.command === 'verify' ? request.runId : undefined;
    const fixtureImplementation = request.command === 'record' ? request.implementation
      : request.command === 'replay' ? original?.fixtureImplementation : undefined;
    const planner = request.command === 'compare' ? request.planner : original?.planner;
    const savedEnvironment = original?.environment;
    let proposal: Proposal | undefined = original?.proposal;
    let plan: Experiment | undefined = original?.plan;
    let result: Result;
    try {
      if (savedEnvironment && !savedEnvironment.replaySha256) {
        throw new Error('This older recording requires the original runner build');
      }
      if (savedEnvironment && (
        savedEnvironment.fixture !== environment.fixture ||
        savedEnvironment.node !== environment.node ||
        savedEnvironment.lockSha256 !== environment.lockSha256 ||
        savedEnvironment.replaySha256 !== environment.replaySha256
      )) {
        throw new Error('Rerun requires compatible replay code, fixture, Node version and dependency lock');
      }
      if (reference.lockSha256 !== environment.lockSha256 || candidate.lockSha256 !== environment.lockSha256) {
        throw new Error('Both snapshots must have the same dependency lock as the runner');
      }
      if (original && planner && !plan) throw new Error('Original planner did not produce a validated plan');
      if (!original && planner) proposal = await propose(planner, reference, candidate);
      plan = validateExperiment(plan ?? proposal?.experiment ?? defaultExperiment);

      const comparison = await pairedRun(reference, candidate, plan, fixtureImplementation ?? 'batch');
      if (original && original.result.verdict !== 'inconclusive' && original.result.postgres !== comparison.postgres) {
        throw new Error('Rerun requires the original PostgreSQL version');
      }
      result = comparison;
    } catch (error) {
      result = { schemaVersion: 1, verdict: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
    }
    const runId = store.save({
      plan, planner, proposal, environment: result.verdict === 'inconclusive' && savedEnvironment
        ? savedEnvironment : environment,
      reference, candidate, result, replayOf, verificationOf, fixtureImplementation,
    });
    return {
      ...result, plan, planner, proposal, runId, baseCommit: reference.commit, candidateCommit: candidate.commit,
      replayOf, verificationOf, ...compareWithSavedResult(replayOf ? original?.result : undefined, result),
    };
  } finally {
    store.close();
  }
}

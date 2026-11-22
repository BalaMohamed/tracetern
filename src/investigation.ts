import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compare, firstMismatch, type Implementation, type Run } from './scenario.js';
import { digest, harnessIdentity, snapshot, verifySnapshot, type Snapshot } from './revision.js';
import { openEvidence, type Investigation, type Result } from './evidence.js';
import { defaultExperiment, validateExperiment, type Experiment } from './experiment.js';
import { propose, type Planner, type Proposal } from './planner.js';
import { checkCancellation, inconclusive, InvestigationError, parseWorkerOutput, runProcess } from './execution.js';

// The b42e08c runner executes the same Orders workload and comparator contract.
const previousReplaySha256 = 'aaf099cde05a9c1cfd34b5099b5e278de23fb69eda6f269ee1e7974251497df2';

export async function runWorker(name: Implementation, modulePath?: string, plan: Experiment = defaultExperiment,
  signal?: AbortSignal): Promise<Run> {
  if (!process.env.TRACETERN_SOCKET?.startsWith('/')) {
    throw new InvestigationError('execution-failed', 'Start the private cluster with scripts/with-postgres.sh');
  }
  const args = [fileURLToPath(new URL('./worker.js', import.meta.url)), name];
  if (modulePath) args.push(pathToFileURL(modulePath).href, JSON.stringify(plan));
  const stdout = await runProcess('Orders worker', process.execPath, args, { timeout: 30_000, maxBuffer: 256 * 1024, signal });
  const run = parseWorkerOutput(stdout, 'Orders worker') as Partial<Run> | null;
  if (run?.implementation !== name || typeof run.postgres !== 'string' || !run.postgres || !Array.isArray(run.observations)) {
    throw new InvestigationError('invalid-observations', 'Invalid Orders worker output');
  }
  return run as Run;
}

async function pairedRun(
  reference: Snapshot,
  candidate: Snapshot,
  plan: Experiment,
  implementation: Implementation,
  original: Investigation | undefined,
  signal?: AbortSignal,
) {
  verifySnapshot(reference, 'reference');
  verifySnapshot(candidate, 'candidate');
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-revisions-'));
  async function run(side: string, artifact: Snapshot, mode: Implementation) {
    const path = join(directory, side + '.mjs');
    await writeFile(path, artifact.module, { flag: 'wx', mode: 0o600 });
    return runWorker(mode, path, plan, signal);
  }
  try {
    const baseline = await run('reference', reference, 'batch');
    if (original && original.result.verdict !== 'inconclusive' && baseline.postgres !== original.result.postgres) {
      throw new InvestigationError('incompatible-replay', 'Rerun requires the original PostgreSQL version');
    }
    if (firstMismatch(baseline, plan)) {
      throw new InvestigationError('reference-failed', 'Reference violates the fixture contract');
    }
    const referenceOrdersSha256 = digest(JSON.stringify(baseline.observations.map(({ orders }) =>
      orders.map(({ id, customerName }) => ({ id, customerName })))));
    if (original?.referenceOrdersSha256 && referenceOrdersSha256 !== original.referenceOrdersSha256) {
      throw new InvestigationError('reference-failed', 'The saved Orders reference observations did not reproduce');
    }
    const trial = await run('candidate', candidate, implementation);
    return { comparison: compare(baseline, trial, plan), referenceOrdersSha256 };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Request =
  | { command: 'compare'; base: string; candidate: string; planner?: Planner }
  | { command: 'record'; implementation: Implementation }
  | { command: 'replay'; runId: string }
  | { command: 'verify'; runId: string; candidate: string };

async function selectSnapshots(request: Request, original: Investigation | undefined, signal?: AbortSignal) {
  if (request.command === 'compare') {
    return Promise.all([snapshot(request.base, signal), snapshot(request.candidate, signal)] as const);
  }
  if (request.command === 'record') {
    const fixture = await snapshot('HEAD', signal);
    return [fixture, fixture] as const;
  }
  if (!original) throw new Error('Missing investigation to rerun');
  const candidate = request.command === 'verify' ? await snapshot(request.candidate, signal) : original.candidate;
  return [original.reference, candidate] as const;
}

function compareWithSavedResult(saved: Result | undefined, result: Result) {
  if (!saved || saved.verdict === 'inconclusive' || result.verdict === 'inconclusive') return {};
  return {
    reproduced: saved.verdict === result.verdict && isDeepStrictEqual(saved.mismatch, result.mismatch),
    measurementsMatch: saved.callMetric === result.callMetric && isDeepStrictEqual(saved.reads, result.reads),
  };
}

export async function investigate(request: Request, signal?: AbortSignal) {
  const environment = await harnessIdentity();
  const store = openEvidence('.tracetern');
  try {
    const original = 'runId' in request ? store.load(request.runId) : undefined;
    const [reference, candidate] = await selectSnapshots(request, original, signal);
    if (!reference || !candidate) throw new InvestigationError('artifact-invalid', 'Missing saved Orders snapshot');
    const replayOf = request.command === 'replay' ? request.runId : undefined;
    const verificationOf = request.command === 'verify' ? request.runId : undefined;
    const fixtureImplementation = request.command === 'record' ? request.implementation
      : request.command === 'replay' ? original?.fixtureImplementation : undefined;
    const planner = request.command === 'compare' ? request.planner : original?.planner;
    const savedEnvironment = original?.environment;
    let proposal: Proposal | undefined = original?.proposal;
    let plan: Experiment | undefined = original?.plan;
    let result: Result;
    let referenceOrdersSha256: string | undefined;
    try {
      if (savedEnvironment && !savedEnvironment.replaySha256) {
        throw new InvestigationError('incompatible-replay', 'This older recording requires the original runner build');
      }
      if (savedEnvironment && (
        savedEnvironment.fixture !== environment.fixture ||
        savedEnvironment.node !== environment.node ||
        savedEnvironment.lockSha256 !== environment.lockSha256 ||
        (savedEnvironment.replaySha256 !== environment.replaySha256 && savedEnvironment.replaySha256 !== previousReplaySha256)
      )) {
        throw new InvestigationError('incompatible-replay', 'Rerun requires compatible replay code, fixture, Node version and dependency lock');
      }
      if (reference.lockSha256 !== environment.lockSha256 || candidate.lockSha256 !== environment.lockSha256) {
        throw new InvestigationError('incompatible-replay', 'Both snapshots must have the same dependency lock as the runner');
      }
      if (original && planner && !plan) throw new Error('Original planner did not produce a validated plan');
      if (!original && planner) proposal = await propose(planner, reference, candidate, signal);
      plan = validateExperiment(plan ?? proposal?.experiment ?? defaultExperiment);

      const observed = await pairedRun(reference, candidate, plan, fixtureImplementation ?? 'batch', original, signal);
      result = observed.comparison;
      referenceOrdersSha256 = observed.referenceOrdersSha256;
    } catch (error) {
      result = inconclusive(error);
    }
    checkCancellation(signal);
    const runId = store.save({
      plan, planner, proposal, environment: result.verdict === 'inconclusive' && savedEnvironment
        ? savedEnvironment : environment,
      reference, candidate, result, replayOf, verificationOf, fixtureImplementation, referenceOrdersSha256,
    });
    return {
      ...result, plan, planner, proposal, runId, baseCommit: reference.commit, candidateCommit: candidate.commit,
      replayOf, verificationOf, ...compareWithSavedResult(replayOf ? original?.result : undefined, result),
    };
  } finally {
    store.close();
  }
}

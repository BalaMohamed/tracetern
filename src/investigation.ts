import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compare, type Implementation, type Run } from './scenario.js';
import { digest, harnessIdentity, snapshot, type Snapshot } from './revision.js';
import { openEvidence, type Result } from './evidence.js';
import { defaultExperiment, validateExperiment, type Experiment } from './experiment.js';
import { propose, type Planner, type Proposal } from './planner.js';

const execute = promisify(execFile);
export async function runWorker(name: Implementation, modulePath?: string, plan: Experiment = defaultExperiment): Promise<Run> {
  const args = [fileURLToPath(new URL('./worker.js', import.meta.url)), name];
  if (modulePath) args.push(pathToFileURL(modulePath).href, JSON.stringify(plan));
  const { stdout } = await execute(process.execPath, args, { timeout: 30_000 });
  return JSON.parse(stdout) as Run;
}

async function pairedRun(reference: Snapshot, candidate: Snapshot, plan: Experiment): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-revisions-'));
  async function run(side: string, artifact: Snapshot) {
    if (digest(artifact.module) !== artifact.moduleSha256) throw new Error('Module digest mismatch: ' + side);
    const path = join(directory, side + '.mjs');
    await writeFile(path, artifact.module, { flag: 'wx', mode: 0o600 });
    return runWorker('batch', path, plan);
  }
  try {
    return compare(await run('reference', reference), await run('candidate', candidate), plan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Request = { command: 'compare'; base: string; candidate: string; planner?: Planner } | { command: 'replay'; runId: string };

export async function investigate(request: Request) {
  const environment = await harnessIdentity();
  const store = openEvidence('.tracetern');
  try {
    const replayOf = request.command === 'replay' ? request.runId : undefined;
    const previous = replayOf ? store.load(replayOf) : undefined;
    const [reference, candidate] = request.command === 'compare'
      ? await Promise.all([snapshot(request.base), snapshot(request.candidate)])
      : [previous!.reference, previous!.candidate];
    const planner = request.command === 'compare' ? request.planner : previous?.planner;
    let proposal: Proposal | undefined = previous?.proposal;
    let plan: Experiment | undefined;
    let result: Result;
    try {
      if (previous && JSON.stringify(previous.environment) !== JSON.stringify(environment)) {
        throw new Error('Replay requires the original runner build, Node version and dependency lock');
      }
      if ([reference, candidate].some(side => side.lockSha256 !== environment.lockSha256)) {
        throw new Error('Both snapshots must have the same dependency lock as the runner');
      }
      if (replayOf && planner && !previous?.plan) throw new Error('Original planner did not produce a validated plan');
      if (!replayOf && planner) proposal = await propose(planner, reference, candidate);
      plan = validateExperiment(previous?.plan ?? proposal?.experiment ?? defaultExperiment);
      result = await pairedRun(reference, candidate, plan);
      if (previous && previous.result.verdict !== 'inconclusive' && result.verdict !== 'inconclusive'
          && previous.result.postgres !== result.postgres) {
        throw new Error('Replay requires the original PostgreSQL version');
      }
    } catch (error) {
      result = { schemaVersion: 1, verdict: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
    }
    const runId = store.save({ plan, planner, proposal, environment: previous?.environment ?? environment, reference, candidate, result, replayOf });
    const reproduced = previous && previous.result.verdict !== 'inconclusive' && result.verdict !== 'inconclusive'
      ? JSON.stringify(result) === JSON.stringify(previous.result) : undefined;
    return { ...result, plan, planner, proposal, runId, baseCommit: reference.commit, candidateCommit: candidate.commit,
      replayOf, reproduced };
  } finally {
    store.close();
  }
}

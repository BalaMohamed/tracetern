import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openEvidence, type LibraryInvestigation, type LibrarySelection } from './evidence.js';
import { defaultLibraryPlan, expectedLookups, isLibraryFixture, libraryFixture, libraryPlan, validateLibraryPlan, zustandFixture,
  type LibraryCase, type LibraryFixture, type LibraryLookups } from './library-cases.js';
import { keyGuide, observerGuide, persistenceGuide, timestampGuide, plannerPaths,
  selectLibraryExperiments, type LibraryPlanning } from './library-planner.js';
import { suggestExperiments } from './retrieval.js';
import { digest, verifySnapshot, type HarnessIdentity, type Snapshot } from './revision.js';
import { checkCancellation, inconclusive, InvestigationError, parseWorkerOutput, runProcess } from './execution.js';

const librarySources = {
  [libraryFixture]: { directory: 'packages/query-core/src', entry: 'index.ts', lockfile: 'pnpm-lock.yaml' },
  [zustandFixture]: { directory: 'src', entry: 'vanilla.ts', lockfile: 'yarn.lock' },
};
const buildDirectory = new URL('../../adapters/tanstack/', import.meta.url);
const lockURL = new URL('package-lock.json', buildDirectory);
// The f71e0b4 runner saved the same cases as a single, fixed suite.
const originalSuiteSha256 = '8eb06fd88f2efd6abe5fb65fa34c88de4a2c1b8379beac3306a346ec03299249';
const originalPlannerReplaySha256 = '6557869a9416c9b8dc69b68f7319e58f098e823ba997a45b4ad7d1a692696531';
const observerReplaySha256 = 'fb45aafe0f79edfac71ee09acc5689577b1c80af039da505ad967bfaa80d1012';
// Shortlist execution and verification change orchestration; prior worker observations stay compatible.
const priorLibraryReplaySha256 = 'ccafe640a0558d466a6c31ce1cad9039d24b3e53620a01ac4e5c9d32b1a48153';
const timestampReplaySha256 = '1dfaaccc17be73aa76fba491e98d5075bbb84414496a2129b3fa13cddfbe7223';
// b42e08c used the same contracts and worker, with less validation at the process boundary.
const previousReplaySha256 = '0305991d4dec6e78a48d99ecc3623d2bc42c87237c748b8562ca176b65e748f3';

type Git = (...args: string[]) => Promise<string>;

function gitFor(repository: string, signal?: AbortSignal): Git {
  return (...args) => runProcess('Library Git ' + args[0], 'git', ['-C', repository, ...args],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, signal }, 'invalid-input');
}

async function readBuildInputs() {
  const [toolLock, builder] = await Promise.all([readFile(lockURL, 'utf8'), readFile(new URL('build.mjs', buildDirectory))]);
  return { toolLock, lockSha256: digest(toolLock), buildSha256: digest(builder) };
}

async function pin(git: Git, ref: string) {
  return (await git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}')).trim();
}

async function planChange(git: Git, base: string, candidate: string) {
  async function readDocs(revision: string, paths: string[]) {
    const entries = await git('ls-tree', '-r', '-z', '--name-only', revision, '--', ...paths);
    const texts = await Promise.all(entries.split('\0').filter(path => paths.includes(path)).map(async path =>
      [path, await git('cat-file', 'blob', revision + ':' + path)] as const));
    return new Map(texts);
  }
  const [diff, docs, candidateDocs] = await Promise.all([
    git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0',
      base, candidate, '--', ...plannerPaths),
    readDocs(base, [keyGuide, persistenceGuide, observerGuide, timestampGuide]),
    readDocs(candidate, [timestampGuide]),
  ]);
  return selectLibraryExperiments(diff, docs, candidateDocs);
}

async function snapshot(git: Git, commit: string, toolLock: string, fixture: LibraryFixture, signal?: AbortSignal): Promise<Snapshot> {
  const { directory: sourceDirectory, entry, lockfile } = librarySources[fixture];
  const sourcePath = sourceDirectory + '/' + entry;
  const [tree, files, lock] = await Promise.all([
    git('rev-parse', commit + '^{tree}'),
    git('ls-tree', '-z', '--name-only', commit + ':' + sourceDirectory),
    git('cat-file', 'blob', commit + ':' + lockfile),
  ]);
  const resolved = /^  packages\/query-core:\n((?:^    .*\n)*)/m.exec(lock)?.[1];
  if (fixture === libraryFixture && !resolved) {
    throw new InvestigationError('invalid-input', 'Cannot identify the query-core dependency lock');
  }
  const usesStableHash = fixture === libraryFixture && resolved?.includes('      stable-hash:\n');
  if (usesStableHash) {
    const dependency = JSON.parse(toolLock).packages['node_modules/stable-hash'];
    const integrity = /^  stable-hash@0\.0\.6:\n    resolution: \{integrity: ([^}]+)\}/m.exec(lock)?.[1];
    if (!/^      stable-hash:\n        specifier: [^\n]+\n        version: 0\.0\.6$/m.test(resolved!) ||
        dependency.version !== '0.0.6' || integrity !== dependency.integrity) {
      throw new InvestigationError('invalid-input', 'The query-core stable-hash lock does not match the adapter pin');
    }
  }

  const sources = files.split('\0').filter(name => fixture === zustandFixture
    ? name === entry : /^[a-zA-Z][a-zA-Z0-9]*\.ts$/.test(name));
  if (!sources.includes(entry) || sources.length > 64) {
    throw new InvestigationError('invalid-input', 'Unsupported library source layout for ' + fixture);
  }
  // Read all source blobs before creating the build directory. A failed read cannot race cleanup.
  const contents = await Promise.all(sources.map(name => git('cat-file', 'blob', commit + ':' + sourceDirectory + '/' + name)));
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-library-source-'));
  try {
    for (const [index, name] of sources.entries()) {
      await writeFile(join(directory, name), contents[index]!, { flag: 'wx', mode: 0o600 });
    }
    const module = await runProcess('Library build', process.execPath, [
      fileURLToPath(new URL('build.mjs', buildDirectory)), directory, entry, ...(usesStableHash ? ['stable-hash'] : []),
    ], { timeout: 30_000, maxBuffer: 1024 * 1024, signal });
    return { commit, tree: tree.trim(), sourcePath, lockSha256: digest(lock), moduleSha256: digest(module), module };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function environment(lockSha256: string, fixture: LibraryFixture): Promise<HarnessIdentity> {
  const replayFiles = ['library.js', 'library-worker.js', 'library-cases.js', 'execution.js', 'revision.js'];
  const hashes = await Promise.all(replayFiles.map(async file => digest(await readFile(new URL(file, import.meta.url)))));
  const otherFiles = ['cli.js', 'library-planner.js'];
  const otherHashes = await Promise.all(otherFiles.map(async file => digest(await readFile(new URL(file, import.meta.url)))));
  return {
    fixture, node: process.version, lockSha256,
    replaySha256: digest(hashes.join(':')),
    harnessSha256: digest([...hashes, ...otherHashes].join(':')),
  };
}

async function compare(reference: Snapshot, candidate: Snapshot, plan: LibraryCase[],
  fixture: LibraryFixture, planning: LibraryPlanning | undefined, savedChecks: LibraryResultChecks | undefined,
  signal?: AbortSignal): Promise<LibraryInvestigation['result']> {
  verifySnapshot(reference, 'reference');
  verifySnapshot(candidate, 'candidate');
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-query-run-'));
  const snapshotPath = join(directory, 'baseline.json');
  async function observe(side: string, artifact: Snapshot, baseline?: string) {
    const modulePath = join(directory, side + '.mjs');
    await writeFile(modulePath, artifact.module, { flag: 'wx', mode: 0o600 });
    const args = [fileURLToPath(new URL('./library-worker.js', import.meta.url)),
      pathToFileURL(modulePath).href, JSON.stringify(plan)];
    if (baseline) args.push(baseline);
    const stdout = await runProcess(side + ' library worker', process.execPath, args, {
      timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, NODE_ENV: 'production' }, signal,
    });
    const output = parseWorkerOutput(stdout, side + ' library worker') as { observations: LibraryLookups; snapshot?: unknown } | null;
    for (const id of plan) {
      const values = output?.observations?.[id];
      if (!Array.isArray(values) || values.length !== expectedLookups[id].length ||
          values.some(value => value !== null && typeof value !== 'string')) {
        throw new InvestigationError('invalid-observations', 'Invalid library observations for ' + id);
      }
    }
    return output!;
  }

  try {
    const baseline = await observe('reference', reference);
    if (savedChecks && !isDeepStrictEqual(
      plan.map(id => ({ id, expected: expectedLookups[id], reference: baseline.observations[id] })),
      savedChecks.map(({ id, expected, reference }) => ({ id, expected, reference })),
    )) {
      throw new InvestigationError('reference-failed', 'The saved library reference observations did not reproduce');
    }
    const restore = plan.includes('restore-baseline-cache');
    if (restore) {
      if (!baseline.snapshot) throw new InvestigationError('invalid-observations', 'Missing baseline cache snapshot');
      await writeFile(snapshotPath, JSON.stringify(baseline.snapshot), { flag: 'wx', mode: 0o600 });
    }
    const trial = await observe('candidate', candidate, restore ? snapshotPath : undefined);
    const preExisting: LibraryCase[] = [];
    const invalidReference: LibraryCase[] = [];
    const checks = plan.map(id => {
      const expected = expectedLookups[id];
      const reference = baseline.observations[id]!;
      const candidate = trial.observations[id]!;
      const matched = isDeepStrictEqual(expected, candidate);
      const referenceMatched = isDeepStrictEqual(expected, reference);
      // Passing controls isolate failures in list expansion or null replacement.
      const controls = id === 'optimistic-query-count' ? 2 : id === 'zustand-null-update' ? 3 : 0;
      const validControl = controls > 0 &&
        isDeepStrictEqual(reference.slice(0, controls), expected.slice(0, controls)) &&
        isDeepStrictEqual(candidate.slice(0, controls), expected.slice(0, controls));
      const repaired = !referenceMatched && matched && validControl;
      const sameFailure = !referenceMatched && validControl && isDeepStrictEqual(reference, candidate);
      const contractAdded = id === 'dehydration-timestamp' &&
        planning?.experiments.find(experiment => experiment.id === id)?.contract.revision === 'candidate' &&
        reference.every((value, index) => value === expected[index % 3]);
      if (!referenceMatched && !repaired && !contractAdded && !sameFailure) {
        invalidReference.push(id);
      }
      if (sameFailure) preExisting.push(id);
      return {
        id, expected, reference, candidate, matched,
        ...(repaired ? { repaired: true as const } : {}),
        ...(contractAdded ? { contractAdded: true as const } : {}),
      };
    });
    if (invalidReference.length) return {
      ...inconclusive(new InvestigationError('reference-failed',
        'Reference violates the documented behavior in ' + invalidReference.join(', '))), checks,
    };
    if (preExisting.length && !checks.some(check => !check.matched &&
        (check.contractAdded || isDeepStrictEqual(check.reference, check.expected)))) return {
      schemaVersion: 1, verdict: 'inconclusive', reasonCode: 'shared-failure', checks,
      reason: 'Both revisions fail the same documented behavior with passing controls: ' + preExisting.join(', '),
    };
    return { schemaVersion: 1, fixture, verdict: checks.every(check => check.matched) ? 'pass' : 'regression', checks };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type LibraryResultChecks = NonNullable<LibraryInvestigation['result']['checks']>;

type Request = { repository: string; base: string; candidate: string; select?: boolean; shortlist?: boolean; fixture?: LibraryFixture }
  | { replayOf: string } | { verificationOf: string; repository: string; candidate: string };

async function selectFromRuns(git: Git, base: string, candidate: string) {
  const diff = await git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0',
    base, candidate, '--');
  const { suggestions } = suggestExperiments(diff);
  for (const item of suggestions) {
    if (!isLibraryFixture(item.fixture)) continue;
    const { directory, entry, lockfile } = librarySources[item.fixture];
    const files = [directory + '/' + entry, lockfile];
    const trees = await Promise.all([base, candidate].map(ref =>
      git('ls-tree', '-r', '-z', '--name-only', ref, '--', ...files)));
    if (!trees.every(tree => files.every(path => tree.split('\0').includes(path)))) continue;
    const checks = item.coverage.flatMap(target => target.checks);
    return { fixture: item.fixture, plan: libraryPlan.filter(id => checks.includes(id)),
      selection: { exampleRunId: item.example.runId, coverage: item.coverage } };
  }
}

export async function investigateLibrary(request: Request, signal?: AbortSignal) {
  const store = openEvidence('.tracetern');
  try {
    const replayOf = 'replayOf' in request ? request.replayOf : undefined;
    const verificationOf = 'verificationOf' in request ? request.verificationOf : undefined;
    const originalId = replayOf ?? verificationOf;
    const original = originalId ? store.loadLibrary(originalId) : undefined;
    let fixture = original?.adapter ?? ('fixture' in request ? request.fixture : undefined) ?? libraryFixture;
    let reference: Snapshot;
    let candidate: Snapshot;
    let lockSha256: string;
    let buildSha256 = original?.environment.buildSha256;
    let planning: LibraryPlanning | undefined = original?.planning;
    let selection: LibrarySelection | undefined = original?.selection;
    let plan: LibraryCase[] = original?.plan ?? (fixture === zustandFixture ? ['zustand-null-update'] : defaultLibraryPlan);
    if ('base' in request) {
      const git = gitFor(request.repository, signal);
      const [baseCommit, candidateCommit] = await Promise.all([
        pin(git, request.base), pin(git, request.candidate),
      ]);
      if (request.shortlist) {
        const selected = await selectFromRuns(git, baseCommit, candidateCommit);
        if (!selected) return {
          schemaVersion: 1, verdict: 'inconclusive' as const,
          reasonCode: 'no-coverage' as const,
          reason: 'No saved experiment matches both the changed behavior and a supported library layout',
          baseCommit, candidateCommit,
        };
        ({ fixture, plan, selection } = selected);
      } else if (request.select) {
        planning = await planChange(git, baseCommit, candidateCommit);
        plan = planning.experiments.map(experiment => experiment.id);
        if (plan.length === 0) {
          return {
            schemaVersion: 1, verdict: 'inconclusive' as const,
            reasonCode: 'no-coverage' as const,
            reason: 'No supported experiment matched both a changed hunk and a documented contract',
            plan, planning, baseCommit, candidateCommit,
          };
        }
      }
      const build = await readBuildInputs();
      ({ lockSha256, buildSha256 } = build);
      const [baseline, trial] = await Promise.allSettled([
        snapshot(git, baseCommit, build.toolLock, fixture, signal),
        snapshot(git, candidateCommit, build.toolLock, fixture, signal),
      ]);
      if (baseline.status === 'rejected') throw baseline.reason;
      if (trial.status === 'rejected') throw trial.reason;
      [reference, candidate] = [baseline.value, trial.value];
    } else {
      if (!original) throw new Error('Missing library investigation to rerun');
      ({ reference, candidate } = original);
      lockSha256 = original.environment.lockSha256;
      if ('verificationOf' in request) {
        if (!original.result.checks?.length ||
            (original.result.verdict === 'inconclusive' && original.result.reasonCode !== undefined &&
              original.result.reasonCode !== 'shared-failure')) {
          throw new InvestigationError('invalid-input', 'Verification requires recorded library observations and passing controls');
        }
        const build = await readBuildInputs();
        if (build.lockSha256 !== lockSha256 || (buildSha256 && build.buildSha256 !== buildSha256)) {
          throw new InvestigationError('incompatible-replay', 'Verification requires the recorded library build lock and builder');
        }
        buildSha256 = build.buildSha256;
        const git = gitFor(request.repository, signal);
        const candidateCommit = await pin(git, request.candidate);
        candidate = await snapshot(git, candidateCommit, build.toolLock, fixture, signal);
      }
    }
    if (!reference || !candidate) throw new InvestigationError('artifact-invalid', 'Missing saved library snapshot');
    const identity = { ...await environment(lockSha256, fixture), buildSha256 };

    let result: LibraryInvestigation['result'];
    try {
      plan = validateLibraryPlan(plan);
      if (plan.some(id => (id === 'zustand-null-update') !== (fixture === zustandFixture))) {
        throw new InvestigationError('invalid-input', 'Plan contains a case from another library adapter');
      }
      const oldSuite = original?.environment.replaySha256 === originalSuiteSha256 &&
        isDeepStrictEqual(plan, defaultLibraryPlan);
      // This release adds a new case. Its changes leave the prior planned cases intact.
      const oldPlan = original?.environment.replaySha256 === originalPlannerReplaySha256 &&
        plan.every(id => defaultLibraryPlan.includes(id));
      const oldObserver = original?.environment.replaySha256 === observerReplaySha256 &&
        !plan.includes('dehydration-timestamp');
      const oldTimestamp = original?.environment.replaySha256 === timestampReplaySha256;
      const priorReplay = original?.environment.replaySha256 === priorLibraryReplaySha256 ||
        original?.environment.replaySha256 === previousReplaySha256;
      if (original && (original.environment.fixture !== fixture || original.environment.node !== identity.node ||
          (!(priorReplay || (fixture === libraryFixture && (oldSuite || oldPlan || oldObserver || oldTimestamp))) &&
            original.environment.replaySha256 !== identity.replaySha256))) {
        throw new InvestigationError('incompatible-replay', 'Rerun requires compatible library replay code, plan and Node version');
      }
      result = await compare(reference, candidate, plan, fixture, planning, verificationOf ? original?.result.checks : undefined, signal);
    } catch (error) {
      result = inconclusive(error);
    }
    checkCancellation(signal);

    const investigation: LibraryInvestigation = {
      adapter: fixture, reference, candidate, plan, planning, selection,
      environment: result.verdict === 'inconclusive' && !result.checks && original ? original.environment : identity,
      result, replayOf, verificationOf,
    };
    const runId = store.save(investigation);
    const previous = original?.result;
    const reproduced = replayOf && previous?.checks && result.checks
      ? previous.verdict === result.verdict && isDeepStrictEqual(previous.checks, result.checks) : undefined;
    return {
      ...result, plan, planning, selection, runId, baseCommit: reference.commit, candidateCommit: candidate.commit,
      replayOf, verificationOf, reproduced,
    };
  } finally {
    store.close();
  }
}

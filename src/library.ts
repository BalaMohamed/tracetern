import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { openEvidence, type LibraryInvestigation, type LibrarySelection } from './evidence.js';
import { defaultLibraryPlan, expectedLookups, isLibraryFixture, libraryFixture, libraryPlan, validateLibraryPlan, zustandFixture,
  type LibraryCase, type LibraryFixture, type LibraryLookups } from './library-cases.js';
import { keyGuide, observerGuide, persistenceGuide, timestampGuide, plannerPaths,
  selectLibraryExperiments, type LibraryPlanning } from './library-planner.js';
import { suggestExperiments } from './retrieval.js';
import { digest, type HarnessIdentity, type Snapshot } from './revision.js';

const execute = promisify(execFile);
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

async function git(repository: string, ...args: string[]) {
  return (await execute('git', ['-C', repository, ...args], {
    timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
}

async function pin(repository: string, ref: string) {
  return (await git(repository, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}')).trim();
}

async function planChange(repository: string, base: string, candidate: string) {
  async function readDocs(revision: string, paths: string[]) {
    const entries = await git(repository, 'ls-tree', '-r', '-z', '--name-only', revision, '--', ...paths);
    const texts = await Promise.all(entries.split('\0').filter(path => paths.includes(path)).map(async path =>
      [path, await git(repository, 'cat-file', 'blob', revision + ':' + path)] as const));
    return new Map(texts);
  }
  const [diff, docs, candidateDocs] = await Promise.all([
    git(repository, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0',
      base, candidate, '--', ...plannerPaths),
    readDocs(base, [keyGuide, persistenceGuide, observerGuide, timestampGuide]),
    readDocs(candidate, [timestampGuide]),
  ]);
  return selectLibraryExperiments(diff, docs, candidateDocs);
}

async function snapshot(repository: string, commit: string, toolLock: string, fixture: LibraryFixture): Promise<Snapshot> {
  const { directory: sourceDirectory, entry, lockfile } = librarySources[fixture];
  const sourcePath = sourceDirectory + '/' + entry;
  const [tree, files, lock] = await Promise.all([
    git(repository, 'rev-parse', commit + '^{tree}'),
    git(repository, 'ls-tree', '-z', '--name-only', commit + ':' + sourceDirectory),
    git(repository, 'cat-file', 'blob', commit + ':' + lockfile),
  ]);
  const resolved = /^  packages\/query-core:\n((?:^    .*\n)*)/m.exec(lock)?.[1];
  if (fixture === libraryFixture && !resolved) throw new Error('Cannot identify the query-core dependency lock');
  const usesStableHash = fixture === libraryFixture && resolved?.includes('      stable-hash:\n');
  if (usesStableHash) {
    const dependency = JSON.parse(toolLock).packages['node_modules/stable-hash'];
    const integrity = /^  stable-hash@0\.0\.6:\n    resolution: \{integrity: ([^}]+)\}/m.exec(lock)?.[1];
    if (!/^      stable-hash:\n        specifier: [^\n]+\n        version: 0\.0\.6$/m.test(resolved!) ||
        dependency.version !== '0.0.6' || integrity !== dependency.integrity) {
      throw new Error('The query-core stable-hash lock does not match the adapter pin');
    }
  }

  const sources = files.split('\0').filter(name => fixture === zustandFixture
    ? name === entry : /^[a-zA-Z][a-zA-Z0-9]*\.ts$/.test(name));
  if (!sources.includes(entry) || sources.length > 64) throw new Error('Unsupported library source layout for ' + fixture);
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-library-source-'));
  try {
    await Promise.all(sources.map(async name => {
      const source = await git(repository, 'cat-file', 'blob', commit + ':' + sourceDirectory + '/' + name);
      await writeFile(join(directory, name), source, { mode: 0o600 });
    }));
    const { stdout: module } = await execute(process.execPath, [
      fileURLToPath(new URL('build.mjs', buildDirectory)), directory, entry, ...(usesStableHash ? ['stable-hash'] : []),
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { commit, tree: tree.trim(), sourcePath, lockSha256: digest(lock), moduleSha256: digest(module), module };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function environment(lockSha256: string, fixture: LibraryFixture): Promise<HarnessIdentity> {
  const replayFiles = ['library.js', 'library-worker.js', 'library-cases.js'];
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
  fixture: LibraryFixture, planning?: LibraryPlanning): Promise<LibraryInvestigation['result']> {
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-query-run-'));
  const snapshotPath = join(directory, 'baseline.json');
  async function observe(side: string, artifact: Snapshot, baseline?: string) {
    if (digest(artifact.module) !== artifact.moduleSha256) throw new Error('Module digest mismatch: ' + side);
    const modulePath = join(directory, side + '.mjs');
    await writeFile(modulePath, artifact.module, { flag: 'wx', mode: 0o600 });
    const args = [fileURLToPath(new URL('./library-worker.js', import.meta.url)),
      pathToFileURL(modulePath).href, JSON.stringify(plan)];
    if (baseline) args.push(baseline);
    const { stdout } = await execute(process.execPath, args, {
      timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, NODE_ENV: 'production' },
    });
    const output = JSON.parse(stdout) as { observations: LibraryLookups; snapshot?: unknown };
    for (const id of plan) {
      const values = output.observations?.[id];
      if (!Array.isArray(values) || values.length !== expectedLookups[id].length ||
          values.some(value => value !== null && typeof value !== 'string')) {
        throw new Error('Invalid library observations for ' + id);
      }
    }
    return output;
  }

  try {
    const baseline = await observe('reference', reference);
    const restore = plan.includes('restore-baseline-cache');
    if (restore) {
      if (!baseline.snapshot) throw new Error('Missing baseline cache snapshot');
      await writeFile(snapshotPath, JSON.stringify(baseline.snapshot), { flag: 'wx', mode: 0o600 });
    }
    const trial = await observe('candidate', candidate, restore ? snapshotPath : undefined);
    const preExisting: LibraryCase[] = [];
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
        throw new Error('Reference violates the documented behavior in ' + id);
      }
      if (sameFailure) preExisting.push(id);
      return {
        id, expected, reference, candidate, matched,
        ...(repaired ? { repaired: true as const } : {}),
        ...(contractAdded ? { contractAdded: true as const } : {}),
      };
    });
    if (preExisting.length && !checks.some(check => !check.matched &&
        (check.contractAdded || isDeepStrictEqual(check.reference, check.expected)))) return {
      schemaVersion: 1, verdict: 'inconclusive', checks,
      reason: 'Both revisions fail the same documented behavior with passing controls: ' + preExisting.join(', '),
    };
    return { schemaVersion: 1, fixture, verdict: checks.every(check => check.matched) ? 'pass' : 'regression', checks };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Request = { repository: string; base: string; candidate: string; select?: boolean; shortlist?: boolean; fixture?: LibraryFixture }
  | { replayOf: string } | { verificationOf: string; repository: string; candidate: string };

async function selectFromRuns(repository: string, base: string, candidate: string) {
  const diff = await git(repository, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0',
    base, candidate, '--');
  const { suggestions } = suggestExperiments(diff);
  for (const item of suggestions) {
    if (!isLibraryFixture(item.fixture)) continue;
    const { directory, entry, lockfile } = librarySources[item.fixture];
    const files = [directory + '/' + entry, lockfile];
    const trees = await Promise.all([base, candidate].map(ref =>
      git(repository, 'ls-tree', '-r', '-z', '--name-only', ref, '--', ...files)));
    if (!trees.every(tree => files.every(path => tree.split('\0').includes(path)))) continue;
    const checks = item.coverage.flatMap(target => target.checks);
    return { fixture: item.fixture, plan: libraryPlan.filter(id => checks.includes(id)),
      selection: { exampleRunId: item.example.runId, coverage: item.coverage } };
  }
}

export async function investigateLibrary(request: Request) {
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
    let planning: LibraryPlanning | undefined = original?.planning;
    let selection: LibrarySelection | undefined = original?.selection;
    let plan: LibraryCase[] = original?.plan ?? (fixture === zustandFixture ? ['zustand-null-update'] : defaultLibraryPlan);
    if ('base' in request) {
      const [baseCommit, candidateCommit] = await Promise.all([
        pin(request.repository, request.base), pin(request.repository, request.candidate),
      ]);
      if (request.shortlist) {
        const selected = await selectFromRuns(request.repository, baseCommit, candidateCommit);
        if (!selected) return {
          schemaVersion: 1, verdict: 'inconclusive' as const,
          reason: 'No saved experiment matches both the changed behavior and a supported library layout',
          baseCommit, candidateCommit,
        };
        ({ fixture, plan, selection } = selected);
      } else if (request.select) {
        planning = await planChange(request.repository, baseCommit, candidateCommit);
        plan = planning.experiments.map(experiment => experiment.id);
        if (plan.length === 0) {
          return {
            schemaVersion: 1, verdict: 'inconclusive' as const,
            reason: 'No supported experiment matched both a changed hunk and a documented contract',
            plan, planning, baseCommit, candidateCommit,
          };
        }
      }
      const toolLock = await readFile(lockURL, 'utf8');
      lockSha256 = digest(toolLock);
      [reference, candidate] = await Promise.all([
        snapshot(request.repository, baseCommit, toolLock, fixture),
        snapshot(request.repository, candidateCommit, toolLock, fixture),
      ]);
    } else {
      if (!original) throw new Error('Missing library investigation to rerun');
      ({ reference, candidate } = original);
      lockSha256 = original.environment.lockSha256;
      if ('verificationOf' in request) {
        if (!original.result.checks?.length) {
          throw new Error('Verification requires recorded library observations and passing controls');
        }
        const toolLock = await readFile(lockURL, 'utf8');
        if (digest(toolLock) !== lockSha256) throw new Error('Verification requires the recorded library build lock');
        const candidateCommit = await pin(request.repository, request.candidate);
        candidate = await snapshot(request.repository, candidateCommit, toolLock, fixture);
      }
    }
    const identity = await environment(lockSha256, fixture);

    let result: LibraryInvestigation['result'];
    try {
      plan = validateLibraryPlan(plan);
      if (plan.some(id => (id === 'zustand-null-update') !== (fixture === zustandFixture))) {
        throw new Error('Plan contains a case from another library adapter');
      }
      const oldSuite = original?.environment.replaySha256 === originalSuiteSha256 &&
        isDeepStrictEqual(plan, defaultLibraryPlan);
      // This release adds a new case. Its changes leave the prior planned cases intact.
      const oldPlan = original?.environment.replaySha256 === originalPlannerReplaySha256 &&
        plan.every(id => defaultLibraryPlan.includes(id));
      const oldObserver = original?.environment.replaySha256 === observerReplaySha256 &&
        !plan.includes('dehydration-timestamp');
      const oldTimestamp = original?.environment.replaySha256 === timestampReplaySha256;
      const priorReplay = original?.environment.replaySha256 === priorLibraryReplaySha256;
      if (original && (original.environment.node !== identity.node ||
          (!(priorReplay || (fixture === libraryFixture && (oldSuite || oldPlan || oldObserver || oldTimestamp))) &&
            original.environment.replaySha256 !== identity.replaySha256))) {
        throw new Error('Rerun requires compatible library replay code, plan and Node version');
      }
      result = await compare(reference, candidate, plan, fixture, planning);
      if (verificationOf && result.checks) {
        const referenceEvidence = result.checks.map(({ id, expected, reference }) => ({ id, expected, reference }));
        const savedEvidence = original?.result.checks?.map(({ id, expected, reference }) => ({ id, expected, reference }));
        if (!isDeepStrictEqual(referenceEvidence, savedEvidence)) {
          throw new Error('The saved library reference observations did not reproduce');
        }
      }
    } catch (error) {
      result = { schemaVersion: 1, verdict: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
    }

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

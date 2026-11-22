import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { openEvidence, type Inconclusive, type LibraryInvestigation } from './evidence.js';
import { defaultLibraryPlan, expectedLookups, libraryFixture, validateLibraryPlan,
  type LibraryCase, type LibraryLookups, type LibraryResult } from './library-cases.js';
import { keyGuide, observerGuide, persistenceGuide, timestampGuide, plannerPaths,
  selectLibraryExperiments, type LibraryPlanning } from './library-planner.js';
import { digest, type HarnessIdentity, type Snapshot } from './revision.js';

const execute = promisify(execFile);
const sourceDirectory = 'packages/query-core/src';
const sourcePath = sourceDirectory + '/index.ts';
const buildDirectory = new URL('../../adapters/tanstack/', import.meta.url);
const lockURL = new URL('package-lock.json', buildDirectory);
// The f71e0b4 runner saved the same cases as a single, fixed suite.
const originalSuiteSha256 = '8eb06fd88f2efd6abe5fb65fa34c88de4a2c1b8379beac3306a346ec03299249';
const originalPlannerReplaySha256 = '6557869a9416c9b8dc69b68f7319e58f098e823ba997a45b4ad7d1a692696531';
const observerReplaySha256 = 'fb45aafe0f79edfac71ee09acc5689577b1c80af039da505ad967bfaa80d1012';

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

async function snapshot(repository: string, commit: string, toolLock: string): Promise<Snapshot> {
  const [tree, files, lock] = await Promise.all([
    git(repository, 'rev-parse', commit + '^{tree}'),
    git(repository, 'ls-tree', '-z', '--name-only', commit + ':' + sourceDirectory),
    git(repository, 'cat-file', 'blob', commit + ':pnpm-lock.yaml'),
  ]);
  const resolved = /^  packages\/query-core:\n((?:^    .*\n)*)/m.exec(lock)?.[1];
  if (!resolved) throw new Error('Cannot identify the query-core dependency lock');
  const usesStableHash = resolved.includes('      stable-hash:\n');
  if (usesStableHash) {
    const dependency = JSON.parse(toolLock).packages['node_modules/stable-hash'];
    const integrity = /^  stable-hash@0\.0\.6:\n    resolution: \{integrity: ([^}]+)\}/m.exec(lock)?.[1];
    if (!/^      stable-hash:\n        specifier: [^\n]+\n        version: 0\.0\.6$/m.test(resolved) ||
        dependency.version !== '0.0.6' || integrity !== dependency.integrity) {
      throw new Error('The query-core stable-hash lock does not match the adapter pin');
    }
  }

  const sources = files.split('\0').filter(name => /^[a-zA-Z][a-zA-Z0-9]*\.ts$/.test(name));
  if (!sources.includes('index.ts') || sources.length > 64) throw new Error('Unsupported query-core source layout');
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-query-source-'));
  try {
    await Promise.all(sources.map(async name => {
      const source = await git(repository, 'cat-file', 'blob', commit + ':' + sourceDirectory + '/' + name);
      await writeFile(join(directory, name), source, { mode: 0o600 });
    }));
    const { stdout: module } = await execute(process.execPath, [
      fileURLToPath(new URL('build.mjs', buildDirectory)), directory, ...(usesStableHash ? ['stable-hash'] : []),
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { commit, tree: tree.trim(), sourcePath, lockSha256: digest(lock), moduleSha256: digest(module), module };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function environment(lockSha256: string): Promise<HarnessIdentity> {
  const replayFiles = ['library.js', 'library-worker.js', 'library-cases.js'];
  const hashes = await Promise.all(replayFiles.map(async file => digest(await readFile(new URL(file, import.meta.url)))));
  const otherFiles = ['cli.js', 'library-planner.js'];
  const otherHashes = await Promise.all(otherFiles.map(async file => digest(await readFile(new URL(file, import.meta.url)))));
  return {
    fixture: libraryFixture, node: process.version, lockSha256,
    replaySha256: digest(hashes.join(':')),
    harnessSha256: digest([...hashes, ...otherHashes].join(':')),
  };
}

async function compare(reference: Snapshot, candidate: Snapshot, plan: LibraryCase[], planning?: LibraryPlanning): Promise<LibraryResult> {
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
    const checks = plan.map(id => {
      const expected = expectedLookups[id];
      const reference = baseline.observations[id]!;
      const candidate = trial.observations[id]!;
      const matched = isDeepStrictEqual(expected, candidate);
      const referenceMatched = isDeepStrictEqual(expected, reference);
      // A passing one-query control isolates the baseline failure to the list expansion.
      const repaired = id === 'optimistic-query-count' && !referenceMatched && matched &&
        isDeepStrictEqual(reference.slice(0, 2), expected.slice(0, 2));
      const contractAdded = id === 'dehydration-timestamp' &&
        planning?.experiments.find(experiment => experiment.id === id)?.contract.revision === 'candidate' &&
        reference.every((value, index) => value === expected[index % 3]);
      if (!referenceMatched && !repaired && !contractAdded) {
        throw new Error('Reference violates the documented behavior in ' + id);
      }
      return {
        id, expected, reference, candidate, matched,
        ...(repaired ? { repaired: true as const } : {}),
        ...(contractAdded ? { contractAdded: true as const } : {}),
      };
    });
    return { schemaVersion: 1, fixture: libraryFixture, verdict: checks.every(check => check.matched) ? 'pass' : 'regression', checks };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Request = { repository: string; base: string; candidate: string; select?: boolean } | { replayOf: string };

export async function investigateLibrary(request: Request) {
  const store = openEvidence('.tracetern');
  try {
    const original = 'replayOf' in request ? store.loadLibrary(request.replayOf) : undefined;
    const replayOf = 'replayOf' in request ? request.replayOf : undefined;
    let reference: Snapshot;
    let candidate: Snapshot;
    let lockSha256: string;
    let planning: LibraryPlanning | undefined = original?.planning;
    let plan = original?.plan ?? defaultLibraryPlan;
    if ('repository' in request) {
      const [baseCommit, candidateCommit] = await Promise.all([
        pin(request.repository, request.base), pin(request.repository, request.candidate),
      ]);
      if (request.select) {
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
        snapshot(request.repository, baseCommit, toolLock),
        snapshot(request.repository, candidateCommit, toolLock),
      ]);
    } else {
      if (!original) throw new Error('Missing library investigation to rerun');
      ({ reference, candidate } = original);
      lockSha256 = original.environment.lockSha256;
    }
    const identity = await environment(lockSha256);

    let result: LibraryResult | Inconclusive;
    try {
      plan = validateLibraryPlan(plan);
      const oldSuite = original?.environment.replaySha256 === originalSuiteSha256 &&
        isDeepStrictEqual(plan, defaultLibraryPlan);
      // This release adds a new case. Its changes leave the prior planned cases intact.
      const oldPlan = original?.environment.replaySha256 === originalPlannerReplaySha256 &&
        plan.every(id => defaultLibraryPlan.includes(id));
      const oldObserver = original?.environment.replaySha256 === observerReplaySha256 &&
        !plan.includes('dehydration-timestamp');
      if (original && (original.environment.node !== identity.node ||
          (!oldSuite && !oldPlan && !oldObserver && original.environment.replaySha256 !== identity.replaySha256))) {
        throw new Error('Rerun requires compatible library replay code, plan and Node version');
      }
      result = await compare(reference, candidate, plan, planning);
    } catch (error) {
      result = { schemaVersion: 1, verdict: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
    }

    const investigation: LibraryInvestigation = {
      adapter: libraryFixture, reference, candidate, plan, planning,
      environment: result.verdict === 'inconclusive' && original ? original.environment : identity,
      result, replayOf,
    };
    const runId = store.save(investigation);
    const previous = original?.result;
    const reproduced = previous && previous.verdict !== 'inconclusive' && result.verdict !== 'inconclusive'
      ? isDeepStrictEqual(previous.checks, result.checks) : undefined;
    return {
      ...result, plan, planning, runId, baseCommit: reference.commit, candidateCommit: candidate.commit,
      replayOf, reproduced,
    };
  } finally {
    store.close();
  }
}

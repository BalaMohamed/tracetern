import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { openEvidence, type Inconclusive, type LibraryInvestigation } from './evidence.js';
import { expectedLookups, libraryFixture, libraryPlan, type LibraryLookups, type LibraryResult } from './library-cases.js';
import { digest, type HarnessIdentity, type Snapshot } from './revision.js';

const execute = promisify(execFile);
const sourceDirectory = 'packages/query-core/src';
const sourcePath = sourceDirectory + '/index.ts';
const buildDirectory = new URL('../../adapters/tanstack/', import.meta.url);
const lockURL = new URL('package-lock.json', buildDirectory);

async function snapshot(repository: string, ref: string, toolLock: string): Promise<Snapshot> {
  const git = async (...args: string[]) => (await execute('git', ['-C', repository, ...args], {
    timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  const commit = (await git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}')).trim();
  const [tree, files, lock] = await Promise.all([
    git('rev-parse', commit + '^{tree}'),
    git('ls-tree', '-z', '--name-only', commit + ':' + sourceDirectory),
    git('cat-file', 'blob', commit + ':pnpm-lock.yaml'),
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
      const source = await git('cat-file', 'blob', commit + ':' + sourceDirectory + '/' + name);
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
  const presentation = await readFile(new URL('cli.js', import.meta.url));
  return {
    fixture: libraryFixture, node: process.version, lockSha256,
    replaySha256: digest(hashes.join(':')),
    harnessSha256: digest([...hashes, digest(presentation)].join(':')),
  };
}

async function compare(reference: Snapshot, candidate: Snapshot): Promise<LibraryResult> {
  const directory = await mkdtemp(join(tmpdir(), 'tracetern-query-run-'));
  const snapshotPath = join(directory, 'baseline.json');
  async function observe(side: string, artifact: Snapshot, baseline?: string) {
    if (digest(artifact.module) !== artifact.moduleSha256) throw new Error('Module digest mismatch: ' + side);
    const modulePath = join(directory, side + '.mjs');
    await writeFile(modulePath, artifact.module, { flag: 'wx', mode: 0o600 });
    const args = [fileURLToPath(new URL('./library-worker.js', import.meta.url)), pathToFileURL(modulePath).href];
    if (baseline) args.push(baseline);
    const { stdout } = await execute(process.execPath, args, {
      timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, NODE_ENV: 'production' },
    });
    const output = JSON.parse(stdout) as { observations: LibraryLookups; snapshot?: unknown };
    for (const id of libraryPlan) {
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
    if (!baseline.snapshot) throw new Error('Missing baseline cache snapshot');
    await writeFile(snapshotPath, JSON.stringify(baseline.snapshot), { flag: 'wx', mode: 0o600 });
    const trial = await observe('candidate', candidate, snapshotPath);
    const checks = libraryPlan.map(id => {
      const expected = expectedLookups[id];
      if (!isDeepStrictEqual(expected, baseline.observations[id])) {
        throw new Error('Reference violates the documented cache behavior in ' + id);
      }
      return {
        id, expected, reference: baseline.observations[id], candidate: trial.observations[id],
        matched: isDeepStrictEqual(expected, trial.observations[id]),
      };
    });
    return { schemaVersion: 1, fixture: libraryFixture, verdict: checks.every(check => check.matched) ? 'pass' : 'regression', checks };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Request = { repository: string; base: string; candidate: string } | { replayOf: string };

export async function investigateLibrary(request: Request) {
  const store = openEvidence('.tracetern');
  try {
    const original = 'replayOf' in request ? store.loadLibrary(request.replayOf) : undefined;
    const replayOf = 'replayOf' in request ? request.replayOf : undefined;
    let reference: Snapshot;
    let candidate: Snapshot;
    let lockSha256: string;
    if ('repository' in request) {
      const toolLock = await readFile(lockURL, 'utf8');
      lockSha256 = digest(toolLock);
      [reference, candidate] = await Promise.all([
        snapshot(request.repository, request.base, toolLock),
        snapshot(request.repository, request.candidate, toolLock),
      ]);
    } else {
      if (!original) throw new Error('Missing library investigation to rerun');
      ({ reference, candidate } = original);
      lockSha256 = original.environment.lockSha256;
    }
    const identity = await environment(lockSha256);

    let result: LibraryResult | Inconclusive;
    try {
      if (original && (original.environment.node !== identity.node ||
          original.environment.replaySha256 !== identity.replaySha256 ||
          !isDeepStrictEqual(original.plan, libraryPlan))) {
        throw new Error('Rerun requires compatible library replay code, plan and Node version');
      }
      result = await compare(reference, candidate);
    } catch (error) {
      result = { schemaVersion: 1, verdict: 'inconclusive', reason: error instanceof Error ? error.message : String(error) };
    }

    const investigation: LibraryInvestigation = {
      adapter: libraryFixture, reference, candidate, plan: original?.plan ?? libraryPlan,
      environment: result.verdict === 'inconclusive' && original ? original.environment : identity,
      result, replayOf,
    };
    const runId = store.save(investigation);
    const previous = original?.result;
    const reproduced = previous && previous.verdict !== 'inconclusive' && result.verdict !== 'inconclusive'
      ? isDeepStrictEqual(previous.checks, result.checks) : undefined;
    return {
      ...result, plan: investigation.plan, runId, baseCommit: reference.commit, candidateCommit: candidate.commit,
      replayOf, reproduced,
    };
  } finally {
    store.close();
  }
}

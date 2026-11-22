import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { InvestigationError, runProcess } from './execution.js';

const sourcePath = 'src/orders.ts';

export function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Snapshot {
  commit: string;
  tree: string;
  sourcePath: string;
  lockSha256: string;
  moduleSha256: string;
  module: string;
}

export interface HarnessIdentity {
  fixture: string;
  node: string;
  harnessSha256: string;
  replaySha256?: string;
  buildSha256?: string;
  lockSha256: string;
}

export function verifySnapshot(artifact: Snapshot | undefined, side: string) {
  if (typeof artifact?.module !== 'string' || digest(artifact.module) !== artifact.moduleSha256) {
    throw new InvestigationError('artifact-invalid', 'Module digest mismatch or missing module: ' + side);
  }
}

// Only the service under test changes. Fixture, driver and comparator come
// from the running TraceTern installation on both sides of the experiment.
export async function snapshot(ref: string, signal?: AbortSignal): Promise<Snapshot> {
  const git = (label: string, ...args: string[]) => runProcess(label, 'git', args,
    { maxBuffer: 4 * 1024 * 1024, timeout: 15_000, signal }, 'invalid-input');
  const commit = (await git('Resolve Orders revision', 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}')).trim();
  const [tree, source, lock] = await Promise.all([
    git('Read Orders tree', 'rev-parse', commit + '^{tree}'),
    git('Read committed Orders source', 'cat-file', 'blob', commit + ':' + sourcePath),
    git('Read committed Orders lock', 'cat-file', 'blob', commit + ':package-lock.json'),
  ]);
  const module = stripTypeScriptTypes(source);
  return { commit, tree: tree.trim(), sourcePath, lockSha256: digest(lock), moduleSha256: digest(module), module };
}

export async function harnessIdentity() {
  const replayFiles = [
    'worker.js', 'scenario.js', 'orders.js', 'investigation.js', 'revision.js', 'execution.js',
    'experiment.js', 'query-groups.js', '../../scripts/with-postgres.sh',
  ];
  const hashFiles = (files: string[]) => Promise.all(
    files.map(async name => digest(await readFile(new URL(name, import.meta.url)))),
  );
  const [replayHashes, otherHashes, lock] = await Promise.all([
    hashFiles(replayFiles),
    hashFiles(['cli.js', 'planner.js', 'evidence.js']),
    readFile(new URL('../../package-lock.json', import.meta.url)),
  ]);
  return {
    fixture: 'orders-list/v1', node: process.version,
    harnessSha256: digest([...replayHashes, ...otherHashes].join(':')),
    replaySha256: digest(replayHashes.join(':')),
    lockSha256: digest(lock),
  };
}

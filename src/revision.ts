import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { promisify } from 'node:util';

const execute = promisify(execFile);
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

async function git(args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
  return stdout;
}

// Only the service under test changes. Fixture, driver and comparator come
// from the running TraceTern installation on both sides of the experiment.
export async function snapshot(ref: string): Promise<Snapshot> {
  const commit = (await git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim();
  const [tree, source, lock] = await Promise.all([
    git(['rev-parse', commit + '^{tree}']),
    git(['cat-file', 'blob', commit + ':' + sourcePath]),
    git(['cat-file', 'blob', commit + ':package-lock.json']),
  ]);
  const module = stripTypeScriptTypes(source);
  return { commit, tree: tree.trim(), sourcePath, lockSha256: digest(lock), moduleSha256: digest(module), module };
}

export async function harnessIdentity() {
  const files = ['cli.js', 'worker.js', 'scenario.js', 'orders.js', 'investigation.js', 'revision.js', 'evidence.js', 'experiment.js', 'planner.js'];
  const hashes = await Promise.all(files.map(async name => digest(await readFile(new URL(name, import.meta.url)))));
  return {
    fixture: 'orders-list/v1', node: process.version, harnessSha256: digest(hashes.join(':')),
    lockSha256: digest(await readFile(new URL('../../package-lock.json', import.meta.url))),
  };
}

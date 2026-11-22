import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { datafusionFixture, openEvidence, type EvidenceCheck } from './evidence.js';
import { digest } from './revision.js';

const execute = promisify(execFile);
const probe = fileURLToPath(new URL('../../adapters/datafusion/probe.py', import.meta.url));
const environments = fileURLToPath(new URL('../../.tracetern/datafusion/venvs/', import.meta.url));
const releases = {
  broken: { binding: '54.0.0', engine: '54.0.0', commit: '45d943dfb8699dc9cb9ef2320e955b73e3e6c03b' },
  fixed: { binding: '55.0.0', engine: '55.2.0', commit: '500744d5c25499055e3b2ca46b022bc425989203' },
};
export type DataFusionMode = 'broken' | 'fixed' | 'disabled';
interface Runtime {
  engine: string;
  binding: string;
  python: string;
  arrow: string;
  nativeSha256: string;
}
interface Probe {
  runtime: Runtime;
  observations: { nested: number[]; pruned: number; unoptimized: number[]; inferred: number[]; scalar: number[] };
}
interface EngineRun extends Probe {
  commit: string;
  pushdown: boolean;
  sourcePath: string;
}
export interface DataFusionInvestigation {
  adapter: typeof datafusionFixture;
  fixtureImplementation: DataFusionMode;
  reference: EngineRun;
  candidate: EngineRun;
  environment: { fixture: typeof datafusionFixture; harnessSha256: string };
  parquet: { sha256: string; base64: string };
  result: { schemaVersion: 1; fixture: typeof datafusionFixture; verdict: 'pass' | 'regression'; checks: EvidenceCheck[] };
  replayOf?: string;
}

async function probeRelease(cwd: string, mode: DataFusionMode, create: boolean): Promise<EngineRun> {
  const release = releases[mode === 'fixed' ? 'fixed' : 'broken'];
  const pushdown = mode !== 'disabled';
  const python = join(environments, release.binding, 'bin', 'python');
  let stdout: string;
  try {
    ({ stdout } = await execute(python, ['-I', probe, String(pushdown), create ? 'create' : 'reuse'], {
      cwd, timeout: 60_000, maxBuffer: 256 * 1024,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('DataFusion runtime missing. Run bash adapters/datafusion/setup.sh from TraceTern.');
    }
    throw error;
  }
  const result: Probe = JSON.parse(stdout);
  if (result.runtime.binding !== release.binding || !result.runtime.engine.startsWith('Apache DataFusion ' + release.engine + ',')) {
    throw new Error('Unexpected DataFusion engine or Python binding for ' + mode);
  }
  return { ...result, pushdown, commit: release.commit, sourcePath: 'datafusion/physical-expr-adapter/src/schema_rewriter.rs' };
}

function assess(reference: Probe, candidate: Probe): DataFusionInvestigation['result'] {
  const checks: EvidenceCheck[] = [];
  function check(id: string, expected: number[], before: number[], after: number[]) {
    const matched = isDeepStrictEqual(after, expected);
    checks.push({ id, expected: expected.map(String), reference: before.map(String), candidate: after.map(String),
      matched, ...(matched && !isDeepStrictEqual(before, expected) ? { repaired: true } : {}) });
  }
  const base = reference.observations;
  const next = candidate.observations;
  for (const control of ['unoptimized', 'inferred', 'scalar'] as const) {
    if (!isDeepStrictEqual(base[control], [2])) throw new Error('Invalid baseline control: ' + control);
    check(control + ' control IDs', [2], base[control], next[control]);
  }
  check('adapted struct IDs', [2], base.nested, next.nested);
  check('rows pruned by Parquet pushdown', [2], [base.pruned], [next.pruned]);
  return { schemaVersion: 1, fixture: datafusionFixture, checks,
    verdict: checks.every(item => item.matched) ? 'pass' : 'regression' };
}

type Request = { mode: DataFusionMode } | { replayOf: string };
export async function investigateDataFusion(request: Request, directory = '.tracetern') {
  const store = openEvidence(directory);
  try {
    const replayOf = 'replayOf' in request ? request.replayOf : undefined;
    const saved = 'replayOf' in request ? store.loadDataFusion(request.replayOf) : undefined;
    const mode = 'mode' in request ? request.mode : saved!.fixtureImplementation;
    if (!['broken', 'fixed', 'disabled'].includes(mode)) throw new Error('Unknown saved DataFusion mode');
    const harnessSha256 = digest(Buffer.concat(await Promise.all([readFile(probe), readFile(new URL(import.meta.url))])));
    if (saved && saved.environment.harnessSha256 !== harnessSha256) throw new Error('Incompatible DataFusion replay harness');
    const cwd = await mkdtemp(join(tmpdir(), 'tracetern-datafusion-'));
    try {
      const file = join(cwd, 'rows.parquet');
      if (saved) {
        const input = Buffer.from(saved.parquet.base64, 'base64');
        if (digest(input) !== saved.parquet.sha256) throw new Error('Saved Parquet digest mismatch');
        await writeFile(file, input);
      }
      const reference = await probeRelease(cwd, 'broken', !saved);
      const bytes = await readFile(file);
      const candidate = await probeRelease(cwd, mode, false);
      if (saved && (!isDeepStrictEqual(saved.reference.runtime, reference.runtime) ||
          !isDeepStrictEqual(saved.candidate.runtime, candidate.runtime))) {
        throw new Error('DataFusion replay requires the recorded engines and Python environment');
      }
      const result = assess(reference, candidate);
      const reproduced = saved && isDeepStrictEqual(result, saved.result);
      const runId = store.save({ adapter: datafusionFixture, reference, candidate, fixtureImplementation: mode,
        parquet: { sha256: digest(bytes), base64: bytes.toString('base64') },
        environment: { fixture: datafusionFixture, harnessSha256 }, result, replayOf });
      return { ...result, runId, baseCommit: reference.commit, candidateCommit: candidate.commit, mode,
        baselineEngine: reference.runtime.engine, candidateEngine: candidate.runtime.engine, replayOf, reproduced };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } finally {
    store.close();
  }
}

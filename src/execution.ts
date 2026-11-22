import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export type ReasonCode = 'no-coverage' | 'shared-failure' | 'invalid-input' | 'incompatible-replay' | 'artifact-invalid'
  | 'execution-failed' | 'invalid-observations' | 'reference-failed' | 'timeout' | 'cancelled';

export class InvestigationError extends Error {
  constructor(readonly code: ReasonCode, message: string) {
    super(message);
  }
}

export function checkCancellation(signal?: AbortSignal) {
  if (signal?.aborted) throw new InvestigationError('cancelled', 'Investigation cancelled');
}

export function inconclusive(error: unknown) {
  return {
    schemaVersion: 1 as const, verdict: 'inconclusive' as const,
    reason: error instanceof Error ? error.message : String(error),
    reasonCode: error instanceof InvestigationError ? error.code : 'execution-failed' as const,
  };
}

export async function runProcess(
  label: string, executable: string, args: string[],
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv },
  failureCode: ReasonCode = 'execution-failed',
) {
  checkCancellation(options.signal);
  try {
    return (await execute(executable, args, { ...options, killSignal: 'SIGKILL' })).stdout;
  } catch (error) {
    checkCancellation(options.signal);
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (failure.killed && failure.signal === 'SIGKILL' && typeof failure.code !== 'string') {
      throw new InvestigationError('timeout', label + ' timed out');
    }
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new InvestigationError(failureCode, label + ' exceeded its output limit');
    }
    if (failure.code === 'ENOENT') throw new InvestigationError(failureCode, label + ' executable is unavailable');
    throw new InvestigationError(failureCode, label + ' failed');
  }
}

export function parseWorkerOutput(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new InvestigationError('invalid-observations', label + ' returned malformed JSON');
  }
}

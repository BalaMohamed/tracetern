import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { getRun, listRuns, runIdPattern } from '../../dist/src/evidence-view.js';
import { datafusionFixture } from '../../dist/src/evidence.js';
import { isLibraryFixture } from '../../dist/src/library-cases.js';

const { positionals: [repository, ...extra], values } = parseArgs({
  allowPositionals: true,
  options: { 'enable-execution': { type: 'boolean' }, 'library-repository': { type: 'string' } },
});
const libraryRepository = values['library-repository'];
if (!repository || !isAbsolute(repository) || extra.length ||
    (libraryRepository !== undefined && (!values['enable-execution'] || !isAbsolute(libraryRepository)))) {
  throw new Error('Usage: node integrations/mcp/server.mjs /absolute/evidence/repository [--enable-execution [--library-repository /absolute/target/repository]]');
}
if (!statSync(repository).isDirectory()) throw new Error('The repository path must be a directory');
if (libraryRepository && !statSync(libraryRepository).isDirectory()) {
  throw new Error('The library repository path must be a directory');
}

const directory = join(repository, '.tracetern');
const runner = fileURLToPath(new URL('../../dist/src/cli.js', import.meta.url));
const postgres = fileURLToPath(new URL('../../scripts/with-postgres.sh', import.meta.url));
const execute = promisify(execFile);
const runId = z.string().regex(runIdPattern).describe('Run ID printed by TraceTern');
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).describe('Full object ID of the committed fix');
const localRead = { readOnlyHint: true, openWorldHint: false };
const localExecution = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function evidence(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

async function runCase(args, library) {
  const runnerArgs = [runner, ...args, '--json'];
  const [command, ...parameters] = library
    ? [process.execPath, ...runnerArgs]
    : ['bash', postgres, process.execPath, ...runnerArgs];
  try {
    const { stdout } = await execute(command, parameters, {
      cwd: repository, timeout: 90_000, maxBuffer: 256 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    // The CLI uses exit 1 for a reproduced regression and 2 for an inconclusive run.
    if ((error.code === 1 || error.code === 2) && error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

function createServer() {
  const server = new McpServer({ name: 'tracetern', version: '0.1.0' });
  server.registerTool('list_runs', {
    description: 'List up to 25 saved TraceTern investigations from the configured repository, newest first.',
    inputSchema: z.strictObject({}), annotations: localRead,
  }, async () => {
    try {
      return evidence({ runs: listRuns(directory) });
    } catch {
      return failure('TraceTern could not read the local evidence store.');
    }
  });

  server.registerTool('get_run', {
    description: 'Read the saved experiment, public observations, and candidate source reference.',
    inputSchema: z.strictObject({ runId }), annotations: localRead,
  }, async ({ runId }) => {
    try {
      const run = getRun(directory, runId);
      return run ? evidence({ run }) : failure('Investigation not found in the configured repository.');
    } catch {
      return failure('TraceTern could not read the saved investigation.');
    }
  });

  if (values['enable-execution']) {
    let running = false;
    async function executeSavedCase(args) {
      if (running) return failure('A TraceTern experiment is already running.');
      running = true;
      try {
        const saved = getRun(directory, args[1]);
        if (!saved) return failure('Investigation not found in the configured repository.');
        const library = isLibraryFixture(saved.fixture);
        const databaseFree = library || saved.fixture === datafusionFixture;
        if (databaseFree && args[0] === 'verify') return failure('Candidate verification is available for Orders experiments.');
        if (!library && args[0] === 'verify-library') return failure('Use a saved TanStack Query or Zustand investigation.');
        const result = await runCase(args, databaseFree);
        const run = result.runId && getRun(directory, result.runId);
        if (!run) return failure('The runner produced no saved result. Check the revision and runner setup in the terminal.');
        return evidence({ run, reproduced: result.reproduced ?? null, measurementsMatch: result.measurementsMatch ?? null });
      } catch {
        return failure('TraceTern could not complete the experiment. Check the runner setup in the terminal.');
      } finally {
        running = false;
      }
    }

    server.registerTool('replay_run', {
      description: 'Rerun a saved Orders or library experiment with its pinned artifacts.',
      inputSchema: z.strictObject({ runId }), annotations: localExecution,
    }, async ({ runId }) => executeSavedCase(['replay', runId]));

    server.registerTool('verify_candidate', {
      description: 'Apply the saved orders experiment and baseline to a trusted committed fix in the configured repository.',
      inputSchema: z.strictObject({ runId, commit }), annotations: localExecution,
    }, async ({ runId, commit }) => executeSavedCase(['verify', runId, commit]));

    if (libraryRepository) {
      server.registerTool('verify_library_candidate', {
        description: 'Check a committed fix in the configured library repository against the saved baseline and selected checks.',
        inputSchema: z.strictObject({ runId, commit }), annotations: localExecution,
      }, async ({ runId, commit }) => executeSavedCase(['verify-library', runId, libraryRepository, commit]));
    }
  }
  return server;
}

serveStdio(createServer);

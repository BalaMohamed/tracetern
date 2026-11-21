import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { getRun, listRuns, runIdPattern } from '../../dist/src/evidence-view.js';

const [repository, mode, ...extra] = process.argv.slice(2);
if (!repository || !isAbsolute(repository) || (mode && mode !== '--enable-execution') || extra.length) {
  throw new Error('Usage: node integrations/mcp/server.mjs /absolute/repository/path [--enable-execution]');
}
if (!statSync(repository).isDirectory()) throw new Error('The repository path must be a directory');

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

async function runCase(args) {
  try {
    const { stdout } = await execute('bash', [postgres, process.execPath, runner, ...args, '--json'], {
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
    description: 'Read the saved experiment, grouped PostgreSQL calls, response difference, and candidate source reference.',
    inputSchema: z.strictObject({ runId }), annotations: localRead,
  }, async ({ runId }) => {
    try {
      const run = getRun(directory, runId);
      return run ? evidence({ run }) : failure('Investigation not found in the configured repository.');
    } catch {
      return failure('TraceTern could not read the saved investigation.');
    }
  });

  if (mode === '--enable-execution') {
    let running = false;
    async function executeSavedCase(args) {
      if (running) return failure('A TraceTern experiment is already running.');
      running = true;
      try {
        const result = await runCase(args);
        const run = result.runId && getRun(directory, result.runId);
        if (!run) return failure('The runner produced no saved result. Check the revision and runner setup in the terminal.');
        return evidence({ run, reproduced: result.reproduced ?? null });
      } catch {
        return failure('TraceTern could not complete the experiment. Check the runner setup in the terminal.');
      } finally {
        running = false;
      }
    }

    server.registerTool('replay_run', {
      description: 'Rerun the exact saved orders experiment with its pinned service snapshots using a disposable local PostgreSQL instance.',
      inputSchema: z.strictObject({ runId }), annotations: localExecution,
    }, async ({ runId }) => executeSavedCase(['replay', runId]));

    server.registerTool('verify_candidate', {
      description: 'Apply the saved orders experiment and baseline to a trusted committed fix in the configured repository.',
      inputSchema: z.strictObject({ runId, commit }), annotations: localExecution,
    }, async ({ runId, commit }) => executeSavedCase(['verify', runId, commit]));
  }
  return server;
}

serveStdio(createServer);

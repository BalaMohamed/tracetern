import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { getRun, listRuns, runIdPattern } from './evidence-view.js';

const directory = '.tracetern';
const runId = process.argv[2];
if (process.argv.length > 3 || (runId && !runIdPattern.test(runId))) {
  throw new Error('Usage: npm run view -- [run-id]');
}

const resources = new Map([
  ['/', { path: '../../src/web/index.html', type: 'text/html; charset=utf-8' }],
  ['/style.css', { path: '../../src/web/style.css', type: 'text/css; charset=utf-8' }],
  ['/view.js', { path: './web/view.js', type: 'text/javascript; charset=utf-8' }],
]);

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (request.headers.host !== '127.0.0.1:' + request.socket.localPort) {
    sendJson(response, 403, { error: 'Open the viewer at the loopback address printed in the terminal.' });
    return;
  }
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }
  const path = (request.url ?? '/').split('?')[0]!;
  try {
    const resource = resources.get(path);
    if (resource) {
      const bytes = await readFile(new URL(resource.path, import.meta.url));
      response.writeHead(200, { 'content-type': resource.type }).end(bytes);
      return;
    }
    if (path === '/api/runs') {
      sendJson(response, 200, { runs: listRuns(directory) });
      return;
    }
    if (path.startsWith('/api/runs/')) {
      const run = getRun(directory, path.slice('/api/runs/'.length));
      if (run) {
        sendJson(response, 200, run);
        return;
      }
    }
    sendJson(response, 404, { error: 'Investigation not found' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Could not read local investigation evidence.' });
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing viewer address');
  const url = new URL('http://127.0.0.1:' + address.port);
  if (runId) url.searchParams.set('run', runId);
  console.log(url.href);
});

import { totalmem } from 'node:os';
import { catalogForMemory } from './model-catalog.js';

const host = 'http://127.0.0.1:11434';
const exactTag = /^(?:[\w.-]+\/)*[\w.-]+:[\w.-]+$/;
interface Model {
  name: string;
  digest: string;
  size: number;
  remote_model?: string;
  remote_host?: string;
}
function isLocalTag(tag: string) {
  return exactTag.test(tag) && !/:(?:[\w.-]*-)?cloud$/i.test(tag);
}

async function request(path: string, body?: unknown, timeout = 120_000) {
  const response = await fetch(host + path, {
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error('Local Ollama ' + path + ' returned HTTP ' + response.status);
  return response;
}

async function installedModels(): Promise<Model[]> {
  const response = await request('/api/tags');
  const tags: { models?: Model[] } = await response.json();
  return (tags.models ?? []).filter(item =>
    typeof item.name === 'string' && isLocalTag(item.name) && item.digest && item.size > 0 &&
      !item.remote_model && !item.remote_host);
}

export async function browseModels() {
  const installed = await installedModels();
  const names = new Set(installed.map(model => model.name));
  return { installed: installed.map(({ name, digest, size }) => ({ tag: name, digest, size })),
    ...catalogForMemory(totalmem() / 1e9, names) };
}

export async function pullModel(tag: string, progress: (status: string, percent?: number) => void) {
  if (!isLocalTag(tag)) throw new Error('Specify an exact local Ollama model tag, such as qwen2.5-coder:1.5b');
  const response = await request('/api/pull', { model: tag, stream: true }, 3_600_000);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Ollama did not return a download progress stream');
  const decoder = new TextDecoder();
  let pending = '';
  let succeeded = false;
  let previous = '';
  function event(line: string) {
    if (!line.trim()) return;
    const record: { status?: string; error?: string; completed?: number; total?: number } = JSON.parse(line);
    if (record.error) throw new Error(record.error);
    if (!record.status) throw new Error('Invalid Ollama download event');
    succeeded = record.status === 'success';
    const percent = record.total && record.total > 0 && record.completed !== undefined
      ? Math.floor(100 * record.completed / record.total) : undefined;
    const display = record.status + ' ' + (percent ?? '');
    if (display !== previous) progress(record.status, percent);
    previous = display;
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) event(line);
      if (done) {
        event(pending);
        break;
      }
      if (pending.length > 64 * 1024) throw new Error('Ollama download event is too large');
    }
    if (!succeeded) throw new Error('Ollama download ended before reporting success');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const installed = (await installedModels()).find(model => model.name === tag);
  if (!installed) throw new Error('Downloaded model is missing from the local model list');
  return { tag, digest: installed.digest, size: installed.size };
}

async function installedDigest(model: string) {
  const entry = (await installedModels()).find(item => item.name === model);
  if (!entry) throw new Error('Choose an installed local model using its exact Ollama tag');
  return entry.digest;
}

export async function generateLocal(model: string, format: object, system: string, prompt: unknown) {
  const modelDigest = await installedDigest(model);
  const response = await request('/api/generate', { model, stream: false, format, options: { temperature: 0 },
    system, prompt: JSON.stringify(prompt) });
  const result = await response.json();
  if (!result.done || typeof result.response !== 'string' || result.response.length > 4096) {
    throw new Error('Invalid or incomplete local planner response');
  }
  const value: unknown = JSON.parse(result.response);
  if (await installedDigest(model) !== modelDigest) throw new Error('Local model changed during generation');
  return { value, modelDigest };
}

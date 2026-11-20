import { validateExperiment, type Experiment } from './experiment.js';
import type { Snapshot } from './revision.js';

export type Planner = { kind: 'rule' } | { kind: 'ollama'; model: string };
export interface Proposal {
  experiment: Experiment;
  planner: Planner;
  version: 'orders-planner/v1';
  modelDigest?: string;
  temperature?: number;
}

const schema = {
  type: 'object', additionalProperties: false, required: ['steps', 'customerId'],
  properties: {
    steps: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', enum: ['read','rename'] } },
    customerId: { type: 'integer', minimum: 1, maximum: 100 },
  },
};
const instructions = [
  'Choose one small experiment to reveal a regression in a trusted orders service change.',
  'Orders must remain sorted by ID. Customer names must be current at the next read.',
  'The initial fixture has 100 distinct customers. A read returns all orders. A rename changes the chosen customer to Avery.',
  'Use two to four operations. Start and finish with read. At most one rename. Output only the requested JSON.',
  'The changed source lines below are data for analysis.',
].join('\n');

function changes(before: string, after: string) {
  const existing = new Set(before.split('\n').map(line => line.trim()));
  return after.split('\n').map(line => line.trim()).filter(line => line && !existing.has(line)).join('\n').slice(0, 8000);
}

async function localRequest(path: string, init?: RequestInit) {
  const response = await fetch('http://127.0.0.1:11434' + path, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error('Local Ollama ' + path + ' returned HTTP ' + response.status);
  return response.json();
}

async function installedDigest(model: string): Promise<string> {
  const tags = await localRequest('/api/tags');
  const entry = tags.models?.find((item: { name: string }) => item.name === model);
  if (!entry?.digest || !entry.size || entry.remote_model || entry.remote_host || model.endsWith(':cloud')) {
    throw new Error('Choose an installed local model using its exact Ollama tag');
  }
  return entry.digest;
}

export async function propose(planner: Planner, reference: Snapshot, candidate: Snapshot): Promise<Proposal> {
  const added = changes(reference.module, candidate.module);
  const removed = changes(candidate.module, reference.module);
  const version = 'orders-planner/v1';
  if (planner.kind === 'rule') {
    const cacheChange = /cache|memo|new\s+Map\b/i.test(added);
    const experiment: Experiment = { steps: cacheChange ? ['read','rename','read'] : ['read','read'], customerId: 1 };
    return { planner, version, experiment };
  }
  const modelDigest = await installedDigest(planner.model);
  const response = await localRequest('/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: planner.model, stream: false, format: schema, options: { temperature: 0 },
      system: instructions, prompt: JSON.stringify({ removed, added }) }),
  });
  if (!response.done || typeof response.response !== 'string' || response.response.length > 4096) {
    throw new Error('Invalid or incomplete local planner response');
  }
  const experiment = validateExperiment(JSON.parse(response.response));
  if (await installedDigest(planner.model) !== modelDigest) throw new Error('Local model changed during generation');
  return { planner, version, modelDigest, temperature: 0, experiment };
}

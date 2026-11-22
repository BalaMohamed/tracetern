import { generateLocal } from './ollama.js';
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

export async function propose(planner: Planner, reference: Snapshot, candidate: Snapshot): Promise<Proposal> {
  const added = changes(reference.module, candidate.module);
  const removed = changes(candidate.module, reference.module);
  const version = 'orders-planner/v1';
  if (planner.kind === 'rule') {
    const cacheChange = /cache|memo|new\s+Map\b/i.test(added);
    const experiment: Experiment = { steps: cacheChange ? ['read','rename','read'] : ['read','read'], customerId: 1 };
    return { planner, version, experiment };
  }
  const { value, modelDigest } = await generateLocal(planner.model, schema, instructions, { removed, added });
  const experiment = validateExperiment(value);
  return { planner, version, modelDigest, temperature: 0, experiment };
}

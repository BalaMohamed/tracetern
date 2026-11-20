// The plan can only read the fixture endpoint or rename one seeded customer to Avery.
export interface Experiment {
  steps: ('read' | 'rename')[];
  customerId: number;
}

export const defaultExperiment: Experiment = { steps: ['read', 'read', 'rename', 'read'], customerId: 1 };

export function validateExperiment(value: unknown): Experiment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an experiment object');
  const plan = value as Record<string, unknown>;
  const { steps, customerId } = plan;
  if (Object.keys(plan).some(key => key !== 'steps' && key !== 'customerId')) throw new Error('Unknown experiment field');
  if (typeof customerId !== 'number' || !Number.isInteger(customerId) || customerId < 1 || customerId > 100) {
    throw new Error('Customer must be one of the 100 fixture records');
  }
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 4 ||
      steps[0] !== 'read' || steps.at(-1) !== 'read' ||
      steps.some(step => step !== 'read' && step !== 'rename') ||
      steps.filter(step => step === 'rename').length > 1) {
    throw new Error('Use two to four read/rename steps, beginning and ending with a read and at most one rename');
  }
  return { steps: [...steps], customerId };
}

export function observationStages(plan: Experiment) {
  const stages: ('cold' | 'warm' | 'after-rename')[] = [];
  let renamed = false;
  for (const step of plan.steps) {
    if (step === 'rename') renamed = true;
    else stages.push(renamed ? 'after-rename' : stages.length === 0 ? 'cold' : 'warm');
  }
  return stages;
}

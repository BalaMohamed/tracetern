import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { browseModels, pullModel } from './ollama.js';

type Catalog = Awaited<ReturnType<typeof browseModels>>;

export async function selectedModel(directory = '.tracetern') {
  try {
    const selection = JSON.parse(await readFile(join(directory, 'ollama-model.json'), 'utf8'));
    if (typeof selection.tag !== 'string' || !selection.tag) throw new Error('Invalid saved Ollama model selection');
    return selection.tag as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function chooseModel(name: string, report: Catalog, progress: Parameters<typeof pullModel>[1],
    directory = '.tracetern') {
  const tag = name.includes(':') ? name : name + ':latest';
  const model = report.installed.find(entry => entry.tag === tag) ?? await pullModel(tag, progress);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, 'ollama-model-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify({ tag: model.tag }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'ollama-model.json'));
  } finally {
    await rm(temporary, { force: true });
  }
  return model;
}

function progress(status: string, percent?: number) {
  console.error(status + (percent === undefined ? '' : ' · ' + percent + '%'));
}

export async function modelCommand(args: string[], json: boolean) {
  const [action, name] = args;
  if (action === 'pull' && name && args.length === 2) {
    const result = await pullModel(name.includes(':') ? name : name + ':latest', json ? () => {} : progress);
    console.log(json ? JSON.stringify(result, null, 2) : 'Installed ' + result.tag);
    return;
  }
  if (args.length && !(action === 'pick' && args.length <= 2)) {
    throw new Error('Usage: tracetern models [pick [model-tag] | pull <model-tag>] [--json]');
  }
  const report = await browseModels();
  const selected = await selectedModel();
  if (action === 'pick' && name) {
    const result = await chooseModel(name, report, json ? () => {} : progress);
    console.log(json ? JSON.stringify(result, null, 2) : 'Selected ' + result.tag);
    return;
  }
  if (action === 'pick' && (json || !process.stdin.isTTY)) {
    throw new Error('Use models pick <model-tag> when running without an interactive terminal');
  }
  if (json) {
    console.log(JSON.stringify({ ...report, selected: selected ?? null }, null, 2));
    return;
  }
  const entries = [
    ...report.installed.map(model => ({ tag: model.tag, size: model.size / 1e9, status: 'installed' })),
    ...report.catalog.filter(model => !model.installed).map(model => ({
      tag: model.tag, size: model.downloadGB, status: model.fit,
    })),
  ];
  console.log('Local Ollama models · ' + report.totalGB.toFixed(1) + ' GB RAM · '
    + report.budgetGB.toFixed(1) + ' GB suggested weight budget');
  console.log('Catalog reviewed ' + report.catalogUpdated + ' · size estimates exclude runtime overhead');
  for (const [index, row] of entries.entries()) {
    const number = action === 'pick' ? String(index + 1).padStart(2) + '  ' : '';
    console.log(number + row.tag + ' · ' + row.size.toFixed(2) + ' GB · ' + row.status
      + (row.tag === selected ? ' · selected' : ''));
  }
  if (action !== 'pick') return;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await input.question('Choose a number or enter a model tag to install (Enter to exit): ')).trim();
  } finally {
    input.close();
  }
  if (!answer) return;
  const tag = /^\d+$/.test(answer) ? entries[Number(answer) - 1]?.tag : answer;
  if (!tag) throw new Error('Model number is out of range');
  const result = await chooseModel(tag, report, progress);
  console.log('Selected ' + result.tag);
}

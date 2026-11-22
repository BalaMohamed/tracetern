// Ollama popularity and recent releases reviewed 2026-11-22.
// Sizes are in decimal GB. For published ranges, use the higher value.
export const catalogUpdated = '2026-11-22';
const variants: { tag: string; downloadGB: number }[] = [
  { tag: 'qwen3.5:4b', downloadGB: 4 },
  { tag: 'gemma4:12b', downloadGB: 8 },
  { tag: 'qwen3.5:9b', downloadGB: 7.6 },
  { tag: 'qwen2.5-coder:7b', downloadGB: 4.7 },
  { tag: 'gemma4:e4b', downloadGB: 9.5 },
  { tag: 'gpt-oss:20b', downloadGB: 14 },
  { tag: 'qwen3-coder:30b', downloadGB: 19 },
  { tag: 'qwen3.8:27b', downloadGB: 18 },
  { tag: 'qwen3.5:2b', downloadGB: 3.1 },
  { tag: 'qwen2.5-coder:3b', downloadGB: 1.9 },
  { tag: 'qwen3:4b', downloadGB: 2.5 },
  { tag: 'gemma4:e2b', downloadGB: 7.5 },
  { tag: 'ministral-3:8b', downloadGB: 6 },
  { tag: 'gemma3:4b', downloadGB: 3.4 },
  { tag: 'qwen3:8b', downloadGB: 5.2 },
  { tag: 'llama3.1:8b', downloadGB: 4.9 },
  { tag: 'phi4-mini:3.8b', downloadGB: 2.5 },
  { tag: 'deepseek-r1:8b', downloadGB: 5.2 },
  { tag: 'qwen3.5:0.8b', downloadGB: 1.3 },
  { tag: 'qwen2.5-coder:1.5b', downloadGB: 0.99 },
  { tag: 'qwen2.5-coder:0.5b', downloadGB: 0.4 },
  { tag: 'llama3.2:3b', downloadGB: 2 },
  { tag: 'qwen2.5-coder:14b', downloadGB: 9 },
  { tag: 'qwen2.5-coder:32b', downloadGB: 20 },
  { tag: 'devstral-small-2:24b', downloadGB: 15 },
  { tag: 'qwen3.5:27b', downloadGB: 20 },
  { tag: 'qwen3-coder-next:q4_K_M', downloadGB: 52 },
];

export function catalogForMemory(totalGB: number, installed: ReadonlySet<string>) {
  const budgetGB = totalGB * 0.65;
  const priority = { suggested: 0, tight: 1, large: 2 } as const;
  const rows = variants.map(model => {
    const fit: keyof typeof priority = model.downloadGB <= budgetGB ? 'suggested' : model.downloadGB <= totalGB ? 'tight' : 'large';
    return { ...model, installed: installed.has(model.tag), fit };
  });
  return { catalogUpdated, totalGB, budgetGB,
    catalog: rows.sort((a, b) => priority[a.fit] - priority[b.fit]) };
}

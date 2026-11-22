import { experimentProfiles, productionChanges, wordsIn } from './retrieval.js';

export type Grade = 'direct' | 'control';
export type Features = [codeOverlap: number, pathOverlap: number, pathMatch: number, matchingCodeOverlap: number];
export type Example = { features: Features; relevant: boolean };

export function benchmarkInput(diff: string) {
  const excerpts: { path: string; code: string }[] = [];
  let remaining = 10_000;
  for (const [path, lines] of productionChanges(diff)) {
    if (!lines.length || remaining <= path.length + 5) continue;
    const code = lines.join('\n').slice(0, Math.min(1200, remaining - path.length - 5));
    excerpts.push({ path, code });
    remaining -= path.length + code.length + 5;
  }
  const files = excerpts.map(({ path, code }) => ({ path, tokens: wordsIn(code) }));
  const codeWords = new Set(files.flatMap(file => [...file.tokens]));
  const pathWords = wordsIn(files.map(file => file.path).join(' '));
  const candidates = experimentProfiles.map(profile => {
    const matching = files.filter(file => profile.paths.test(file.path));
    const matchingWords = new Set(matching.flatMap(file => [...file.tokens]));
    const count = (words: Set<string>) => profile.concepts.filter(word => words.has(word)).length;
    const keywordScore = count(codeWords);
    const features: Features = [
      keywordScore / profile.concepts.length,
      count(pathWords) / profile.concepts.length,
      Number(matching.length > 0),
      count(matchingWords) / profile.concepts.length,
    ];
    return { fixture: profile.fixture, scope: profile.scope, keywordScore, features };
  });
  return { excerpt: excerpts.map(({ path, code }) => path + '\n' + code).join('\n\n'), candidates };
}

function probability(weights: readonly number[], features: Features) {
  const logit = features.reduce((sum, value, index) => sum + value * weights[index + 1]!, weights[0]!);
  return 1 / (1 + Math.exp(-logit));
}

// Full-batch, class-balanced logistic regression. The small fixed penalty
// and decision threshold are shared by runs, independent of held-out labels.
export function fitRanker(examples: readonly Example[]) {
  const positive = examples.filter(item => item.relevant).length;
  const negative = examples.length - positive;
  if (!positive || !negative) throw new Error('Training requires positive and negative examples');
  const weights = [0, 0, 0, 0, 0];
  for (let step = 0; step < 600; step++) {
    const gradient = weights.map((weight, index) => index === 0 ? 0 : 0.005 * weight);
    for (const item of examples) {
      const expected = Number(item.relevant);
      const error = (probability(weights, item.features) - expected) / (2 * (item.relevant ? positive : negative));
      gradient[0]! += error;
      item.features.forEach((value, index) => { gradient[index + 1]! += error * value; });
    }
    gradient.forEach((value, index) => { weights[index]! -= 0.3 * value; });
  }
  return { weights, score: (features: Features) => probability(weights, features) };
}

export function scoreOrder(order: readonly string[], labels: Record<string, Grade>) {
  const gain = (label: Grade | undefined) => label === 'direct' ? 2 : label === 'control' ? 1 : 0;
  const ideal = Object.values(labels).map(gain).sort((a, b) => b - a);
  const discounted = (gains: number[]) => gains.reduce((sum, value, index) => sum + value / Math.log2(index + 2), 0);
  const top = order[0] ? labels[order[0]] ?? 'irrelevant' : 'abstained';
  return { top, hasUseful: ideal.length > 0,
    ndcg: ideal.length ? discounted(order.map(id => gain(labels[id]))) / discounted(ideal) : null };
}

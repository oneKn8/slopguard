import type { EnsembleScore, ProviderScore } from "../types.js";

const WEIGHTS: Record<ProviderScore["model"], number> = {
  "gemini-flash": 0.4,
  "claude-haiku": 0.35,
  "gpt-4o-mini": 0.25,
};

function stdDev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance =
    nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

export function fuse(
  providers: ProviderScore[],
  meta: Pick<EnsembleScore, "itemId" | "itemType" | "authorName">,
): EnsembleScore {
  const valid = providers.filter(p => !p.error);
  const scores = valid.map(p => p.score);

  let finalScore = 0;
  let totalWeight = 0;
  for (const p of valid) {
    const w = WEIGHTS[p.model];
    finalScore += p.score * w;
    totalWeight += w;
  }
  finalScore = totalWeight > 0 ? finalScore / totalWeight : 0;

  const disagreement = stdDev(scores);

  let confidence: EnsembleScore["confidence"] = "high";
  if (valid.length === 0) confidence = "low";
  else if (valid.length === 1) confidence = "medium";
  else if (disagreement > 0.25) confidence = "low";
  else if (disagreement > 0.12) confidence = "medium";

  return {
    finalScore,
    confidence,
    disagreement,
    providers,
    scoredAt: Date.now(),
    source: "llm",
    llmScore: finalScore,
    ...meta,
  };
}

export function isUncertain(score: number): boolean {
  return score > 0.4 && score < 0.85;
}

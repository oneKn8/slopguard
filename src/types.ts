export type ModelName = "gemini-flash" | "claude-haiku" | "gpt-4o-mini";

export interface ProviderScore {
  model: ModelName;
  score: number;
  reasoning: string;
  signals: string[];
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface EnsembleScore {
  finalScore: number;
  confidence: "high" | "medium" | "low";
  disagreement: number;
  providers: ProviderScore[];
  scoredAt: number;
  itemId: string;
  itemType: "post" | "comment";
  authorName: string;
}

export interface DailyMetrics {
  date: string;
  itemsScored: number;
  flagged: number;
  autoRemoved: number;
  manualRemoved: number;
  manualApproved: number;
  estimatedTimeSavedMinutes: number;
  totalCostUsd: number;
}

export interface UserHistory {
  username: string;
  totalScored: number;
  flagCount: number;
  removedCount: number;
  lastFlagTs?: number;
}

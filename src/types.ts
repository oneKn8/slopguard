export type ModelName = "gemini-flash" | "claude-haiku" | "gpt-4o-mini";

export type ScoreSource = "local" | "llm" | "local+llm";

export type PolicyMode = "advisory" | "verify" | "strict";

export interface ProviderScore {
  model: ModelName;
  score: number;
  reasoning: string;
  signals: string[];
  latencyMs: number;
  costUsd: number;
  error?: string;
}

export interface LocalSignalSummary {
  combinedScore: number;
  topReasons: string[];
  perSignal: { name: string; score: number; reasons: string[] }[];
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
  // Local-first triage fields (added in hybrid refactor)
  source: ScoreSource;
  localScore?: number;
  llmScore?: number;
  localSignals?: LocalSignalSummary;
  topReasons?: string[];
  // Vision cost is paid via Gemini outside `providers`, so it needs its
  // own slot — otherwise daily metrics under-report by the vision spend.
  visionCostUsd?: number;
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

/**
 * Signal types — local, deterministic detectors (no HTTP, no LLM).
 *
 * Each signal produces a normalized score in [0, 1] where 1 = strong indication
 * of synthetic/AI-assisted content or coordinated inauthentic behavior, plus a
 * short reason tag for explainability.
 */

export type SignalKind =
  | "structural"
  | "behavioral"
  | "duplication"
  | "history"
  | "promo"
  | "contact";

export interface SignalResult {
  kind: SignalKind;
  name: string;
  score: number; // 0..1
  reasons: string[]; // human-readable, surfaced in explainability panel
  detail?: Record<string, number | string | boolean>; // optional structured detail
}

export interface AggregatedSignals {
  results: SignalResult[];
  combinedScore: number; // weighted blend
  topReasons: string[]; // dedup'd, ordered by signal strength
}

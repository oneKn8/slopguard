import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import type {
  EnsembleScore,
  LocalSignalSummary,
  ScoreSource,
} from "../types.js";
import type { AggregatedSignals } from "../signals/types.js";
import { runLocalSignals } from "../signals/index.js";
import { scoreItem } from "../ensemble/index.js";
import { AppSetting } from "../settings.js";

/**
 * Triage — Slopguard's hybrid local-first scoring layer.
 *
 *   1. Run all 6 local signals (free, deterministic, fast).
 *   2. If `useLlmEscalation` is enabled AND the local combined score is
 *      inside the configurable escalation band, also run the LLM ensemble
 *      and fuse the two.
 *   3. Return a single EnsembleScore with both `localSignals` and
 *      (if applicable) `providers` populated for full explainability.
 *
 * In Advisory/Verify/Strict policy modes the score is the same; what
 * differs is what mods do with it downstream.
 */

export interface TriageInput {
  itemId: string;
  itemType: "post" | "comment";
  subredditName: string;
  authorName: string;
  title?: string;
  body?: string;
  url?: string;
  recentPostCount?: number;
  recentCrossPostCount?: number;
  forceLlm?: boolean; // e.g. invoked from a report or manual mod menu action
}

function summarizeSignals(agg: AggregatedSignals): LocalSignalSummary {
  return {
    combinedScore: agg.combinedScore,
    topReasons: agg.topReasons,
    perSignal: agg.results.map(r => ({
      name: r.name,
      score: Number(r.score.toFixed(3)),
      reasons: r.reasons,
    })),
  };
}

function deriveConfidence(combined: number, agg: AggregatedSignals): EnsembleScore["confidence"] {
  // Confidence is a function of (a) how many signals corroborated and
  // (b) how clean the result is. A 0.3 score with no signals is "low"
  // confidence in suspicion; a 0.9 score with 4 signals firing is "high".
  const firing = agg.results.filter(r => r.score >= 0.35).length;
  if (combined >= 0.7 && firing >= 2) return "high";
  if (combined >= 0.55 && firing >= 1) return "medium";
  if (combined < 0.2) return "high"; // confidently NOT suspicious
  return "low";
}

function fuseLocalAndLlm(local: number, llm: number): number {
  // Local gets slightly more weight because spam/scam markers are objective
  // (link shorteners, wallet addresses) whereas LLM AI-detection is fuzzy
  // and prone to false positives on technical/non-native writing.
  const weighted = local * 0.55 + llm * 0.45;
  // Ratchet only when both sides agree above 0.5 — a confident high local
  // AND high LLM means we shouldn't wash out the agreement. If they
  // disagree (e.g. clean local + hallucinated LLM "AI" verdict), trust the
  // weighted average.
  const bothAgreeHigh = Math.min(local, llm) >= 0.5;
  return bothAgreeHigh
    ? Math.max(weighted, Math.max(local, llm) * 0.85)
    : weighted;
}

export async function runTriage(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  input: TriageInput,
): Promise<EnsembleScore | null> {
  const local = await runLocalSignals(ctx, {
    itemId: input.itemId,
    itemType: input.itemType,
    subredditName: input.subredditName,
    authorName: input.authorName,
    title: input.title,
    body: input.body,
    url: input.url,
    recentPostCount: input.recentPostCount,
    recentCrossPostCount: input.recentCrossPostCount,
  });

  const useLlm = settings[AppSetting.UseLlmEscalation] === true;
  const low = (settings[AppSetting.LlmEscalationLow] as number) ?? 0.4;
  const high = (settings[AppSetting.LlmEscalationHigh] as number) ?? 0.75;

  const inEscalationBand =
    local.combinedScore >= low && local.combinedScore <= high;
  const shouldEscalate = input.forceLlm || (useLlm && inEscalationBand);

  let source: ScoreSource = "local";
  let llmScore: number | undefined;
  let llmEnsemble: EnsembleScore | null = null;

  if (shouldEscalate) {
    const combinedText = input.itemType === "comment"
      ? input.body ?? ""
      : `${input.title ?? ""}\n\n${input.body ?? ""}`.trim();

    llmEnsemble = await scoreItem(ctx, settings, {
      itemId: input.itemId,
      itemType: input.itemType,
      authorName: input.authorName,
      text: combinedText,
      forceEscalation: input.forceLlm === true,
    });
    if (llmEnsemble) {
      llmScore = llmEnsemble.finalScore;
      source = "local+llm";
    }
  }

  const finalScore =
    llmScore !== undefined
      ? fuseLocalAndLlm(local.combinedScore, llmScore)
      : local.combinedScore;

  const confidence = deriveConfidence(finalScore, local);

  // topReasons: prefer local explainability first, then LLM signals
  const llmSignals =
    llmEnsemble?.providers
      .filter(p => !p.error)
      .flatMap(p => p.signals)
      .filter(Boolean) ?? [];
  const topReasons = [
    ...local.topReasons,
    ...llmSignals.filter(s => !local.topReasons.includes(s)),
  ].slice(0, 5);

  // Surface the case where escalation was requested but no working LLM
  // was reachable — so mods know the score is local-only.
  if (shouldEscalate) {
    const allLlmFailed =
      !llmEnsemble ||
      llmEnsemble.providers.length === 0 ||
      llmEnsemble.providers.every(p => p.error);
    if (allLlmFailed) {
      topReasons.unshift(
        "LLM escalation requested but unavailable (no API keys or all providers errored)",
      );
    }
  }

  return {
    finalScore,
    confidence,
    disagreement: llmEnsemble?.disagreement ?? 0,
    providers: llmEnsemble?.providers ?? [],
    scoredAt: Date.now(),
    itemId: input.itemId,
    itemType: input.itemType,
    authorName: input.authorName,
    source,
    localScore: local.combinedScore,
    llmScore,
    localSignals: summarizeSignals(local),
    topReasons,
  };
}

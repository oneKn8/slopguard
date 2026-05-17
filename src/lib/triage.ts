import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import type {
  EnsembleScore,
  LocalSignalSummary,
  ScoreSource,
} from "../types.js";
import type { AggregatedSignals, SignalResult } from "../signals/types.js";
import { runLocalSignals } from "../signals/index.js";
import { scoreItem } from "../ensemble/index.js";
import {
  classifyImageForAi,
  extractTextFromImage,
} from "../ensemble/vision.js";
import { promoSignal } from "../signals/promo.js";
import { contactSignal } from "../signals/contact.js";
import { addToDailySpend, getDailySpend } from "../redis.js";
import { queryAuthor as queryFederation } from "./federation.js";
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
  skipLlm?: boolean; // cost gates fired — run local only, no escalation
}

const IMAGE_HOST_RE = /^https?:\/\/(?:i\.|preview\.)?redd\.it\/|^https?:\/\/i\.imgur\.com\//i;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp)(?:\?|$)/i;

function isImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  return IMAGE_HOST_RE.test(url) || IMAGE_EXT_RE.test(url);
}

/**
 * Exported variant for callers (e.g. trigger length-gating) that need to know
 * if a post is image-based without parsing the URL themselves.
 */
export function isImagePostUrl(url: string | undefined): boolean {
  return isImageUrl(url);
}

interface VisionPass {
  imageAiScore: number;
  imageReasons: string[];
  ocrText: string;
  ocrReasons: string[];
  costUsd: number;
}

// Per-image reservation: we estimate ~$0.001 worst-case for a Gemini vision
// pass (image classification + OCR). Reserving up-front before fan-out
// prevents burst-load from bypassing the cap (10 image posts in the same
// second would otherwise each see the same pre-call balance).
const VISION_RESERVATION_USD = 0.001;

async function visionPass(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  imageUrl: string,
): Promise<VisionPass | null> {
  const useVision = settings[AppSetting.UseLlmVision] === true;
  if (!useVision) return null;
  const geminiKey = (settings[AppSetting.GeminiApiKey] as string) ?? "";
  if (!geminiKey) return null;

  const maxSpend = (settings[AppSetting.MaxDailySpendUsd] as number) ?? 1;
  // Atomic reserve: incrBy first, then check the post-reservation total.
  // If the cap was reached (by anyone — including racing triggers), refund
  // and bail. Exactly one concurrent caller may cross the cap, all others
  // see it crossed and back out.
  const reservedTotal = await addToDailySpend(ctx, VISION_RESERVATION_USD);
  if (reservedTotal > maxSpend) {
    await addToDailySpend(ctx, -VISION_RESERVATION_USD);
    return null;
  }

  const [aiClass, ocr] = await Promise.all([
    classifyImageForAi(geminiKey, imageUrl),
    extractTextFromImage(geminiKey, imageUrl),
  ]);

  const actualCost = aiClass.costUsd + ocr.costUsd;
  // Reconcile: refund the reservation, charge actual.
  await addToDailySpend(ctx, actualCost - VISION_RESERVATION_USD);
  const costUsd = actualCost;

  const imageReasons: string[] = [];
  if (aiClass.score >= 0.7) {
    imageReasons.push(
      `vision: image looks AI-generated (${(aiClass.score * 100).toFixed(0)}%) — ${aiClass.reasoning}`,
    );
  } else if (aiClass.score >= 0.45) {
    imageReasons.push(
      `vision: image possibly AI-generated (${(aiClass.score * 100).toFixed(0)}%)`,
    );
  }

  const ocrReasons: string[] = [];
  if (ocr.text && ocr.text.length > 20) {
    // Re-run promo + contact on the OCR'd text — catches scams hidden in
    // screenshots (Telegram handle baked into an image, wallet QR caption,
    // "DM me on Insta" inside a flyer).
    const promoOcr = promoSignal({ text: ocr.text });
    const contactOcr = contactSignal({ text: ocr.text });
    if (promoOcr.score >= 0.3) {
      ocrReasons.push(
        `OCR text in image (promo ${(promoOcr.score * 100).toFixed(0)}%): ${promoOcr.reasons[0] ?? ""}`,
      );
    }
    if (contactOcr.score >= 0.3) {
      ocrReasons.push(
        `OCR text in image (contact ${(contactOcr.score * 100).toFixed(0)}%): ${contactOcr.reasons[0] ?? ""}`,
      );
    }
  }

  return {
    imageAiScore: aiClass.score,
    imageReasons,
    ocrText: ocr.text,
    ocrReasons,
    costUsd,
  };
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

export function fuseLocalAndLlm(local: number, llm: number): number {
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

  // Federation lookup — no-op when disabled. Hashed only; see federation.ts
  // for the privacy framework. Fed in alongside the local "history" signal
  // — federated signal floors what we know locally without overriding it.
  const fed = await queryFederation(
    ctx,
    settings as Record<string, unknown>,
    input.authorName,
  );
  if (fed.score > 0 && fed.reason) {
    const fedResult: SignalResult = {
      kind: "history",
      name: "federation",
      score: fed.score,
      reasons: [fed.reason],
    };
    local.results.push(fedResult);
    // The federation hit augments the combined score by treating it as
    // its own ratchet (since communities-count can't be wrong — we either
    // saw it elsewhere or we didn't).
    local.combinedScore = Math.max(local.combinedScore, fed.score * 0.85);
    local.topReasons = [fed.reason, ...local.topReasons].slice(0, 5);
  }

  // Vision pass — only for image posts when explicitly enabled. Folds the
  // image-AI score + OCR-derived promo/contact hits back into the local
  // signals so the rest of the fusion pipeline doesn't have to know
  // anything about images.
  let visionCostUsd = 0;
  if (
    input.itemType === "post" &&
    isImageUrl(input.url) &&
    input.url
  ) {
    const vp = await visionPass(ctx, settings, input.url);
    if (vp) {
      visionCostUsd = vp.costUsd;
      const visionResult: SignalResult = {
        kind: "structural",
        name: "vision",
        score: Math.max(
          vp.imageAiScore,
          vp.ocrReasons.length > 0 ? 0.5 : 0,
        ),
        reasons: [...vp.imageReasons, ...vp.ocrReasons],
        detail: { ocrLen: vp.ocrText.length, imageAi: vp.imageAiScore },
      };
      local.results.push(visionResult);
      // Re-compute the combined score with the vision result added by
      // ratcheting up to whatever the vision pass surfaced.
      const visionContribution = visionResult.score * 0.7;
      local.combinedScore = Math.max(local.combinedScore, visionContribution);
      // Prepend vision reasons so they show up first in the review card.
      local.topReasons = [
        ...visionResult.reasons,
        ...local.topReasons,
      ].slice(0, 5);
    }
  }

  const useLlm = settings[AppSetting.UseLlmEscalation] === true;
  const low = (settings[AppSetting.LlmEscalationLow] as number) ?? 0.4;
  const high = (settings[AppSetting.LlmEscalationHigh] as number) ?? 0.75;

  const inEscalationBand =
    local.combinedScore >= low && local.combinedScore <= high;
  const shouldEscalate =
    !input.skipLlm && (input.forceLlm || (useLlm && inEscalationBand));

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

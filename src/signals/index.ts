import type { TriggerContext, Context } from "@devvit/public-api";
import type { AggregatedSignals, SignalKind, SignalResult } from "./types.js";
import { structuralSignal } from "./structural.js";
import { behavioralSignal, fetchUserSafely } from "./behavioral.js";
import { duplicationSignal } from "./duplication.js";
import { historySignal } from "./history.js";
import { promoSignal } from "./promo.js";
import { contactSignal } from "./contact.js";

/**
 * Local signals orchestrator — runs all 6 deterministic signals (no HTTP,
 * no LLM) and fuses them into a single combined score with topReasons.
 *
 * Design principles:
 *   - Each signal returns [0,1]; the orchestrator decides how much each
 *     contributes to the final score.
 *   - Weighted average alone over-dilutes strong-but-narrow signals
 *     (e.g. a verified duplicate). We add a "corroboration boost" floor so
 *     1 strong signal or 2 medium signals can't be washed out by noise.
 *   - Failures degrade gracefully — a thrown signal becomes a 0-score
 *     SignalResult with an explanatory reason rather than failing the run.
 */

const WEIGHTS: Record<SignalKind, number> = {
  structural: 0.18,
  behavioral: 0.22,
  duplication: 0.2,
  history: 0.1,
  promo: 0.15,
  contact: 0.15,
};

export interface RunSignalsInput {
  itemId: string;
  itemType: "post" | "comment";
  subredditName: string;
  authorName: string;
  title?: string;
  body?: string;
  url?: string;
  recentPostCount?: number;
  recentCrossPostCount?: number;
}

function safeText(s?: string): string {
  return (s ?? "").toString();
}

function combinedText(input: RunSignalsInput): string {
  // For posts, structural/promo/contact look at title + body; for comments,
  // body is the only signal-bearing content.
  if (input.itemType === "comment") return safeText(input.body);
  return `${safeText(input.title)}\n\n${safeText(input.body)}`.trim();
}

async function runOrFallback(
  kind: SignalKind,
  fn: () => Promise<SignalResult> | SignalResult,
): Promise<SignalResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      kind,
      name: kind,
      score: 0,
      reasons: [
        `signal failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

function fuse(results: SignalResult[]): {
  combinedScore: number;
  topReasons: string[];
} {
  let weighted = 0;
  let weightSum = 0;
  for (const r of results) {
    const w = WEIGHTS[r.kind] ?? 0;
    weighted += r.score * w;
    weightSum += w;
  }
  const weightedAvg = weightSum > 0 ? weighted / weightSum : 0;

  // Corroboration boost: a single strong (>=0.7) signal floors combined at
  // 0.55; two medium-strong (>=0.5) signals floor it at 0.65.
  const strong = results.filter(r => r.score >= 0.7).length;
  const mediumStrong = results.filter(r => r.score >= 0.5).length;

  let combined = weightedAvg;
  if (strong >= 1) combined = Math.max(combined, 0.55);
  if (mediumStrong >= 2) combined = Math.max(combined, 0.65);
  if (mediumStrong >= 3) combined = Math.max(combined, 0.8);
  combined = Math.max(0, Math.min(1, combined));

  // topReasons: take the strongest signal's top reason first, then second,
  // up to 4. Skip signals with score 0 or with only their default "no X
  // found" filler reason.
  const ranked = [...results]
    .filter(r => r.score > 0 && r.reasons.length > 0)
    .sort((a, b) => b.score - a.score);

  const topReasons: string[] = [];
  for (const r of ranked) {
    for (const reason of r.reasons) {
      if (topReasons.length >= 4) break;
      if (!topReasons.includes(reason)) topReasons.push(reason);
    }
    if (topReasons.length >= 4) break;
  }

  return { combinedScore: combined, topReasons };
}

export async function runLocalSignals(
  ctx: TriggerContext | Context,
  input: RunSignalsInput,
): Promise<AggregatedSignals> {
  const text = combinedText(input);
  const body = safeText(input.body);

  // Synchronous detectors (pure text analysis)
  const structural = await runOrFallback("structural", () =>
    structuralSignal(text),
  );
  const promo = await runOrFallback("promo", () =>
    promoSignal({ text, url: input.url }),
  );
  const contact = await runOrFallback("contact", () =>
    contactSignal({ text: body || text }),
  );

  // Async detectors (Devvit Redis + Reddit API)
  const userPromise = fetchUserSafely(ctx, input.authorName);
  const [user, duplication, history] = await Promise.all([
    userPromise,
    runOrFallback("duplication", () =>
      duplicationSignal(ctx, {
        itemId: input.itemId,
        subredditName: input.subredditName,
        title: input.title,
        body: input.body,
        url: input.url,
      }),
    ),
    runOrFallback("history", () =>
      historySignal(ctx, { username: input.authorName }),
    ),
  ]);

  const behavioral = await runOrFallback("behavioral", () =>
    behavioralSignal({
      user,
      recentPostCount: input.recentPostCount,
      recentCrossPostCount: input.recentCrossPostCount,
    }),
  );

  const results: SignalResult[] = [
    structural,
    behavioral,
    duplication,
    history,
    promo,
    contact,
  ];

  const { combinedScore, topReasons } = fuse(results);

  return { results, combinedScore, topReasons };
}

export { WEIGHTS };

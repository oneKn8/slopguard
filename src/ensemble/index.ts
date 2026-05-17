import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import type { EnsembleScore, ProviderScore } from "../types.js";
import { AppSetting } from "../settings.js";
import { addToDailySpend, getDailySpend } from "../redis.js";
import { fuse, isUncertain } from "./scoring.js";
import { scoreWithGemini } from "./gemini.js";
import { scoreWithClaude } from "./claude.js";
import { scoreWithOpenAi } from "./openai.js";

export interface ScoreOptions {
  itemId: string;
  itemType: "post" | "comment";
  authorName: string;
  text: string;
  forceEscalation?: boolean; // e.g. when called from a report — pay more
}

// Conservative pre-call reservations. Real costs are lower (Gemini Flash text
// ~$0.0001, Claude Haiku ~$0.001, GPT-4o-mini ~$0.001), but the reservation
// is the budget guarantee — if the pre-reservation total exceeds the cap, we
// refund and skip rather than firing the call.
const GEMINI_TEXT_RESERVATION_USD = 0.001;
const CLAUDE_RESERVATION_USD = 0.002;
const OPENAI_RESERVATION_USD = 0.002;

/**
 * Reserve-then-call. Returns the actual result on success, or null when the
 * reservation pushed us past the cap (reservation is refunded in that case).
 * Caller still pays for any call that actually completes.
 */
async function reserveAndCall<T extends { costUsd: number }>(
  ctx: TriggerContext | Context,
  reservationUsd: number,
  maxSpend: number,
  call: () => Promise<T>,
): Promise<T | null> {
  const reservedTotal = await addToDailySpend(ctx, reservationUsd);
  if (reservedTotal > maxSpend) {
    await addToDailySpend(ctx, -reservationUsd);
    return null;
  }
  try {
    const result = await call();
    // Reconcile actual vs reservation (delta is negative when actual was
    // cheaper, positive when actual exceeded the reservation).
    await addToDailySpend(ctx, result.costUsd - reservationUsd);
    return result;
  } catch (err) {
    // Call failed before any external billing — refund the reservation.
    await addToDailySpend(ctx, -reservationUsd);
    throw err;
  }
}

export async function scoreItem(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  opts: ScoreOptions,
): Promise<EnsembleScore | null> {
  const text = opts.text.trim();
  if (text.length < 25) return null;

  const maxSpend = (settings[AppSetting.MaxDailySpendUsd] as number) ?? 1;
  // Optimistic pre-flight skip when cap is already breached — saves the
  // round-trip cost of a reservation that would just refund.
  const spent = await getDailySpend(ctx);
  if (spent >= maxSpend) {
    console.log(`Slopguard: daily spend $${spent.toFixed(4)} >= cap $${maxSpend}. Skipping.`);
    return null;
  }

  const useGemini = settings[AppSetting.UseGemini] !== false;
  const useClaude = settings[AppSetting.UseClaude] === true;
  const useOpenAi = settings[AppSetting.UseOpenAi] === true;

  const geminiKey = (settings[AppSetting.GeminiApiKey] as string) ?? "";
  const claudeKey = (settings[AppSetting.AnthropicApiKey] as string) ?? "";
  const openaiKey = (settings[AppSetting.OpenAiApiKey] as string) ?? "";

  const providers: ProviderScore[] = [];

  // First pass: Gemini. Reserve-then-call so concurrent triggers can't all
  // squeeze past the cap.
  if (useGemini && geminiKey) {
    const g = await reserveAndCall(
      ctx,
      GEMINI_TEXT_RESERVATION_USD,
      maxSpend,
      () => scoreWithGemini(geminiKey, text),
    );
    if (g) providers.push(g);
    // If g is null we hit the cap during reservation — skip everything else.
    if (!g) return providers.length > 0 ? fuse(providers, {
      itemId: opts.itemId,
      itemType: opts.itemType,
      authorName: opts.authorName,
    }) : null;
  }

  // Decide whether to escalate. Skip if we have a confident Gemini answer.
  const firstScore = providers[0]?.score ?? 0;
  const wantEscalation =
    opts.forceEscalation || isUncertain(firstScore) || providers.length === 0;

  if (wantEscalation) {
    // Parallel escalation. Each provider reserves independently so a
    // depleted cap blocks calls without false-positives on the other.
    const escalations: Promise<ProviderScore | null>[] = [];
    if (useClaude && claudeKey) {
      escalations.push(
        reserveAndCall(ctx, CLAUDE_RESERVATION_USD, maxSpend, () =>
          scoreWithClaude(claudeKey, text),
        ),
      );
    }
    if (useOpenAi && openaiKey) {
      escalations.push(
        reserveAndCall(ctx, OPENAI_RESERVATION_USD, maxSpend, () =>
          scoreWithOpenAi(openaiKey, text),
        ),
      );
    }

    if (escalations.length > 0) {
      const results = await Promise.all(escalations);
      for (const r of results) {
        if (r) providers.push(r);
      }
    }
  }

  if (providers.length === 0) return null;

  return fuse(providers, {
    itemId: opts.itemId,
    itemType: opts.itemType,
    authorName: opts.authorName,
  });
}

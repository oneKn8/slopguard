import type { TriggerContext, Context } from "@devvit/public-api";
import type { SignalResult } from "./types.js";
import { getUserHistory } from "../redis.js";

/**
 * History signal — weights the current item by what Slopguard has previously
 * flagged or what mods have removed for this same author in this install.
 *
 * Removals (mod confirmed) weigh much more than raw flags (slopguard suggested).
 * Older history decays — a user flagged once six months ago shouldn't carry
 * the same weight as one flagged twice in the past week.
 */

const DAY_MS = 1000 * 60 * 60 * 24;

export interface HistoryInput {
  username: string;
}

function decayMultiplier(lastFlagTs: number | undefined): number {
  if (!lastFlagTs) return 0.5; // no recency info — half-credit
  const ageDays = (Date.now() - lastFlagTs) / DAY_MS;
  if (ageDays < 7) return 1.0;
  if (ageDays < 30) return 0.7;
  if (ageDays < 90) return 0.4;
  return 0.15;
}

export async function historySignal(
  ctx: TriggerContext | Context,
  input: HistoryInput,
): Promise<SignalResult> {
  if (
    !input.username ||
    input.username === "[deleted]" ||
    input.username === "AutoModerator"
  ) {
    return {
      kind: "history",
      name: "history",
      score: 0,
      reasons: ["no usable author identity"],
    };
  }

  const hist = await getUserHistory(ctx, input.username);
  if (!hist || (hist.flagCount === 0 && hist.removedCount === 0)) {
    return {
      kind: "history",
      name: "history",
      score: 0,
      reasons: ["no prior flag/removal history in this install"],
      detail: { flagCount: 0, removedCount: 0 },
    };
  }

  const reasons: string[] = [];
  const decay = decayMultiplier(hist.lastFlagTs);

  // Removed = strong: 1 removal → 0.4, 2 → 0.7, 3+ → 0.9 (before decay).
  let removedScore = 0;
  if (hist.removedCount >= 3) removedScore = 0.9;
  else if (hist.removedCount === 2) removedScore = 0.7;
  else if (hist.removedCount === 1) removedScore = 0.4;

  if (hist.removedCount > 0) {
    reasons.push(
      hist.removedCount === 1
        ? "1 prior removal as AI/spam by mods"
        : `${hist.removedCount} prior removals as AI/spam by mods`,
    );
  }

  // Flagged-but-not-removed = weaker.
  // Subtract removedCount so we only weight pure flags here.
  const pureFlags = Math.max(0, hist.flagCount - hist.removedCount);
  let flagScore = 0;
  if (pureFlags >= 5) flagScore = 0.4;
  else if (pureFlags >= 3) flagScore = 0.25;
  else if (pureFlags >= 1) flagScore = 0.12;

  if (pureFlags > 0) {
    reasons.push(
      pureFlags === 1
        ? "1 prior flag (not yet acted on by mods)"
        : `${pureFlags} prior flags (not yet acted on by mods)`,
    );
  }

  // Combine — removals dominate. Cap before decay.
  const combined = Math.min(1, removedScore + flagScore * 0.6);
  const score = Math.max(0, Math.min(1, combined * decay));

  if (decay < 1.0 && score > 0) {
    const ageDays = hist.lastFlagTs
      ? Math.floor((Date.now() - hist.lastFlagTs) / DAY_MS)
      : undefined;
    if (ageDays !== undefined) {
      reasons.push(`last flag ${ageDays}d ago (decayed weight)`);
    }
  }

  return {
    kind: "history",
    name: "history",
    score,
    reasons,
    detail: {
      flagCount: hist.flagCount,
      removedCount: hist.removedCount,
      pureFlags,
      decay: Number(decay.toFixed(2)),
      lastFlagTs: hist.lastFlagTs ?? 0,
    },
  };
}

import type { TriggerContext, Context, User } from "@devvit/public-api";
import type { SignalResult } from "./types.js";

/**
 * Behavioral signal — uses account/submission metadata where Devvit exposes it.
 * Catches characteristics common to both AI-bot accounts and spam-bot accounts:
 * fresh accounts, no karma, posting velocity, no engagement pattern.
 *
 * NOT a verdict. Conservative weighting — being a new user is normal; being
 * a new user with 5 cross-posts in 10 minutes is a stronger signal.
 */

export interface BehavioralInput {
  user: User | undefined;
  recentPostCount?: number; // posts by this user in this sub (last 24h)
  recentCrossPostCount?: number; // distinct subs this exact text appeared in
}

const HOURS = 1000 * 60 * 60;
const DAYS = 24 * HOURS;

export function behavioralSignal(input: BehavioralInput): SignalResult {
  if (!input.user) {
    return {
      kind: "behavioral",
      name: "behavioral",
      score: 0,
      reasons: ["user metadata unavailable"],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  const detail: Record<string, number | string | boolean> = {};

  // Account age
  const createdAtMs = input.user.createdAt
    ? new Date(input.user.createdAt).getTime()
    : NaN;
  if (Number.isFinite(createdAtMs)) {
    const ageDays = (Date.now() - createdAtMs) / DAYS;
    detail.accountAgeDays = Math.floor(ageDays);
    if (ageDays < 1) {
      score += 0.35;
      reasons.push(
        `account created <24h ago (${(ageDays * 24).toFixed(1)}h)`,
      );
    } else if (ageDays < 7) {
      score += 0.2;
      reasons.push(`account ${Math.floor(ageDays)}d old`);
    } else if (ageDays < 30) {
      score += 0.08;
      reasons.push(`account ${Math.floor(ageDays)}d old`);
    }
  }

  // Karma — looks at combined link + comment karma where exposed
  const linkKarma = input.user.linkKarma ?? 0;
  const commentKarma = input.user.commentKarma ?? 0;
  const totalKarma = linkKarma + commentKarma;
  detail.totalKarma = totalKarma;
  if (totalKarma < 1) {
    score += 0.15;
    reasons.push("0 karma");
  } else if (totalKarma < 10) {
    score += 0.08;
    reasons.push(`${totalKarma} karma (very low)`);
  }

  // Karma skew — bot accounts often have very imbalanced karma
  if (linkKarma > 0 && commentKarma > 0) {
    const ratio = linkKarma / Math.max(1, commentKarma);
    if (ratio > 50 || ratio < 0.02) {
      score += 0.05;
      reasons.push(`extreme karma skew (${linkKarma} link vs ${commentKarma} comment)`);
    }
  }

  // Posting velocity (if upstream provided)
  if (input.recentPostCount !== undefined && input.recentPostCount >= 3) {
    score += 0.12;
    reasons.push(`${input.recentPostCount} posts in this sub in last 24h`);
    detail.recentPostCount = input.recentPostCount;
  }

  if (input.recentCrossPostCount !== undefined && input.recentCrossPostCount >= 3) {
    score += 0.18;
    reasons.push(`same content appearing in ${input.recentCrossPostCount} subs`);
    detail.recentCrossPostCount = input.recentCrossPostCount;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    kind: "behavioral",
    name: "behavioral",
    score,
    reasons,
    detail,
  };
}

/**
 * Helper: fetch user object safely. Returns undefined on any failure rather
 * than throwing — behavioral signal degrades gracefully.
 */
export async function fetchUserSafely(
  ctx: TriggerContext | Context,
  username: string,
): Promise<User | undefined> {
  if (!username || username === "[deleted]" || username === "AutoModerator") {
    return undefined;
  }
  try {
    return await ctx.reddit.getUserByUsername(username);
  } catch {
    return undefined;
  }
}

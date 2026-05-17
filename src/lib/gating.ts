import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import { AppSetting } from "../settings.js";

/**
 * Two-tier gating. Local signals are free, deterministic, and run by default —
 * they should NOT be bypassed for cost reasons. Cost gates apply only to LLM
 * escalation.
 *
 *   skipCompletely — never score (system users, bots, moderators)
 *   skipLlm        — run free local signals, but don't pay for LLM/vision
 *
 * High-karma or established users can still be the vector for compromised
 * accounts pushing crypto scams; the free local checks (wallet, contact,
 * duplication) still apply.
 */

export interface GateResult {
  skipCompletely: boolean;
  skipLlm: boolean;
  reason?: string;
}

export async function userGate(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  username: string,
): Promise<GateResult> {
  if (!username || username === "[deleted]" || username === "AutoModerator") {
    return { skipCompletely: true, skipLlm: true, reason: "system-or-deleted-user" };
  }

  let user;
  try {
    user = await ctx.reddit.getUserByUsername(username);
  } catch {
    return { skipCompletely: false, skipLlm: false };
  }
  if (!user) return { skipCompletely: false, skipLlm: false };

  // Mod skip — moderators don't moderate themselves (skip everything).
  try {
    const subredditName =
      ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());
    const mods = await ctx.reddit
      .getModerators({ subredditName })
      .all();
    if (mods.some(m => m.username === username)) {
      return { skipCompletely: true, skipLlm: true, reason: "moderator" };
    }
  } catch {
    //
  }

  // Approved-submitters gate — skip ALL detection by default (they're trusted).
  // This is per-sub mod trust, not cost discipline.
  const ignoreApproved = settings[AppSetting.IgnoreApprovedUsers] !== false;
  if (ignoreApproved) {
    try {
      const subredditName =
        ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());
      const approved = await ctx.reddit
        .getApprovedUsers({ subredditName, username })
        .all();
      if (approved.length > 0) {
        return { skipCompletely: true, skipLlm: true, reason: "approved-submitter" };
      }
    } catch {
      //
    }
  }

  // Karma & age — cost gates. They suppress LLM escalation only; local signals
  // (wallet, contact, duplication, structural) still run because they're free
  // and high-karma accounts can be compromised.
  let skipLlm = false;
  let reason: string | undefined;

  const maxKarma = (settings[AppSetting.MaxKarmaToCheck] as number) ?? 0;
  if (maxKarma > 0) {
    const total = (user.linkKarma ?? 0) + (user.commentKarma ?? 0);
    if (total > maxKarma) {
      skipLlm = true;
      reason = `karma-${total}-above-${maxKarma}-llm-suppressed`;
    }
  }

  const maxAgeDays =
    (settings[AppSetting.MinAccountAgeDaysToSkip] as number) ?? 0;
  if (maxAgeDays > 0 && user.createdAt) {
    const ageDays =
      (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > maxAgeDays) {
      skipLlm = true;
      reason = reason
        ? `${reason}+account-age-${Math.floor(ageDays)}d`
        : `account-age-${Math.floor(ageDays)}d-above-${maxAgeDays}d-llm-suppressed`;
    }
  }

  return { skipCompletely: false, skipLlm, reason };
}

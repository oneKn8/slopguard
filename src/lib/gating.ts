import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import { AppSetting } from "../settings.js";

/**
 * Returns true if we should SKIP scoring this user (gating saves cost).
 */
export async function shouldSkipUser(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  username: string,
): Promise<{ skip: boolean; reason?: string }> {
  if (!username || username === "[deleted]" || username === "AutoModerator") {
    return { skip: true, reason: "system-or-deleted-user" };
  }

  let user;
  try {
    user = await ctx.reddit.getUserByUsername(username);
  } catch {
    return { skip: false }; // proceed; missing user data not fatal
  }
  if (!user) return { skip: false };

  // Karma gate
  const maxKarma = (settings[AppSetting.MaxKarmaToCheck] as number) ?? 0;
  if (maxKarma > 0) {
    const total = (user.linkKarma ?? 0) + (user.commentKarma ?? 0);
    if (total > maxKarma) {
      return { skip: true, reason: `karma-${total}-above-${maxKarma}` };
    }
  }

  // Account-age gate
  const maxAgeDays =
    (settings[AppSetting.MinAccountAgeDaysToSkip] as number) ?? 0;
  if (maxAgeDays > 0 && user.createdAt) {
    const ageDays =
      (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > maxAgeDays) {
      return { skip: true, reason: `account-age-${Math.floor(ageDays)}d-above-${maxAgeDays}d` };
    }
  }

  // Approved-submitters gate
  const ignoreApproved = settings[AppSetting.IgnoreApprovedUsers] !== false;
  if (ignoreApproved) {
    try {
      const subredditName =
        ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());
      const approved = await ctx.reddit
        .getApprovedUsers({ subredditName, username })
        .all();
      if (approved.length > 0) {
        return { skip: true, reason: "approved-submitter" };
      }
    } catch {
      //
    }
  }

  // Mod skip (never score moderator content)
  try {
    const subredditName =
      ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());
    const mods = await ctx.reddit
      .getModerators({ subredditName })
      .all();
    if (mods.some(m => m.username === username)) {
      return { skip: true, reason: "moderator" };
    }
  } catch {
    //
  }

  return { skip: false };
}

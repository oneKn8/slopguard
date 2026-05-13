import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import type { EnsembleScore } from "../types.js";
import { AppSetting } from "../settings.js";
import { incrUserRemoved, bumpDailyMetrics } from "../redis.js";
import { recordConfirmedRemoval } from "./federation.js";

interface TemplateVars {
  score: string;
  models: string;
  reason: string;
  author: string;
  subreddit: string;
}

function fill(template: string, vars: TemplateVars): string {
  return template
    .replaceAll("{{score}}", vars.score)
    .replaceAll("{{models}}", vars.models)
    .replaceAll("{{reason}}", vars.reason)
    .replaceAll("{{author}}", vars.author)
    .replaceAll("{{subreddit}}", vars.subreddit);
}

export async function removeAsAi(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  score: EnsembleScore,
): Promise<{ ok: boolean; message: string }> {
  const subredditName =
    ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());

  const removalReasonTemplate =
    (settings[AppSetting.RemovalReasonTemplate] as string) ?? "";
  const replyTemplate =
    (settings[AppSetting.RemovalReplyTemplate] as string) ?? "";

  const successfulProviders = score.providers
    .filter(p => !p.error)
    .map(p => p.model)
    .join(", ");

  const topReasoning = score.providers
    .filter(p => !p.error)
    .map(p => p.reasoning)
    .filter(Boolean)
    .join(" | ");

  const vars: TemplateVars = {
    score: score.finalScore.toFixed(2),
    models: successfulProviders,
    reason: topReasoning,
    author: score.authorName,
    subreddit: subredditName,
  };

  try {
    if (score.itemType === "post") {
      const post = await ctx.reddit.getPostById(score.itemId);
      await post.remove(false);
      const replyText = fill(replyTemplate, vars);
      if (replyText.trim().length > 0) {
        const c = await post.addComment({ text: replyText });
        await c.distinguish(true);
        await c.lock();
      }
      const reasonText = fill(removalReasonTemplate, vars);
      // Mod-note attached to author for cross-mod consistency
      try {
        await ctx.reddit.addModNote({
          subreddit: subredditName,
          user: score.authorName,
          note: `Slopguard removed post (${vars.score}): ${reasonText.slice(0, 200)}`,
          label: "SPAM_WARNING",
        });
      } catch (e) {
        console.warn(`Slopguard: addModNote failed: ${(e as Error).message}`);
      }
    } else {
      const comment = await ctx.reddit.getCommentById(score.itemId);
      await comment.remove(false);
      try {
        await ctx.reddit.addModNote({
          subreddit: subredditName,
          user: score.authorName,
          note: `Slopguard removed comment (${vars.score})`,
          label: "SPAM_WARNING",
        });
      } catch {
        //
      }
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  await incrUserRemoved(ctx, score.authorName);
  await bumpDailyMetrics(ctx, {
    manualRemoved: 1,
    estimatedTimeSavedMinutes: 3,
  });

  // Hashed-only contribution to the federation outbox (no-op when
  // federation is disabled). See lib/federation.ts for the privacy model.
  await recordConfirmedRemoval(ctx, settings as Record<string, unknown>, {
    authorName: score.authorName,
    subredditName,
  });

  return {
    ok: true,
    message: `Removed ${score.itemType} ${score.itemId} as AI (score ${vars.score}).`,
  };
}

export async function autoRemoveIfThreshold(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  score: EnsembleScore,
): Promise<boolean> {
  const enabled = settings[AppSetting.AutoRemoveEnabled] === true;
  if (!enabled) return false;
  const threshold =
    (settings[AppSetting.AutoRemoveThreshold] as number) ?? 0.92;
  if (score.finalScore < threshold) return false;
  if (score.confidence === "low") return false;

  const result = await removeAsAi(ctx, settings, score);
  if (result.ok) {
    await bumpDailyMetrics(ctx, {
      autoRemoved: 1,
      manualRemoved: -1, // adjust — autoremoved already counted manualRemoved+1, subtract
    });
  }
  return result.ok;
}

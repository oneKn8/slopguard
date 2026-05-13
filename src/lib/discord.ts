import type { TriggerContext, Context } from "@devvit/public-api";
import type { EnsembleScore } from "../types.js";
import { AppSetting } from "../settings.js";
import { markHandled } from "../redis.js";

/**
 * Optional Discord webhook notifier. When `DiscordWebhookUrl` is set in
 * settings, every first-flag event for an item is POSTed to the webhook
 * as an embed. Dedupes per-item via `markHandled` so re-scores don't
 * spam the channel.
 *
 * Failures are swallowed — we never let a webhook timeout break the
 * trigger handler.
 */

const COLOR_BY_CONFIDENCE: Record<EnsembleScore["confidence"], number> = {
  high: 0xd62728, // red
  medium: 0xff7f0e, // orange
  low: 0x888888, // grey
};

function buildEmbed(
  score: EnsembleScore,
  subredditName: string,
  itemUrl: string | undefined,
): unknown {
  const topReasons =
    score.topReasons ?? score.localSignals?.topReasons ?? [];
  const reasonsField =
    topReasons.length > 0
      ? topReasons.slice(0, 4).map(r => `• ${r}`).join("\n")
      : "_(no specific reasons recorded)_";

  return {
    title: `Slopguard flag — ${(score.finalScore * 100).toFixed(0)}% (${score.confidence})`,
    description: `${score.itemType} by u/${score.authorName} in r/${subredditName}`,
    color: COLOR_BY_CONFIDENCE[score.confidence],
    url: itemUrl ?? undefined,
    fields: [
      { name: "Top reasons", value: reasonsField, inline: false },
      {
        name: "Breakdown",
        value: [
          `source: ${score.source}`,
          score.localScore !== undefined
            ? `local: ${(score.localScore * 100).toFixed(0)}%`
            : undefined,
          score.llmScore !== undefined
            ? `llm: ${(score.llmScore * 100).toFixed(0)}%`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        inline: false,
      },
    ],
    timestamp: new Date(score.scoredAt).toISOString(),
    footer: { text: "Slopguard" },
  };
}

function looksLikeDiscordWebhook(url: string): boolean {
  return (
    url.startsWith("https://discord.com/api/webhooks/") ||
    url.startsWith("https://discordapp.com/api/webhooks/")
  );
}

async function permalinkOf(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<string | undefined> {
  try {
    if (itemId.startsWith("t3_")) {
      const post = await ctx.reddit.getPostById(itemId);
      return post.permalink ? `https://reddit.com${post.permalink}` : undefined;
    }
    if (itemId.startsWith("t1_")) {
      const comment = await ctx.reddit.getCommentById(itemId);
      return comment.permalink
        ? `https://reddit.com${comment.permalink}`
        : undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export async function notifyDiscord(
  ctx: TriggerContext | Context,
  settings: Record<string, unknown>,
  score: EnsembleScore,
): Promise<{ ok: boolean; reason?: string }> {
  const url = (settings[AppSetting.DiscordWebhookUrl] as string) ?? "";
  if (!url) return { ok: false, reason: "no webhook configured" };
  if (!looksLikeDiscordWebhook(url)) {
    return { ok: false, reason: "URL is not a Discord webhook" };
  }

  // Dedupe — only one Discord ping per item.
  const ok = await markHandled(ctx, "discord", score.itemId);
  if (!ok) return { ok: true, reason: "already notified" };

  const subredditName =
    ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());
  const permalink = await permalinkOf(ctx, score.itemId);

  const body = JSON.stringify({
    username: "Slopguard",
    embeds: [buildEmbed(score, subredditName, permalink)],
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      return { ok: false, reason: `webhook ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

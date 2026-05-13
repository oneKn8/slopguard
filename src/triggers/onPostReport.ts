import type { PostReport } from "@devvit/protos";
import type { TriggerContext } from "@devvit/public-api";
import { runTriage } from "../lib/triage.js";
import {
  saveScore,
  getScore,
  bumpDailyMetrics,
  incrUserFlag,
  markHandled,
  markFlagCounted,
} from "../redis.js";
import { AppSetting } from "../settings.js";

// When a user reports a post, re-run triage with forceLlm = true so we pay
// the extra cents to get a confident answer — mod attention is implied.
export async function onPostReport(
  event: PostReport,
  context: TriggerContext,
): Promise<void> {
  if (!event.post) return;

  // Dedupe on post id alone — different report reasons for the same post
  // shouldn't each pay for a full LLM-escalated re-score.
  const handled = await markHandled(context, "postReport", event.post.id);
  if (!handled) return;

  const settings = await context.settings.getAll();

  // Use cached score if it was already high-confidence and recent (<1hr)
  const cached = await getScore(context, event.post.id);
  if (
    cached &&
    cached.confidence === "high" &&
    Date.now() - cached.scoredAt < 60 * 60 * 1000
  ) {
    return;
  }

  const title = event.post.title ?? "";
  const body = event.post.selftext ?? "";
  if (`${title}\n${body}`.trim().length < 25) return;

  // PostReport events don't carry author name — fetch from Reddit API.
  let authorName = "";
  try {
    const post = await context.reddit.getPostById(event.post.id);
    authorName = post.authorName ?? "";
  } catch {
    return;
  }
  if (!authorName) return;

  const subredditName =
    context.subredditName ??
    (await context.reddit.getCurrentSubredditName());

  const score = await runTriage(context, settings, {
    itemId: event.post.id,
    itemType: "post",
    subredditName,
    authorName,
    title,
    body,
    url: event.post.url,
    forceLlm: settings[AppSetting.UseLlmEscalation] === true,
  });

  if (!score) return;

  await saveScore(context, score);
  await bumpDailyMetrics(context, {
    itemsScored: 1,
    totalCostUsd: score.providers.reduce((a, p) => a + p.costUsd, 0),
  });

  const flagThreshold = (settings[AppSetting.FlagThreshold] as number) ?? 0.6;
  if (score.finalScore >= flagThreshold) {
    if (await markFlagCounted(context, event.post.id)) {
      await bumpDailyMetrics(context, { flagged: 1 });
      await incrUserFlag(context, authorName);
      const { pushToQueue } = await import("../customPost/queue.js");
      await pushToQueue(context, event.post.id);
    }
  }
}

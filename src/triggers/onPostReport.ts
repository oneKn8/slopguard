import type { PostReport } from "@devvit/protos";
import type { TriggerContext } from "@devvit/public-api";
import { scoreItem } from "../ensemble/index.js";
import { saveScore, getScore, bumpDailyMetrics, incrUserFlag, markHandled } from "../redis.js";
import { AppSetting } from "../settings.js";

// When a user reports a post, re-score with FORCE escalation — mod attention is implied,
// so spend the extra cents to get a confident answer.
export async function onPostReport(
  event: PostReport,
  context: TriggerContext,
): Promise<void> {
  if (!event.post) return;

  const handled = await markHandled(
    context,
    "postReport",
    `${event.post.id}:${event.reason ?? ""}`,
  );
  if (!handled) return;

  const settings = await context.settings.getAll();

  // Use cached score if it was already high-confidence and recent (< 1hr)
  const cached = await getScore(context, event.post.id);
  if (
    cached &&
    cached.confidence === "high" &&
    Date.now() - cached.scoredAt < 60 * 60 * 1000
  ) {
    return;
  }

  const text = [event.post.title, event.post.selftext]
    .filter(Boolean)
    .join("\n\n");
  if (text.trim().length < 25) return;

  // PostReport events don't carry author name — fetch from Reddit API.
  let authorName = "";
  try {
    const post = await context.reddit.getPostById(event.post.id);
    authorName = post.authorName ?? "";
  } catch {
    return;
  }
  if (!authorName) return;

  const score = await scoreItem(context, settings, {
    itemId: event.post.id,
    itemType: "post",
    authorName,
    text,
    forceEscalation: true,
  });

  if (!score) return;

  await saveScore(context, score);
  await bumpDailyMetrics(context, {
    itemsScored: 1,
    totalCostUsd: score.providers.reduce((a, p) => a + p.costUsd, 0),
  });

  const flagThreshold = (settings[AppSetting.FlagThreshold] as number) ?? 0.6;
  if (score.finalScore >= flagThreshold) {
    await bumpDailyMetrics(context, { flagged: 1 });
    await incrUserFlag(context, authorName);
  }
}

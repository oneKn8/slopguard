import type { PostCreate } from "@devvit/protos";
import type { TriggerContext } from "@devvit/public-api";
import { runTriage } from "../lib/triage.js";
import { saveScore, markHandled, bumpDailyMetrics, incrUserFlag } from "../redis.js";
import { shouldSkipUser } from "../lib/gating.js";
import { autoRemoveIfThreshold } from "../lib/modActions.js";
import { AppSetting, getPolicyMode } from "../settings.js";

export async function onPostCreate(
  event: PostCreate,
  context: TriggerContext,
): Promise<void> {
  if (!event.post) return;
  if (event.post.spam) return; // already filtered

  const handled = await markHandled(context, "postCreate", event.post.id);
  if (!handled) return;

  const settings = await context.settings.getAll();

  const author = event.author?.name ?? "";
  if (!author) return;
  const gate = await shouldSkipUser(context, settings, author);
  if (gate.skip) {
    console.log(`Slopguard: skip ${event.post.id} — ${gate.reason}`);
    return;
  }

  const title = event.post.title ?? "";
  const body = event.post.selftext ?? "";
  const combined = `${title}\n\n${body}`.trim();
  if (combined.length < 25) return;

  const subredditName =
    context.subredditName ??
    (await context.reddit.getCurrentSubredditName());

  const score = await runTriage(context, settings, {
    itemId: event.post.id,
    itemType: "post",
    subredditName,
    authorName: author,
    title,
    body,
    url: event.post.url,
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
    await incrUserFlag(context, author);

    if (getPolicyMode(settings) === "strict") {
      await autoRemoveIfThreshold(context, settings, score);
    }
  }
}

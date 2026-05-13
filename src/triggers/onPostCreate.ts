import type { PostCreate } from "@devvit/protos";
import type { TriggerContext } from "@devvit/public-api";
import { scoreItem } from "../ensemble/index.js";
import { saveScore, markHandled, bumpDailyMetrics, incrUserFlag } from "../redis.js";
import { shouldSkipUser } from "../lib/gating.js";
import { autoRemoveIfThreshold } from "../lib/modActions.js";
import { AppSetting } from "../settings.js";

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

  // Compose text: title + body
  const text = [event.post.title, event.post.selftext]
    .filter(Boolean)
    .join("\n\n");

  if (text.trim().length < 25) return;

  const score = await scoreItem(context, settings, {
    itemId: event.post.id,
    itemType: "post",
    authorName: author,
    text,
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
    await autoRemoveIfThreshold(context, settings, score);
  }
}

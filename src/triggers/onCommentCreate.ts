import type { CommentSubmit } from "@devvit/protos";
import type { TriggerContext } from "@devvit/public-api";
import { scoreItem } from "../ensemble/index.js";
import { saveScore, markHandled, bumpDailyMetrics, incrUserFlag } from "../redis.js";
import { shouldSkipUser } from "../lib/gating.js";
import { autoRemoveIfThreshold } from "../lib/modActions.js";
import { AppSetting } from "../settings.js";

export async function onCommentCreate(
  event: CommentSubmit,
  context: TriggerContext,
): Promise<void> {
  if (!event.comment) return;

  const handled = await markHandled(context, "commentSubmit", event.comment.id);
  if (!handled) return;

  const settings = await context.settings.getAll();
  const author = event.author?.name ?? "";
  const gate = await shouldSkipUser(context, settings, author);
  if (gate.skip) return;

  const text = event.comment.body ?? "";
  if (text.trim().length < 25) return;

  const score = await scoreItem(context, settings, {
    itemId: event.comment.id,
    itemType: "comment",
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

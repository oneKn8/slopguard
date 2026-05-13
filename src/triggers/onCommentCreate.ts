import type { CommentSubmit } from "@devvit/protos";
import type { TriggerContext } from "@devvit/public-api";
import { runTriage } from "../lib/triage.js";
import {
  saveScore,
  markHandled,
  bumpDailyMetrics,
  incrUserFlag,
  markFlagCounted,
} from "../redis.js";
import { shouldSkipUser } from "../lib/gating.js";
import { autoRemoveIfThreshold } from "../lib/modActions.js";
import { AppSetting, getPolicyMode } from "../settings.js";

export async function onCommentCreate(
  event: CommentSubmit,
  context: TriggerContext,
): Promise<void> {
  if (!event.comment) return;

  const handled = await markHandled(context, "commentSubmit", event.comment.id);
  if (!handled) return;

  const settings = await context.settings.getAll();
  const author = event.author?.name ?? "";
  if (!author) return;
  const gate = await shouldSkipUser(context, settings, author);
  if (gate.skip) return;

  const body = event.comment.body ?? "";
  if (body.trim().length < 25) return;

  const subredditName =
    context.subredditName ??
    (await context.reddit.getCurrentSubredditName());

  const score = await runTriage(context, settings, {
    itemId: event.comment.id,
    itemType: "comment",
    subredditName,
    authorName: author,
    body,
  });

  if (!score) return;

  await saveScore(context, score);
  await bumpDailyMetrics(context, {
    itemsScored: 1,
    totalCostUsd: score.providers.reduce((a, p) => a + p.costUsd, 0),
  });

  const flagThreshold = (settings[AppSetting.FlagThreshold] as number) ?? 0.6;
  if (score.finalScore >= flagThreshold) {
    if (await markFlagCounted(context, event.comment.id)) {
      await bumpDailyMetrics(context, { flagged: 1 });
      await incrUserFlag(context, author);
    }

    if (getPolicyMode(settings) === "strict") {
      await autoRemoveIfThreshold(context, settings, score);
    }
  }
}

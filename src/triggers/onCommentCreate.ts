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
import { userGate } from "../lib/gating.js";
import { autoRemoveIfThreshold } from "../lib/modActions.js";
import { sendVerifyDm } from "../lib/verifyAuthor.js";
import { pushToQueue } from "../customPost/queue.js";
import { notifyDiscord } from "../lib/discord.js";
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
  const gate = await userGate(context, settings, author);
  if (gate.skipCompletely) return;

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
    skipLlm: gate.skipLlm,
  });

  if (!score) return;

  await saveScore(context, score);
  await bumpDailyMetrics(context, {
    itemsScored: 1,
    totalCostUsd: score.providers.reduce((a, p) => a + p.costUsd, 0),
  });

  const flagThreshold = (settings[AppSetting.FlagThreshold] as number) ?? 0.6;
  if (score.finalScore >= flagThreshold) {
    const firstFlag = await markFlagCounted(context, event.comment.id);
    if (firstFlag) {
      await bumpDailyMetrics(context, { flagged: 1 });
      await incrUserFlag(context, author);
      await pushToQueue(context, event.comment.id);
      void notifyDiscord(context, settings, score);
    }

    const mode = getPolicyMode(settings);
    if (mode === "strict") {
      await autoRemoveIfThreshold(context, settings, score);
    }
    if ((mode === "verify" || mode === "strict") && firstFlag) {
      await sendVerifyDm(context, score);
    }
  }
}

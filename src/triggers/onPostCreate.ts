import type { PostCreate } from "@devvit/protos";
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
import { isImagePostUrl } from "../lib/triage.js";
import { autoRemoveIfThreshold } from "../lib/modActions.js";
import { sendVerifyDm } from "../lib/verifyAuthor.js";
import { pushToQueue } from "../customPost/queue.js";
import { notifyDiscord } from "../lib/discord.js";
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
  const gate = await userGate(context, settings, author);
  if (gate.skipCompletely) {
    console.log(`Slopguard: skip ${event.post.id} — ${gate.reason}`);
    return;
  }

  const title = event.post.title ?? "";
  const body = event.post.selftext ?? "";
  const combined = `${title}\n\n${body}`.trim();
  // Length gate suppresses cheap heuristics on near-empty TEXT posts. Image
  // posts can have short titles and still warrant a vision pass + OCR, so
  // we don't short-circuit them here.
  if (combined.length < 25 && !isImagePostUrl(event.post.url)) return;

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
    skipLlm: gate.skipLlm,
  });

  if (!score) return;

  await saveScore(context, score);
  await bumpDailyMetrics(context, {
    itemsScored: 1,
    totalCostUsd:
      score.providers.reduce((a, p) => a + p.costUsd, 0) +
      (score.visionCostUsd ?? 0),
  });

  const flagThreshold = (settings[AppSetting.FlagThreshold] as number) ?? 0.6;
  if (score.finalScore >= flagThreshold) {
    const firstFlag = await markFlagCounted(context, event.post.id);
    if (firstFlag) {
      await bumpDailyMetrics(context, { flagged: 1 });
      await incrUserFlag(context, author);
      await pushToQueue(context, event.post.id);
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

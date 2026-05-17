import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import { getScore, saveScore } from "../redis.js";
import { runTriage } from "../lib/triage.js";
import { removeAsAi } from "../lib/modActions.js";

export async function removeAsAiFromMenu(
  event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const targetId = event.targetId;
  if (!targetId) {
    context.ui.showToast("Slopguard: no target item.");
    return;
  }

  const settings = await context.settings.getAll();
  let score = await getScore(context, targetId);

  if (!score) {
    context.ui.showToast("Slopguard: no score yet — scoring before removal…");
    let title = "";
    let body = "";
    let url: string | undefined;
    let authorName = "";
    let itemType: "post" | "comment" = "post";

    if (targetId.startsWith("t3_")) {
      const post = await context.reddit.getPostById(targetId);
      title = post.title ?? "";
      body = post.body ?? "";
      url = post.url;
      authorName = post.authorName;
      itemType = "post";
    } else if (targetId.startsWith("t1_")) {
      const comment = await context.reddit.getCommentById(targetId);
      body = comment.body ?? "";
      authorName = comment.authorName;
      itemType = "comment";
    } else {
      context.ui.showToast("Slopguard: unsupported target type.");
      return;
    }

    const subredditName =
      context.subredditName ?? (await context.reddit.getCurrentSubredditName());

    // Local-first: route through runTriage, NOT scoreItem. This ensures the
    // manual remove works even when no API keys are configured — local
    // signals alone can justify a removal when they're strong enough.
    score = await runTriage(context, settings, {
      itemId: targetId,
      itemType,
      subredditName,
      authorName,
      title,
      body,
      url,
      forceLlm: true, // mod manually invoked — pay for escalation if keys exist
    });

    if (!score) {
      context.ui.showToast(
        "Slopguard: scoring produced no result (text too short or user gated).",
      );
      return;
    }
    await saveScore(context, score);
  }

  const result = await removeAsAi(context, settings, score);
  context.ui.showToast(
    result.ok
      ? `Slopguard: removed (score ${(score.finalScore * 100).toFixed(0)}%).`
      : `Slopguard: error — ${result.message}`,
  );
}

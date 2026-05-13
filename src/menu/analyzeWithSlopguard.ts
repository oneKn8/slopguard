import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import { runTriage } from "../lib/triage.js";
import { saveScore } from "../redis.js";
import { formatExplanation } from "./explainScore.js";

/**
 * Manual mod trigger — runs the full triage pipeline on a post or comment
 * (forces LLM escalation if keys are configured) and shows the full
 * explainability breakdown. Use when a mod wants Slopguard's take on
 * something the auto-triggers missed (e.g. an older item, an item that
 * was below the auto-scoring threshold).
 */
export async function analyzeWithSlopguardFromMenu(
  event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const targetId = event.targetId;
  if (!targetId) {
    context.ui.showToast("Slopguard: no target.");
    return;
  }

  context.ui.showToast("Slopguard: analyzing…");
  const settings = await context.settings.getAll();
  const subredditName =
    context.subredditName ?? (await context.reddit.getCurrentSubredditName());

  let title: string | undefined;
  let body = "";
  let url: string | undefined;
  let authorName = "";
  let itemType: "post" | "comment";

  try {
    if (targetId.startsWith("t3_")) {
      const post = await context.reddit.getPostById(targetId);
      title = post.title;
      body = post.body ?? "";
      url = post.url;
      authorName = post.authorName ?? "";
      itemType = "post";
    } else if (targetId.startsWith("t1_")) {
      const comment = await context.reddit.getCommentById(targetId);
      body = comment.body;
      authorName = comment.authorName;
      itemType = "comment";
    } else {
      context.ui.showToast("Slopguard: unsupported target type.");
      return;
    }
  } catch (err) {
    context.ui.showToast(
      `Slopguard: failed to fetch item — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const score = await runTriage(context, settings, {
    itemId: targetId,
    itemType,
    subredditName,
    authorName,
    title,
    body,
    url,
    forceLlm: true,
  });

  if (!score) {
    context.ui.showToast(
      "Slopguard: analysis failed — check API keys + spend cap.",
    );
    return;
  }

  await saveScore(context, score);
  console.log(`Slopguard manual analysis:\n${formatExplanation(score)}`);
  context.ui.showToast(
    `Slopguard ${(score.finalScore * 100).toFixed(0)}% (${score.confidence}, ${score.source}). Details in logs.`,
  );
}

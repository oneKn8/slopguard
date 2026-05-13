import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import { getScore } from "../redis.js";
import { scoreItem } from "../ensemble/index.js";
import { saveScore } from "../redis.js";
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
    let text = "";
    let authorName = "";
    let itemType: "post" | "comment" = "post";

    if (targetId.startsWith("t3_")) {
      const post = await context.reddit.getPostById(targetId);
      text = [post.title, post.body].filter(Boolean).join("\n\n");
      authorName = post.authorName;
      itemType = "post";
    } else if (targetId.startsWith("t1_")) {
      const comment = await context.reddit.getCommentById(targetId);
      text = comment.body;
      authorName = comment.authorName;
      itemType = "comment";
    } else {
      context.ui.showToast("Slopguard: unsupported target type.");
      return;
    }

    score = await scoreItem(context, settings, {
      itemId: targetId,
      itemType,
      authorName,
      text,
      forceEscalation: true,
    });

    if (!score) {
      context.ui.showToast(
        "Slopguard: scoring failed — check API keys + spend cap.",
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

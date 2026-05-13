import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import { getScore } from "../redis.js";
import { scoreItem } from "../ensemble/index.js";
import { saveScore } from "../redis.js";
import type { EnsembleScore } from "../types.js";

function formatExplanation(score: EnsembleScore): string {
  const lines: string[] = [];
  lines.push(`**AI-content score: ${(score.finalScore * 100).toFixed(0)}%**`);
  lines.push(`Confidence: ${score.confidence}`);
  if (score.disagreement > 0) {
    lines.push(`Model disagreement: ${score.disagreement.toFixed(2)}`);
  }
  lines.push("");
  lines.push("**Per-model breakdown:**");
  for (const p of score.providers) {
    if (p.error) {
      lines.push(`- ${p.model}: error (${p.error})`);
      continue;
    }
    lines.push(
      `- **${p.model}** ${(p.score * 100).toFixed(0)}% — ${p.reasoning}`,
    );
    if (p.signals.length > 0) {
      lines.push(`  Signals: ${p.signals.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export async function explainScoreFromMenu(
  event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const targetId = event.targetId;
  if (!targetId) {
    context.ui.showToast("Slopguard: no target item.");
    return;
  }

  let score = await getScore(context, targetId);

  if (!score) {
    const settings = await context.settings.getAll();
    context.ui.showToast("Slopguard: scoring now (no cached result)…");

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
      context.ui.showToast("Slopguard: scoring failed — check API keys + spend cap.");
      return;
    }

    await saveScore(context, score);
  }

  const text = formatExplanation(score);
  // Show in toast (short) + log full text
  console.log(`Slopguard explanation:\n${text}`);
  context.ui.showToast(
    `AI score: ${(score.finalScore * 100).toFixed(0)}% (${score.confidence}). Details in logs.`,
  );
}

import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import { getScore, saveScore } from "../redis.js";
import { runTriage } from "../lib/triage.js";
import { readVerify } from "../lib/verifyAuthor.js";
import type { EnsembleScore } from "../types.js";

export function formatExplanation(score: EnsembleScore): string {
  const lines: string[] = [];
  lines.push(`**Slopguard score: ${(score.finalScore * 100).toFixed(0)}%**`);
  lines.push(`Confidence: ${score.confidence}    Source: ${score.source}`);
  if (score.localScore !== undefined) {
    lines.push(`Local: ${(score.localScore * 100).toFixed(0)}%${
      score.llmScore !== undefined
        ? `    LLM: ${(score.llmScore * 100).toFixed(0)}%`
        : ""
    }`);
  }

  if (score.topReasons && score.topReasons.length > 0) {
    lines.push("");
    lines.push("**Top reasons:**");
    for (const r of score.topReasons) lines.push(`- ${r}`);
  }

  if (score.localSignals) {
    lines.push("");
    lines.push("**Local signals:**");
    for (const s of score.localSignals.perSignal) {
      if (s.score === 0 && s.reasons.length === 0) continue;
      const pct = (s.score * 100).toFixed(0);
      lines.push(`- **${s.name}** ${pct}%`);
      for (const r of s.reasons.slice(0, 3)) {
        lines.push(`  • ${r}`);
      }
    }
  }

  if (score.providers.length > 0) {
    lines.push("");
    lines.push(
      `**LLM ensemble** (disagreement ${score.disagreement.toFixed(2)}):`,
    );
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

    const subredditName =
      context.subredditName ??
      (await context.reddit.getCurrentSubredditName());

    let title: string | undefined;
    let body = "";
    let url: string | undefined;
    let authorName = "";
    let itemType: "post" | "comment" = "post";

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

    score = await runTriage(context, settings, {
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
        "Slopguard: scoring failed — check API keys + spend cap.",
      );
      return;
    }

    await saveScore(context, score);
  }

  let text = formatExplanation(score);

  // If we asked the author to verify and they replied, surface that on the
  // explainability card so mods see context next to the score.
  const verify = await readVerify(context, targetId);
  if (verify?.reply) {
    const cls = verify.reply.classification;
    text +=
      `\n\n**Verify-author reply** (received ${new Date(verify.reply.receivedAt).toISOString()}):\n` +
      `> ${verify.reply.text.slice(0, 600).replace(/\n+/g, " ")}` +
      (cls
        ? `\n\nClassifier: **${cls.category}** (${(cls.confidence * 100).toFixed(0)}%) — ${cls.reasoning}`
        : "");
  }

  console.log(`Slopguard explanation:\n${text}`);
  context.ui.showToast(
    `Slopguard ${(score.finalScore * 100).toFixed(0)}% (${score.confidence}). Details in logs.`,
  );
}

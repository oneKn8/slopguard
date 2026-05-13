import type { TriggerContext, Context } from "@devvit/public-api";
import type { EnsembleScore } from "../types.js";

/**
 * Verify-author: send the author a modmail asking for a brief explanation
 * of how they wrote the flagged content. Stores a Redis ledger so that when
 * the author replies (handled separately via the ModMail trigger), the reply
 * is attached back to the score's review card.
 *
 * Conservative by design:
 *   - Default mode is *not* "verify" — mods must opt in.
 *   - Modmail body acknowledges this may be wrong and asks politely.
 *   - We never auto-remove based on lack of reply. Silence is not a verdict.
 *
 * Research basis: AppealMod (arxiv 2301.07163) — friction-on-appeal reduces
 * the load on mods while preserving fairness.
 */

const VERIFY_KEY = (itemId: string) => `sg:verify:${itemId}`;
const CONV_INDEX_KEY = (conversationId: string) =>
  `sg:verify-conv:${conversationId}`;
const RECORD_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export interface VerifyRequest {
  itemId: string;
  itemType: "post" | "comment";
  authorName: string;
  subredditName: string;
  score: number;
  topReasons: string[];
  sentAt: number;
  conversationId?: string;
  reply?: {
    text: string;
    receivedAt: number;
  };
  status: "sent" | "replied" | "send_failed";
}

const SUBJECT_PREFIX = "[Slopguard verification]";

interface DevvitModMail {
  createConversation?(args: {
    subredditName: string;
    subject: string;
    body: string;
    to: string;
  }): Promise<{ conversation?: { id?: string }; conversationId?: string }>;
}

function modMailOf(ctx: TriggerContext | Context): DevvitModMail | undefined {
  return (
    ctx.reddit as unknown as { modMail?: DevvitModMail }
  ).modMail;
}

function defaultBody(args: {
  authorName: string;
  subredditName: string;
  score: number;
  topReasons: string[];
  itemType: "post" | "comment";
}): string {
  const pct = (args.score * 100).toFixed(0);
  const reasonLines = args.topReasons.length
    ? args.topReasons.map(r => `  - ${r}`).join("\n")
    : "  - (no specific reasons recorded)";
  return [
    `Hi u/${args.authorName},`,
    "",
    `Your recent ${args.itemType} in r/${args.subredditName} was flagged for human review by Slopguard (an automated tool we use to surface possible AI-generated, spam, or scam content). The system is not always right — this is why we're asking, rather than removing.`,
    "",
    `Slopguard score: ${pct}%`,
    `Signals that triggered review:`,
    reasonLines,
    "",
    `If your ${args.itemType} is genuine, please reply briefly with a few words about how you wrote it (e.g. "I wrote this from my own experience after X"). A short, personal reply is plenty — we don't need a long defense.`,
    "",
    `If you don't reply, no action is automatic; a human moderator will still review.`,
    "",
    `Thanks,`,
    `r/${args.subredditName} mods (via Slopguard)`,
  ].join("\n");
}

export async function sendVerifyDm(
  ctx: TriggerContext | Context,
  score: EnsembleScore,
): Promise<{ ok: boolean; conversationId?: string; reason?: string }> {
  const subredditName =
    ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName());

  // Don't DM deleted / system accounts.
  if (
    !score.authorName ||
    score.authorName === "[deleted]" ||
    score.authorName === "AutoModerator"
  ) {
    return { ok: false, reason: "no valid author" };
  }

  // Dedup: don't DM same author twice for same item.
  const existing = await readVerify(ctx, score.itemId);
  if (existing && existing.status !== "send_failed") {
    return {
      ok: true,
      conversationId: existing.conversationId,
      reason: "already_sent",
    };
  }

  const subject = `${SUBJECT_PREFIX} u/${score.authorName} / ${score.itemId}`;
  const body = defaultBody({
    authorName: score.authorName,
    subredditName,
    score: score.finalScore,
    topReasons: score.topReasons ?? score.localSignals?.topReasons ?? [],
    itemType: score.itemType,
  });

  const mm = modMailOf(ctx);
  let conversationId: string | undefined;
  let sendOk = false;
  let sendError: string | undefined;

  if (mm?.createConversation) {
    try {
      const res = await mm.createConversation({
        subredditName,
        subject,
        body,
        to: score.authorName,
      });
      conversationId =
        res?.conversation?.id ?? res?.conversationId ?? undefined;
      sendOk = true;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }
  } else {
    sendError = "modmail API unavailable on this Devvit runtime";
  }

  const record: VerifyRequest = {
    itemId: score.itemId,
    itemType: score.itemType,
    authorName: score.authorName,
    subredditName,
    score: score.finalScore,
    topReasons: score.topReasons ?? score.localSignals?.topReasons ?? [],
    sentAt: Date.now(),
    conversationId,
    status: sendOk ? "sent" : "send_failed",
  };

  await writeVerify(ctx, record);
  if (conversationId) {
    await ctx.redis.set(CONV_INDEX_KEY(conversationId), score.itemId, {
      expiration: new Date(Date.now() + RECORD_TTL_MS),
    });
  }

  return { ok: sendOk, conversationId, reason: sendError };
}

export async function readVerify(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<VerifyRequest | null> {
  const raw = await ctx.redis.get(VERIFY_KEY(itemId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VerifyRequest;
  } catch {
    return null;
  }
}

export async function writeVerify(
  ctx: TriggerContext | Context,
  record: VerifyRequest,
): Promise<void> {
  await ctx.redis.set(VERIFY_KEY(record.itemId), JSON.stringify(record), {
    expiration: new Date(Date.now() + RECORD_TTL_MS),
  });
}

export async function attachReplyByConversation(
  ctx: TriggerContext | Context,
  args: { conversationId: string; replyText: string },
): Promise<VerifyRequest | null> {
  const itemId = await ctx.redis.get(CONV_INDEX_KEY(args.conversationId));
  if (!itemId) return null;
  const record = await readVerify(ctx, itemId);
  if (!record) return null;
  record.reply = {
    text: args.replyText.slice(0, 2000),
    receivedAt: Date.now(),
  };
  record.status = "replied";
  await writeVerify(ctx, record);
  return record;
}

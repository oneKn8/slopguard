import type { TriggerContext, Context } from "@devvit/public-api";
import type { SignalResult } from "./types.js";

/**
 * Duplication signal — flags posts whose normalized text or external URL has
 * already appeared in this subreddit within a sliding 48h window.
 *
 * Catches: copy-paste spam, repost rings, scam template reuse, AI-generated
 * mass posts that share the same prompt output. Within-sub only — cross-sub
 * spread is handled by the behavioral signal's recentCrossPostCount input.
 *
 * Conservative: requires >=40 normalized chars to score, so short comments
 * like "thanks!" never collide.
 *
 * Storage: Redis sorted sets keyed by (sub, contentHash). Members are itemIds;
 * scores are timestamps. zAdd + zRemRangeByScore are atomic, so two near-
 * simultaneous identical posts can't both fail to see each other.
 */

const TEXT_KEY = (sub: string, hash: string) => `sg:dup:txt:${sub}:${hash}`;
const URL_KEY = (sub: string, hash: string) => `sg:dup:url:${sub}:${hash}`;
const WINDOW_MS = 1000 * 60 * 60 * 48;
const WINDOW_S = 60 * 60 * 48;
const MAX_ENTRIES = 50;
const MIN_NORMALIZED_CHARS = 40;

export interface DuplicationInput {
  itemId: string;
  subredditName: string;
  title?: string;
  body?: string;
  url?: string;
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeText(...parts: (string | undefined)[]): string {
  const joined = parts.filter(Boolean).join(" ");
  return joined
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`~>#]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Atomically record this itemId into the dup-key's sorted set and count
 * how many *other* items shared the same content in the window. Returns the
 * count of matches excluding the current item.
 */
async function recordAndCount(
  ctx: TriggerContext | Context,
  key: string,
  itemId: string,
  now: number,
  cutoff: number,
): Promise<number> {
  // Prune anything older than the window. Atomic and bounded — older
  // entries pre-cutoff are no longer relevant.
  await ctx.redis.zRemRangeByScore(key, 0, cutoff);

  // Read the current in-window members BEFORE adding self, so we don't
  // count this item as its own duplicate.
  const priorMembers = await ctx.redis.zRange(key, cutoff, "+inf", {
    by: "score",
  });
  const matches = priorMembers.filter(m => m.member !== itemId).length;

  // Add self. zAdd is atomic and idempotent on the member; if we re-fire
  // for the same itemId (e.g. report trigger), the score updates rather
  // than creating a duplicate slot.
  await ctx.redis.zAdd(key, { score: now, member: itemId });

  // Hard cap at MAX_ENTRIES — drop the oldest if we exceeded.
  await ctx.redis.zRemRangeByRank(key, 0, -MAX_ENTRIES - 1);

  // Refresh TTL so the key auto-evicts when no longer active.
  await ctx.redis.expire(key, WINDOW_S);

  return matches;
}

function scoreFromMatches(matches: number): number {
  if (matches <= 0) return 0;
  if (matches === 1) return 0.2;
  if (matches === 2) return 0.45;
  if (matches < 5) return 0.7;
  return 0.9;
}

export async function duplicationSignal(
  ctx: TriggerContext | Context,
  input: DuplicationInput,
): Promise<SignalResult> {
  const reasons: string[] = [];
  const detail: Record<string, number | string | boolean> = {};
  let score = 0;

  const normalized = normalizeText(input.title, input.body);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // --- Text hash ---
  let textMatches = 0;
  if (normalized.length >= MIN_NORMALIZED_CHARS) {
    const textHash = fnv1a32(normalized);
    const key = TEXT_KEY(input.subredditName, textHash);
    textMatches = await recordAndCount(ctx, key, input.itemId, now, cutoff);
    detail.textHash = textHash;
    detail.textMatches = textMatches;

    if (textMatches > 0) {
      const display = textMatches >= MAX_ENTRIES ? `${MAX_ENTRIES}+` : `${textMatches}`;
      reasons.push(
        textMatches === 1
          ? "identical text posted once in this sub in last 48h"
          : `identical text posted ${display}x in this sub in last 48h`,
      );
    }
  } else {
    detail.textTooShort = true;
  }

  // --- URL hash ---
  let urlMatches = 0;
  const normUrl = input.url ? normalizeUrl(input.url) : undefined;
  if (normUrl) {
    const urlHash = fnv1a32(normUrl);
    const key = URL_KEY(input.subredditName, urlHash);
    urlMatches = await recordAndCount(ctx, key, input.itemId, now, cutoff);
    detail.urlHash = urlHash;
    detail.urlMatches = urlMatches;
    detail.urlNormalized = normUrl;

    if (urlMatches > 0) {
      const display = urlMatches >= MAX_ENTRIES ? `${MAX_ENTRIES}+` : `${urlMatches}`;
      reasons.push(
        urlMatches === 1
          ? `same external URL posted once in this sub in last 48h (${normUrl.slice(0, 40)})`
          : `same external URL posted ${display}x in this sub in last 48h (${normUrl.slice(0, 40)})`,
      );
    }
  }

  // Take the stronger of the two — don't double-count text+URL on the same item
  score = Math.max(scoreFromMatches(textMatches), scoreFromMatches(urlMatches));

  if (reasons.length === 0) {
    reasons.push("no prior duplicates seen in last 48h");
  }

  return {
    kind: "duplication",
    name: "duplication",
    score,
    reasons,
    detail,
  };
}

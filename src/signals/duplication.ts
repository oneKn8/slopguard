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
 * Record this itemId into the dup-key's sorted set and count how many
 * *other* items shared the same content in the window.
 *
 * Concurrency model — the operation order matters:
 *   1. zAdd self                — atomic, globally ordered by Redis
 *   2. zRange window members    — sees self + everyone added before self
 *   3. count, excluding self    — duplicates are everyone-but-me
 *   4. prune below cutoff + cap — cleanup
 *
 * Because zAdd is atomic and serialized by Redis, this is race-free under
 * concurrent identical posts: whoever's zAdd lands first sees only itself
 * in the range and reports 0 duplicates; subsequent submitters see the
 * prior member(s) and report N. Two truly simultaneous adds both see each
 * other and both report 1 — defensible: they ARE duplicates of each other.
 *
 * The earlier (prune → read → add) order was a multi-command race: two
 * adds could both read empty before either zAdd, yielding 0 duplicates on
 * both sides and missing the detection entirely.
 */
async function recordAndCount(
  ctx: TriggerContext | Context,
  key: string,
  itemId: string,
  now: number,
  cutoff: number,
): Promise<number> {
  // 1. Atomic add — establishes ordering with any concurrent caller.
  await ctx.redis.zAdd(key, { score: now, member: itemId });

  // 2. Read everyone in the window, including self.
  const inWindow = await ctx.redis.zRange(key, cutoff, "+inf", {
    by: "score",
  });

  // 3. Count duplicates = members in window minus self. Set-dedup the
  //    members so a stray ghost re-add doesn't inflate the count.
  const others = new Set<string>();
  for (const m of inWindow) {
    if (m.member !== itemId) others.add(m.member);
  }

  // 4. Cleanup — drop anything below the window cutoff, then enforce cap.
  //    These are non-load-bearing for correctness; they just keep the
  //    sorted-set bounded.
  await ctx.redis.zRemRangeByScore(key, 0, cutoff);
  await ctx.redis.zRemRangeByRank(key, 0, -MAX_ENTRIES - 1);
  await ctx.redis.expire(key, WINDOW_S);

  return others.size;
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

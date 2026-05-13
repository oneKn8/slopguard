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
 */

const TEXT_KEY = (sub: string, hash: string) => `sg:dup:txt:${sub}:${hash}`;
const URL_KEY = (sub: string, hash: string) => `sg:dup:url:${sub}:${hash}`;
const WINDOW_MS = 1000 * 60 * 60 * 48;
const MAX_ENTRIES = 50;
const MIN_NORMALIZED_CHARS = 40;

export interface DuplicationInput {
  itemId: string;
  subredditName: string;
  title?: string;
  body?: string;
  url?: string;
}

interface DupEntry {
  id: string;
  ts: number;
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

async function readEntries(
  ctx: TriggerContext | Context,
  key: string,
): Promise<DupEntry[]> {
  const raw = await ctx.redis.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DupEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeEntries(
  ctx: TriggerContext | Context,
  key: string,
  entries: DupEntry[],
): Promise<void> {
  await ctx.redis.set(key, JSON.stringify(entries), {
    expiration: new Date(Date.now() + WINDOW_MS),
  });
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
    const prior = await readEntries(ctx, key);
    const fresh = prior.filter(e => e.ts >= cutoff && e.id !== input.itemId);
    textMatches = fresh.length;
    detail.textHash = textHash;
    detail.textMatches = textMatches;

    if (textMatches > 0) {
      reasons.push(
        textMatches === 1
          ? "identical text posted once in this sub in last 48h"
          : `identical text posted ${textMatches}x in this sub in last 48h`,
      );
    }

    // Record current item, prune to window + cap
    fresh.push({ id: input.itemId, ts: now });
    const pruned = fresh
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_ENTRIES);
    await writeEntries(ctx, key, pruned);
  } else {
    detail.textTooShort = true;
  }

  // --- URL hash ---
  let urlMatches = 0;
  const normUrl = input.url ? normalizeUrl(input.url) : undefined;
  if (normUrl) {
    const urlHash = fnv1a32(normUrl);
    const key = URL_KEY(input.subredditName, urlHash);
    const prior = await readEntries(ctx, key);
    const fresh = prior.filter(e => e.ts >= cutoff && e.id !== input.itemId);
    urlMatches = fresh.length;
    detail.urlHash = urlHash;
    detail.urlMatches = urlMatches;
    detail.urlNormalized = normUrl;

    if (urlMatches > 0) {
      reasons.push(
        urlMatches === 1
          ? `same external URL posted once in this sub in last 48h (${normUrl.slice(0, 40)})`
          : `same external URL posted ${urlMatches}x in this sub in last 48h (${normUrl.slice(0, 40)})`,
      );
    }

    fresh.push({ id: input.itemId, ts: now });
    const pruned = fresh
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_ENTRIES);
    await writeEntries(ctx, key, pruned);
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

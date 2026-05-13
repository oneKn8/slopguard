import type { TriggerContext, Context } from "@devvit/public-api";
import type { EnsembleScore } from "../types.js";
import { getScore } from "../redis.js";

/**
 * Recent-flagged queue — a capped list of `itemId`s ordered most-recent
 * first that the custom post dashboard reads. We append on every flag
 * event and trim to MAX_QUEUE so the list stays cheap to render.
 */

const QUEUE_KEY = "sg:queue:recent";
const QUEUE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export const MAX_QUEUE = 50;

interface QueueEntry {
  itemId: string;
  ts: number;
}

async function readQueue(ctx: TriggerContext | Context): Promise<QueueEntry[]> {
  const raw = await ctx.redis.get(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueueEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(
  ctx: TriggerContext | Context,
  entries: QueueEntry[],
): Promise<void> {
  await ctx.redis.set(QUEUE_KEY, JSON.stringify(entries), {
    expiration: new Date(Date.now() + QUEUE_TTL_MS),
  });
}

/**
 * Add an item to the recent-flagged queue. Idempotent — if the item is
 * already in the queue, its timestamp is refreshed.
 */
export async function pushToQueue(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<void> {
  const current = await readQueue(ctx);
  const filtered = current.filter(e => e.itemId !== itemId);
  filtered.unshift({ itemId, ts: Date.now() });
  await writeQueue(ctx, filtered.slice(0, MAX_QUEUE));
}

/**
 * Read the queue and hydrate each entry with its EnsembleScore. Drops
 * entries whose score is no longer in Redis (expired or manually deleted).
 */
export async function readFlaggedQueue(
  ctx: TriggerContext | Context,
  limit = 25,
): Promise<EnsembleScore[]> {
  const queue = await readQueue(ctx);
  const out: EnsembleScore[] = [];
  for (const entry of queue.slice(0, limit)) {
    const s = await getScore(ctx, entry.itemId);
    if (s) out.push(s);
  }
  return out;
}

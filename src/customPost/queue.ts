import type { TriggerContext, Context } from "@devvit/public-api";
import type { EnsembleScore } from "../types.js";
import { getScore } from "../redis.js";

/**
 * Recent-flagged queue — a capped, atomic sorted-set of `itemId`s scored by
 * timestamp (newest = highest score). zAdd is atomic so concurrent triggers
 * cannot lose entries the way a JSON-array read-modify-write could.
 */

const QUEUE_KEY = "sg:queue:recent";
const QUEUE_TTL_S = 60 * 60 * 24 * 7;
export const MAX_QUEUE = 50;

/**
 * Add an item to the recent-flagged queue. zAdd updates the score
 * (timestamp) atomically when the member already exists, so the same
 * itemId only takes one slot regardless of how many flags fire on it.
 */
export async function pushToQueue(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<void> {
  const now = Date.now();
  await ctx.redis.zAdd(QUEUE_KEY, { score: now, member: itemId });
  // Trim oldest entries past the cap. zRemRangeByRank is atomic; we drop
  // everything below the top MAX_QUEUE by rank (ascending = oldest first).
  await ctx.redis.zRemRangeByRank(QUEUE_KEY, 0, -MAX_QUEUE - 1);
  // Refresh TTL on activity. Devvit sorted sets don't carry a default TTL.
  await ctx.redis.expire(QUEUE_KEY, QUEUE_TTL_S);
}

/**
 * Read the queue and hydrate each entry with its EnsembleScore. Drops
 * entries whose score is no longer in Redis (expired or manually deleted).
 * Hydration happens in parallel so dashboard render cost is O(1) round-
 * trips instead of O(N).
 */
export async function readFlaggedQueue(
  ctx: TriggerContext | Context,
  limit = 25,
): Promise<EnsembleScore[]> {
  // Descending by score (newest first). zRange with reverse:true and
  // by:'rank' returns top-N members directly.
  const rows = await ctx.redis.zRange(QUEUE_KEY, 0, limit - 1, {
    by: "rank",
    reverse: true,
  });
  const fetched = await Promise.all(
    rows.map(r => getScore(ctx, r.member)),
  );
  return fetched.filter((s): s is EnsembleScore => s !== null);
}

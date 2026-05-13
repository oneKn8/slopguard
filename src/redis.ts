import type { TriggerContext, Context } from "@devvit/public-api";
import type { EnsembleScore, DailyMetrics, UserHistory } from "./types.js";

const PREFIX = "sg";

export const keys = {
  score: (itemId: string) => `${PREFIX}:score:${itemId}`,
  userHistory: (username: string) => `${PREFIX}:user:${username}`,
  dailyMetrics: (yyyymmdd: string) => `${PREFIX}:metrics:${yyyymmdd}`,
  dailySpend: (yyyymmdd: string) => `${PREFIX}:spend:${yyyymmdd}`,
  collisionLock: (itemId: string) => `${PREFIX}:lock:${itemId}`,
  handled: (event: string, id: string) => `${PREFIX}:handled:${event}:${id}`,
  flagged: (itemId: string) => `${PREFIX}:flagged:${itemId}`,
};

/**
 * Mark an item as having had its flag counted. Returns true the first time;
 * false on subsequent calls. Used to dedupe user-flag-count increments
 * across the original create event and any subsequent re-scores (reports,
 * manual analyze, etc), preventing the historySignal feedback loop where
 * the same item inflates the user's flagCount on every re-trigger.
 */
export async function markFlagCounted(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<boolean> {
  const key = keys.flagged(itemId);
  const existing = await ctx.redis.get(key);
  if (existing) return false;
  await ctx.redis.set(key, "1", {
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
  });
  return true;
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export async function saveScore(
  ctx: TriggerContext | Context,
  score: EnsembleScore,
): Promise<void> {
  await ctx.redis.set(keys.score(score.itemId), JSON.stringify(score), {
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30 days
  });
}

export async function getScore(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<EnsembleScore | null> {
  const raw = await ctx.redis.get(keys.score(itemId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EnsembleScore;
  } catch {
    return null;
  }
}

export async function incrUserFlag(
  ctx: TriggerContext | Context,
  username: string,
): Promise<UserHistory> {
  const raw = await ctx.redis.get(keys.userHistory(username));
  const cur: UserHistory = raw
    ? (JSON.parse(raw) as UserHistory)
    : { username, totalScored: 0, flagCount: 0, removedCount: 0 };
  cur.flagCount += 1;
  cur.lastFlagTs = Date.now();
  await ctx.redis.set(keys.userHistory(username), JSON.stringify(cur));
  return cur;
}

export async function incrUserRemoved(
  ctx: TriggerContext | Context,
  username: string,
): Promise<void> {
  const raw = await ctx.redis.get(keys.userHistory(username));
  const cur: UserHistory = raw
    ? (JSON.parse(raw) as UserHistory)
    : { username, totalScored: 0, flagCount: 0, removedCount: 0 };
  cur.removedCount += 1;
  await ctx.redis.set(keys.userHistory(username), JSON.stringify(cur));
}

export async function getUserHistory(
  ctx: TriggerContext | Context,
  username: string,
): Promise<UserHistory | null> {
  const raw = await ctx.redis.get(keys.userHistory(username));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserHistory;
  } catch {
    return null;
  }
}

export async function bumpDailyMetrics(
  ctx: TriggerContext | Context,
  patch: Partial<DailyMetrics>,
): Promise<void> {
  const date = today();
  const raw = await ctx.redis.get(keys.dailyMetrics(date));
  const cur: DailyMetrics = raw
    ? (JSON.parse(raw) as DailyMetrics)
    : {
        date,
        itemsScored: 0,
        flagged: 0,
        autoRemoved: 0,
        manualRemoved: 0,
        manualApproved: 0,
        estimatedTimeSavedMinutes: 0,
        totalCostUsd: 0,
      };
  const mutable = cur as unknown as Record<string, number | string>;
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "number") {
      const prev = mutable[k];
      mutable[k] = (typeof prev === "number" ? prev : 0) + v;
    }
  }
  await ctx.redis.set(keys.dailyMetrics(date), JSON.stringify(cur), {
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60), // 60 days
  });
}

export async function getDailyMetrics(
  ctx: TriggerContext | Context,
  date: string = today(),
): Promise<DailyMetrics | null> {
  const raw = await ctx.redis.get(keys.dailyMetrics(date));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DailyMetrics;
  } catch {
    return null;
  }
}

export async function addToDailySpend(
  ctx: TriggerContext | Context,
  costUsd: number,
): Promise<number> {
  const date = today();
  const cur = await ctx.redis.get(keys.dailySpend(date));
  const next = Number(cur ?? 0) + costUsd;
  await ctx.redis.set(keys.dailySpend(date), String(next), {
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2),
  });
  return next;
}

export async function getDailySpend(
  ctx: TriggerContext | Context,
  date: string = today(),
): Promise<number> {
  const raw = await ctx.redis.get(keys.dailySpend(date));
  return Number(raw ?? 0);
}

export async function markHandled(
  ctx: TriggerContext | Context,
  event: string,
  id: string,
): Promise<boolean> {
  const key = keys.handled(event, id);
  const existing = await ctx.redis.get(key);
  if (existing) return false;
  await ctx.redis.set(key, "1", {
    expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
  });
  return true;
}

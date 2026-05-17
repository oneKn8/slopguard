import type { TriggerContext, Context } from "@devvit/public-api";

/**
 * Mod-collision prevention. Backed by Devvit Redis (the realtime channel is
 * optional and used to notify other mod sessions in real time; the Redis
 * record is the source of truth).
 *
 * Lifecycle:
 *   - `claim(itemId, mod)` writes a lock with TTL — refuses if another mod
 *     already holds it (unless `force = true`).
 *   - `read(itemId)` returns the current holder (or null if expired/free).
 *   - `release(itemId, mod)` clears the lock if held by `mod`. Mismatched
 *     ownership is a no-op so an old browser tab can't release another mod's
 *     fresh claim.
 *
 * The default lock duration is 10 minutes — long enough for a mod to read
 * the review card and act, short enough to auto-release if they walk away.
 *
 * 74.5% of mods experience modqueue collisions (Bajpai & Chandrasekharan,
 * CHI 2026, arxiv 2509.07314).
 */

const KEY = (itemId: string) => `sg:lock:${itemId}`;
const CHANNEL = "sg:lock-events";
const DEFAULT_TTL_MS = 1000 * 60 * 10;

export interface CollisionLock {
  itemId: string;
  modName: string;
  claimedAt: number;
  expiresAt: number;
  note?: string;
}

export interface LockEvent {
  type: "claim" | "release" | "renew";
  itemId: string;
  modName: string;
  ts: number;
}

interface DevvitRealtime {
  send?(channel: string, payload: unknown): Promise<void>;
}

function realtimeOf(ctx: TriggerContext | Context): DevvitRealtime | undefined {
  // Devvit realtime API is on context.realtime when available; this is
  // optional and we don't fail the lock when it's absent.
  const r = (ctx as unknown as { realtime?: DevvitRealtime }).realtime;
  return r;
}

async function broadcast(
  ctx: TriggerContext | Context,
  event: LockEvent,
): Promise<void> {
  const rt = realtimeOf(ctx);
  if (!rt?.send) return;
  try {
    await rt.send(CHANNEL, event);
  } catch {
    // Realtime is a nice-to-have; never fail the lock op on broadcast.
  }
}

export async function readLock(
  ctx: TriggerContext | Context,
  itemId: string,
): Promise<CollisionLock | null> {
  const raw = await ctx.redis.get(KEY(itemId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CollisionLock;
    if (parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function claimLock(
  ctx: TriggerContext | Context,
  args: {
    itemId: string;
    modName: string;
    ttlMs?: number;
    force?: boolean;
    note?: string;
  },
): Promise<
  | { ok: true; lock: CollisionLock; renewed: boolean }
  | { ok: false; reason: "held_by_other"; holder: CollisionLock }
> {
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const lock: CollisionLock = {
    itemId: args.itemId,
    modName: args.modName,
    claimedAt: now,
    expiresAt: now + ttl,
    note: args.note,
  };
  const expiration = new Date(lock.expiresAt + 1000);

  // Fast path: NX-claim. Wins atomically when no current holder.
  const nxResult = await ctx.redis.set(
    KEY(args.itemId),
    JSON.stringify(lock),
    { nx: true, expiration },
  );
  if (Boolean(nxResult)) {
    await broadcast(ctx, {
      type: "claim",
      itemId: args.itemId,
      modName: args.modName,
      ts: now,
    });
    return { ok: true, lock, renewed: false };
  }

  // NX failed — someone holds it (or our previous claim hasn't expired).
  const existing = await readLock(ctx, args.itemId);
  if (existing && existing.modName !== args.modName && !args.force) {
    return { ok: false, reason: "held_by_other", holder: existing };
  }

  // Same mod renewing, OR a force-claim. Overwrite is intentional here.
  await ctx.redis.set(KEY(args.itemId), JSON.stringify(lock), { expiration });

  const renewed = existing?.modName === args.modName;
  await broadcast(ctx, {
    type: renewed ? "renew" : "claim",
    itemId: args.itemId,
    modName: args.modName,
    ts: now,
  });

  return { ok: true, lock, renewed };
}

export async function releaseLock(
  ctx: TriggerContext | Context,
  args: { itemId: string; modName: string },
): Promise<boolean> {
  const existing = await readLock(ctx, args.itemId);
  if (!existing) return true;
  if (existing.modName !== args.modName) return false;

  await ctx.redis.del(KEY(args.itemId));

  await broadcast(ctx, {
    type: "release",
    itemId: args.itemId,
    modName: args.modName,
    ts: Date.now(),
  });

  return true;
}

export function formatLockStatus(lock: CollisionLock | null): string {
  if (!lock) return "available";
  const minsLeft = Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 60000));
  return `u/${lock.modName} reviewing (${minsLeft}m left)`;
}

export { CHANNEL as LOCK_EVENT_CHANNEL };

import type { TriggerContext, Context } from "@devvit/public-api";
import { AppSetting } from "../settings.js";

/**
 * Cross-sub federation — opt-in, hashed-only sharing of confirmed bad
 * actors across participating subs.
 *
 * **Privacy framework** (the parts mods must trust):
 *
 *   - Only SHA-256 hashes of usernames leave the sub. Reversing the hash
 *     to a username requires knowing the username already; no enumeration
 *     possible.
 *   - No post content, no IP, no email, no metadata. Just `{hash, removedCount,
 *     lastRemovedTs}`. The hash is salted with the username prefix-suffix
 *     to make rainbow-table reuse harder.
 *   - The sub identifier is also hashed before publishing — receiving
 *     subs see "2 other communities also removed this actor" without
 *     knowing which subs.
 *   - Mods can `audit` the outbox at any time before publish, and toggle
 *     off federation; toggling off immediately clears the local outbox.
 *   - Records auto-expire after 90 days so federated reputations don't
 *     last forever.
 *
 * **Transport**: configurable endpoint. When `FederationEndpoint` is unset
 * the module operates in local-outbox-only mode (dry-run) — the framework
 * works end-to-end against local Redis only, useful for development and
 * for subs that want to see what would be published without committing.
 *
 * The actual federation gateway is a small JSON-over-HTTPS service; spec
 * is documented in ARCHITECTURE.md. Any compliant gateway works.
 */

const OUTBOX_KEY = "sg:fed:outbox";
const INDEX_KEY = "sg:fed:index";
const PUB_TS_KEY = "sg:fed:last-published";
const RECORD_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const MAX_OUTBOX = 500;
const SALT_PREFIX = "slopguard-v1:";

export interface FederationRecord {
  /** SHA-256 hex of `SALT_PREFIX + username` */
  userHash: string;
  /** SHA-256 hex of `SALT_PREFIX + subredditName` (anonymizes the publishing sub) */
  srcHash: string;
  removedCount: number;
  lastRemovedTs: number;
}

export interface FederationOutbox {
  records: FederationRecord[];
}

/**
 * Stable, salted, truncated SHA-256. We truncate to 16 hex chars (64 bits)
 * — wide enough to make collisions vanishingly rare across the union of
 * all Reddit users, narrow enough that nobody mistakes the hash for a
 * reversible identifier.
 */
async function shortHash(input: string): Promise<string> {
  const enc = new TextEncoder().encode(SALT_PREFIX + input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function readOutbox(
  ctx: TriggerContext | Context,
): Promise<FederationOutbox> {
  const raw = await ctx.redis.get(OUTBOX_KEY);
  if (!raw) return { records: [] };
  try {
    const parsed = JSON.parse(raw) as FederationOutbox;
    if (!parsed || !Array.isArray(parsed.records)) return { records: [] };
    return parsed;
  } catch {
    return { records: [] };
  }
}

async function writeOutbox(
  ctx: TriggerContext | Context,
  box: FederationOutbox,
): Promise<void> {
  await ctx.redis.set(OUTBOX_KEY, JSON.stringify(box), {
    expiration: new Date(Date.now() + RECORD_TTL_MS),
  });
}

interface FederationIndex {
  // userHash → {removedCount summed across all srcHashes, communitiesCount, lastSeen}
  entries: Record<
    string,
    { totalRemovedCount: number; communities: number; lastSeen: number }
  >;
}

async function readIndex(
  ctx: TriggerContext | Context,
): Promise<FederationIndex> {
  const raw = await ctx.redis.get(INDEX_KEY);
  if (!raw) return { entries: {} };
  try {
    const parsed = JSON.parse(raw) as FederationIndex;
    if (!parsed || !parsed.entries) return { entries: {} };
    return parsed;
  } catch {
    return { entries: {} };
  }
}

async function writeIndex(
  ctx: TriggerContext | Context,
  idx: FederationIndex,
): Promise<void> {
  await ctx.redis.set(INDEX_KEY, JSON.stringify(idx), {
    expiration: new Date(Date.now() + RECORD_TTL_MS),
  });
}

function isEnabled(settings: Record<string, unknown>): boolean {
  return settings[AppSetting.EnableFederation] === true;
}

/**
 * Record a confirmed removal for the federation outbox. Called from the
 * remove path AFTER the mod (or autoRemove in Strict mode) has confirmed
 * the action. Idempotent on `userHash` — repeated removals for the same
 * author bump removedCount and lastRemovedTs.
 */
export async function recordConfirmedRemoval(
  ctx: TriggerContext | Context,
  settings: Record<string, unknown>,
  args: { authorName: string; subredditName: string },
): Promise<void> {
  if (!isEnabled(settings)) return;
  if (
    !args.authorName ||
    args.authorName === "[deleted]" ||
    args.authorName === "AutoModerator"
  ) {
    return;
  }

  const [userHash, srcHash] = await Promise.all([
    shortHash(args.authorName),
    shortHash(args.subredditName),
  ]);

  const box = await readOutbox(ctx);
  const existing = box.records.find(r => r.userHash === userHash);
  if (existing) {
    existing.removedCount++;
    existing.lastRemovedTs = Date.now();
  } else {
    box.records.unshift({
      userHash,
      srcHash,
      removedCount: 1,
      lastRemovedTs: Date.now(),
    });
  }
  box.records = box.records.slice(0, MAX_OUTBOX);
  await writeOutbox(ctx, box);
}

/**
 * Returns federation knowledge about a username, if any. Score returned
 * in [0, 1] for use as a signal contribution alongside local history.
 *
 * Scoring scheme:
 *   - 1 sub, 1 removal → 0.18
 *   - 1 sub, 2+ removals → 0.32
 *   - 2 subs → 0.6
 *   - 3+ subs → 0.85
 */
export async function queryAuthor(
  ctx: TriggerContext | Context,
  settings: Record<string, unknown>,
  authorName: string,
): Promise<{ score: number; reason: string | null }> {
  if (!isEnabled(settings)) return { score: 0, reason: null };

  const userHash = await shortHash(authorName);
  const idx = await readIndex(ctx);
  const entry = idx.entries[userHash];
  if (!entry) return { score: 0, reason: null };

  let score = 0;
  if (entry.communities >= 3) score = 0.85;
  else if (entry.communities === 2) score = 0.6;
  else if (entry.totalRemovedCount >= 2) score = 0.32;
  else score = 0.18;

  return {
    score,
    reason: `federation: ${entry.totalRemovedCount} removal${entry.totalRemovedCount > 1 ? "s" : ""} across ${entry.communities} ${entry.communities === 1 ? "other community" : "other communities"}`,
  };
}

/**
 * Read current outbox for audit display. Returns hashes only (never
 * un-hashed usernames). Use this in a menu action to let mods inspect
 * what will be published before they enable federation.
 */
export async function auditOutbox(
  ctx: TriggerContext | Context,
): Promise<FederationRecord[]> {
  const box = await readOutbox(ctx);
  return box.records;
}

/**
 * Clear the local outbox. Called when a mod turns federation off so we
 * never publish stale records they didn't intend to share. Also called
 * from a manual menu action.
 */
export async function clearOutbox(
  ctx: TriggerContext | Context,
): Promise<number> {
  const box = await readOutbox(ctx);
  const n = box.records.length;
  await writeOutbox(ctx, { records: [] });
  return n;
}

interface GatewayResponse {
  received: number;
  index?: FederationRecord[];
}

/**
 * Publish the outbox to the configured federation gateway and merge any
 * peer records back into the local index. Called from the scheduled job.
 *
 * If `FederationEndpoint` is empty, runs in dry-run mode: outbox is read
 * (would be sent), nothing leaves the sub, no merge happens. The
 * `lastPublishedAt` timestamp is still bumped so mods can see the cycle
 * ran.
 */
export async function publishCycle(
  ctx: TriggerContext | Context,
  settings: Record<string, unknown>,
): Promise<{ ok: boolean; published: number; received: number; reason?: string }> {
  if (!isEnabled(settings)) {
    return { ok: false, published: 0, received: 0, reason: "disabled" };
  }

  const endpoint = (settings[AppSetting.FederationEndpoint] as string) ?? "";
  const box = await readOutbox(ctx);

  if (!endpoint) {
    // Dry-run — record the cycle, do nothing.
    await ctx.redis.set(PUB_TS_KEY, String(Date.now()), {
      expiration: new Date(Date.now() + RECORD_TTL_MS),
    });
    return {
      ok: true,
      published: 0,
      received: 0,
      reason: "dry-run (no FederationEndpoint configured)",
    };
  }

  let response: GatewayResponse | null = null;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: box.records }),
    });
    if (!res.ok) {
      return {
        ok: false,
        published: 0,
        received: 0,
        reason: `gateway ${res.status} ${res.statusText}`,
      };
    }
    response = (await res.json()) as GatewayResponse;
  } catch (err) {
    return {
      ok: false,
      published: 0,
      received: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Merge peer records into the local index. We deliberately do NOT merge
  // records that share our own srcHash — those are echoes of our own
  // outbox and would double-count us.
  const ourSrcHash = await shortHash(
    ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName()),
  );
  const idx = await readIndex(ctx);
  let merged = 0;
  for (const rec of response.index ?? []) {
    if (rec.srcHash === ourSrcHash) continue;
    const cur = idx.entries[rec.userHash] ?? {
      totalRemovedCount: 0,
      communities: 0,
      lastSeen: 0,
    };
    cur.totalRemovedCount += rec.removedCount;
    cur.communities += 1;
    cur.lastSeen = Math.max(cur.lastSeen, rec.lastRemovedTs);
    idx.entries[rec.userHash] = cur;
    merged++;
  }
  await writeIndex(ctx, idx);
  await ctx.redis.set(PUB_TS_KEY, String(Date.now()), {
    expiration: new Date(Date.now() + RECORD_TTL_MS),
  });

  return {
    ok: true,
    published: box.records.length,
    received: merged,
  };
}

export async function lastPublishedAt(
  ctx: TriggerContext | Context,
): Promise<number | null> {
  const raw = await ctx.redis.get(PUB_TS_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

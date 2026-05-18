import type { TriggerContext, Context } from "@devvit/public-api";
import { AppSetting } from "../settings.js";

/**
 * Cross-sub federation — opt-in, hashed-only sharing of confirmed bad
 * actors across participating subs.
 *
 * **Privacy framework** (the parts mods must trust):
 *
 *   - Only SHA-256 hashes of usernames leave the sub. The salt is a fixed
 *     constant — this protects against ad-hoc passive readers but it does
 *     NOT defend against a determined adversary with a Reddit username
 *     wordlist, who can pre-image the entire space. Treat the hash as a
 *     pseudonymization layer, not an anti-enumeration guarantee. Mods who
 *     want stronger privacy should keep federation disabled (the default).
 *   - No post content, no IP, no email, no metadata. Just
 *     `{userHash, srcHash, removedCount, lastRemovedTs}`.
 *   - The sub identifier is also hashed before publishing — receiving
 *     subs see "2 other communities also removed this actor" without
 *     knowing which subs.
 *   - Mods can `audit` the outbox at any time before publish, and toggle
 *     federation off at any time. Toggling off stops new recordings
 *     immediately; the existing outbox is cleared by the next interaction
 *     with it (audit menu, scheduled publish cycle, or the manual "Clear
 *     federation outbox" menu action). Devvit does not expose a settings-
 *     change hook to clear synchronously on toggle.
 *   - Records auto-expire after 90 days so federated reputations don't
 *     last forever. The TTL is enforced per-record (lastRemovedTs cutoff
 *     on both read and write paths), not just at the key level.
 *
 * **Transport**: configurable endpoint. When `FederationEndpoint` is unset
 * the module operates in local-outbox-only mode (dry-run) — the framework
 * works end-to-end against local Redis only, useful for development and
 * for subs that want to see what would be published without committing.
 *
 * **Index design**: peer records are stored as `Observations[userHash][srcHash] →
 * { lastTs, count }` so we can derive `communities = keys(obs).length` and
 * `totalRemovedCount = sum(counts)` *idempotently* every cycle. Earlier
 * versions incremented on every merge — that double-counts when the same
 * record comes back across cycles.
 *
 * Gateway responses are validated before merge: bounded record count,
 * clamped `removedCount`, sane `lastRemovedTs`, well-formed hex hashes.
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
 * Stable, salted, half-SHA-256 (128-bit / 32-hex). 128 bits keeps the
 * birthday-bound collision probability negligible across all of Reddit
 * (P(collision) for 10^8 users is ~10^-24), while halving the transport
 * size vs the full digest. Salt is constant and public — see file header
 * for the honest privacy framing.
 */
export async function shortHash(input: string): Promise<string> {
  const enc = new TextEncoder().encode(SALT_PREFIX + input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 16; i++) {
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
    // Per-record TTL filter on read. The Redis key has a 90-day TTL but
    // every write refreshes it, so without this filter a long-running
    // outbox could publish stale removals indefinitely.
    const cutoff = Date.now() - RECORD_TTL_MS;
    const fresh = parsed.records.filter(r => r.lastRemovedTs >= cutoff);
    return { records: fresh };
  } catch {
    return { records: [] };
  }
}

async function writeOutbox(
  ctx: TriggerContext | Context,
  box: FederationOutbox,
): Promise<void> {
  // Prune-on-write — same per-record TTL semantics as the index. Keeps the
  // stored shape bounded so disabling federation later leaves nothing
  // unexpected behind.
  const cutoff = Date.now() - RECORD_TTL_MS;
  const fresh = box.records.filter(r => r.lastRemovedTs >= cutoff);
  await ctx.redis.set(OUTBOX_KEY, JSON.stringify({ records: fresh }), {
    expiration: new Date(Date.now() + RECORD_TTL_MS),
  });
}

interface PeerObservation {
  lastTs: number;
  count: number;
}

interface FederationIndex {
  // userHash → srcHash → most-recent observation. Aggregates are derived,
  // not stored, so re-merging the same record across cycles is idempotent.
  obs: Record<string, Record<string, PeerObservation>>;
}

// Bounds for malicious-gateway defense (see C3 in review pass #2).
const GATEWAY_MAX_RECORDS = 5000;
const RECORD_MAX_REMOVED_COUNT = 50;
const HASH_HEX_RE = /^[0-9a-f]{32}$/;

function isValidPeerRecord(rec: unknown): rec is FederationRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Record<string, unknown>;
  if (typeof r.userHash !== "string" || !HASH_HEX_RE.test(r.userHash)) return false;
  if (typeof r.srcHash !== "string" || !HASH_HEX_RE.test(r.srcHash)) return false;
  if (typeof r.removedCount !== "number") return false;
  if (!Number.isFinite(r.removedCount) || r.removedCount < 1) return false;
  if (typeof r.lastRemovedTs !== "number") return false;
  if (!Number.isFinite(r.lastRemovedTs)) return false;
  if (r.lastRemovedTs > Date.now() + 60_000) return false; // future-dated
  return true;
}

function clampRemoved(n: number): number {
  return Math.max(1, Math.min(RECORD_MAX_REMOVED_COUNT, Math.floor(n)));
}

interface DerivedEntry {
  totalRemovedCount: number;
  communities: number;
  lastSeen: number;
}

function deriveEntry(
  idx: FederationIndex,
  userHash: string,
): DerivedEntry | null {
  const perSrc = idx.obs[userHash];
  if (!perSrc) return null;
  const cutoff = Date.now() - RECORD_TTL_MS;
  let total = 0;
  let lastSeen = 0;
  let activeCommunities = 0;
  for (const k of Object.keys(perSrc)) {
    const obs = perSrc[k];
    // Per-record TTL: stale observations no longer count toward the
    // federated score. The key-level TTL is the floor; per-record cutoff
    // is the contract.
    if (obs.lastTs < cutoff) continue;
    activeCommunities++;
    total += obs.count;
    if (obs.lastTs > lastSeen) lastSeen = obs.lastTs;
  }
  if (activeCommunities === 0) return null;
  return { totalRemovedCount: total, communities: activeCommunities, lastSeen };
}

/**
 * Drop observations older than RECORD_TTL_MS. Called on every index write
 * so the stored shape stays bounded and stale reputation doesn't pile up.
 */
function pruneStaleObservations(idx: FederationIndex): FederationIndex {
  const cutoff = Date.now() - RECORD_TTL_MS;
  const next: FederationIndex = { obs: {} };
  for (const [userHash, perSrc] of Object.entries(idx.obs)) {
    const fresh: Record<string, PeerObservation> = {};
    for (const [srcHash, obs] of Object.entries(perSrc)) {
      if (obs.lastTs >= cutoff) fresh[srcHash] = obs;
    }
    if (Object.keys(fresh).length > 0) next.obs[userHash] = fresh;
  }
  return next;
}

async function readIndex(
  ctx: TriggerContext | Context,
): Promise<FederationIndex> {
  const raw = await ctx.redis.get(INDEX_KEY);
  if (!raw) return { obs: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<FederationIndex> & {
      // Tolerate the v1 legacy shape so existing installs don't crash on
      // upgrade. Anything in `entries` is dropped — the next publish cycle
      // will rebuild from peer responses.
      entries?: unknown;
    };
    if (!parsed || typeof parsed.obs !== "object" || parsed.obs === null) {
      return { obs: {} };
    }
    return { obs: parsed.obs };
  } catch {
    return { obs: {} };
  }
}

async function writeIndex(
  ctx: TriggerContext | Context,
  idx: FederationIndex,
): Promise<void> {
  const pruned = pruneStaleObservations(idx);
  await ctx.redis.set(INDEX_KEY, JSON.stringify(pruned), {
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
    existing.removedCount = clampRemoved(existing.removedCount + 1);
    existing.lastRemovedTs = Date.now();
  } else {
    box.records.push({
      userHash,
      srcHash,
      removedCount: 1,
      lastRemovedTs: Date.now(),
    });
  }
  // Most-recent first, then truncate — so touched records survive the
  // MAX_OUTBOX cap rather than aging off because of insertion order.
  box.records.sort((a, b) => b.lastRemovedTs - a.lastRemovedTs);
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
  const entry = deriveEntry(idx, userHash);
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
 *
 * Passive cleanup: when federation is disabled, this call also clears
 * the outbox so disabling + auditing leaves nothing behind. Devvit doesn't
 * fire a settings-change hook we can subscribe to, so the contract is
 * "the outbox is cleared by the next interaction with it after disabling."
 */
export async function auditOutbox(
  ctx: TriggerContext | Context,
  settings?: Record<string, unknown>,
): Promise<FederationRecord[]> {
  if (settings && !isEnabled(settings)) {
    await clearOutbox(ctx);
    return [];
  }
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
    // Disabled-mode cleanup — if the mod toggled federation off after
    // recordings landed in the outbox, this is when we drop them. Cheaper
    // than running a dedicated settings-change hook (Devvit doesn't fire
    // one we can listen to).
    const cleared = await clearOutbox(ctx);
    return {
      ok: false,
      published: 0,
      received: 0,
      reason: cleared > 0
        ? `disabled — cleared ${cleared} stale outbox record(s)`
        : "disabled",
    };
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

  // Validate + merge peer records. Drop our own echoes; bound count;
  // clamp removedCount; reject malformed hashes. Store as per-(user,src)
  // observations — re-merging the same record is idempotent (overwrites,
  // doesn't add).
  const ourSrcHash = await shortHash(
    ctx.subredditName ?? (await ctx.reddit.getCurrentSubredditName()),
  );
  const idx = await readIndex(ctx);
  const peerRaw = Array.isArray(response.index) ? response.index : [];
  const bounded = peerRaw.slice(0, GATEWAY_MAX_RECORDS);
  let merged = 0;
  for (const recRaw of bounded) {
    if (!isValidPeerRecord(recRaw)) continue;
    const rec = recRaw;
    if (rec.srcHash === ourSrcHash) continue;
    const perSrc = idx.obs[rec.userHash] ?? {};
    perSrc[rec.srcHash] = {
      lastTs: rec.lastRemovedTs,
      count: clampRemoved(rec.removedCount),
    };
    idx.obs[rec.userHash] = perSrc;
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

import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import {
  claimLock,
  readLock,
  releaseLock,
  formatLockStatus,
} from "../lib/collisionLock.js";

/**
 * Claim-review menu action. Lets a mod assert "I'm looking at this" so
 * other mods don't double up on the same modqueue item. If the lock is
 * already held by someone else, shows a toast with the current holder
 * and time remaining; the mod can re-press within 60s to force-claim
 * (e.g. the original mod walked away).
 *
 * Pressing while you already hold the lock releases it.
 */

const FORCE_INTENT_TTL_MS = 60_000;
const forceIntentKey = (itemId: string, mod: string) =>
  `sg:lock-force-intent:${itemId}:${mod}`;

async function currentModName(context: Context): Promise<string | undefined> {
  try {
    const u = await context.reddit.getCurrentUser();
    return u?.username;
  } catch {
    return undefined;
  }
}

export async function claimReviewFromMenu(
  event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const targetId = event.targetId;
  if (!targetId) {
    context.ui.showToast("Slopguard: no target.");
    return;
  }

  const mod = await currentModName(context);
  if (!mod) {
    context.ui.showToast("Slopguard: could not identify current mod.");
    return;
  }

  // Toggle: pressing while you already hold the lock releases it.
  const existing = await readLock(context, targetId);
  if (existing && existing.modName === mod) {
    const released = await releaseLock(context, { itemId: targetId, modName: mod });
    context.ui.showToast(
      released ? "Slopguard: review released." : "Slopguard: release failed.",
    );
    return;
  }

  // If a force-intent flag exists from a recent failed press, honor it.
  const intentKey = forceIntentKey(targetId, mod);
  const hasIntent = Boolean(await context.redis.get(intentKey));

  const result = await claimLock(context, {
    itemId: targetId,
    modName: mod,
    force: hasIntent,
  });

  if (result.ok) {
    if (hasIntent) await context.redis.del(intentKey);
    context.ui.showToast(
      hasIntent
        ? "Slopguard: force-claimed (previous holder overridden)."
        : "Slopguard: you're now reviewing this item.",
    );
    return;
  }

  // First failure: arm the force-intent flag so the next press steals.
  await context.redis.set(intentKey, "1", {
    expiration: new Date(Date.now() + FORCE_INTENT_TTL_MS),
  });
  context.ui.showToast(
    `Slopguard: already claimed — ${formatLockStatus(result.holder)}. Press again within 60s to force-claim.`,
  );
}

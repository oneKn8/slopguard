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
 * and time remaining; the mod can re-press to force-claim if needed
 * (e.g. the original mod walked away).
 *
 * Pressing while you already hold the lock releases it.
 */

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

  const existing = await readLock(context, targetId);

  // Toggle: pressing while you already hold the lock releases it.
  if (existing && existing.modName === mod) {
    const released = await releaseLock(context, { itemId: targetId, modName: mod });
    context.ui.showToast(
      released ? "Slopguard: review released." : "Slopguard: release failed.",
    );
    return;
  }

  const result = await claimLock(context, {
    itemId: targetId,
    modName: mod,
  });

  if (result.ok) {
    context.ui.showToast(`Slopguard: you're now reviewing this item.`);
    return;
  }

  context.ui.showToast(
    `Slopguard: already claimed — ${formatLockStatus(result.holder)}.`,
  );
}

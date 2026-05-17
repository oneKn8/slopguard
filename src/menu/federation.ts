import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import {
  auditOutbox,
  clearOutbox,
  publishCycle,
  lastPublishedAt,
} from "../lib/federation.js";

/**
 * Mod-only menu actions for inspecting and managing the federation outbox.
 */

export async function auditFederationFromMenu(
  _event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const settings = await context.settings.getAll();
  const records = await auditOutbox(
    context,
    settings as Record<string, unknown>,
  );
  const lastPub = await lastPublishedAt(context);

  const lines: string[] = [];
  lines.push(`Federation outbox audit — ${records.length} records`);
  if (lastPub) {
    const ago = Math.floor((Date.now() - lastPub) / 60000);
    lines.push(`Last published: ${ago}m ago`);
  } else {
    lines.push(`Last published: never`);
  }
  lines.push("");
  for (const r of records.slice(0, 25)) {
    const ago = Math.floor((Date.now() - r.lastRemovedTs) / 60000);
    lines.push(
      `  ${r.userHash} (${r.removedCount}x, ${ago}m ago) src=${r.srcHash}`,
    );
  }
  if (records.length > 25) {
    lines.push(`  …and ${records.length - 25} more`);
  }
  console.log(lines.join("\n"));
  context.ui.showToast(
    `Slopguard: ${records.length} federation records (details in logs). Enabled: ${settings["enableFederation"] === true}.`,
  );
}

export async function clearFederationOutboxFromMenu(
  _event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const n = await clearOutbox(context);
  context.ui.showToast(`Slopguard: cleared ${n} federation records.`);
}

export async function publishFederationNowFromMenu(
  _event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const settings = await context.settings.getAll();
  const res = await publishCycle(context, settings as Record<string, unknown>);
  if (!res.ok) {
    context.ui.showToast(`Slopguard: publish failed — ${res.reason}`);
    return;
  }
  context.ui.showToast(
    `Slopguard: published ${res.published}, received ${res.received}${res.reason ? ` (${res.reason})` : ""}.`,
  );
}

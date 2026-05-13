import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";
import { getDailyMetrics, getDailySpend, today } from "../redis.js";

export async function showMetricsFromMenu(
  _event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  const metrics = await getDailyMetrics(context);
  const spend = await getDailySpend(context);
  const date = today();

  if (!metrics) {
    context.ui.showToast(`Slopguard ${date}: no activity yet today.`);
    return;
  }

  const summary = [
    `Slopguard daily summary (${date}):`,
    `- Items scored: ${metrics.itemsScored}`,
    `- Flagged: ${metrics.flagged}`,
    `- Auto-removed: ${metrics.autoRemoved}`,
    `- Manually removed: ${metrics.manualRemoved}`,
    `- Time saved (est): ${metrics.estimatedTimeSavedMinutes} min`,
    `- Spend today: $${spend.toFixed(4)}`,
  ].join("\n");

  console.log(summary);
  context.ui.showToast(
    `${metrics.flagged} flagged, ${metrics.autoRemoved + metrics.manualRemoved} removed today. Full details in logs.`,
  );
}

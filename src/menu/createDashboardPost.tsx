import { Devvit } from "@devvit/public-api";
import type { Context, MenuItemOnPressEvent } from "@devvit/public-api";

/**
 * Mod-only menu action that submits a "Slopguard Dashboard" custom post in
 * the current sub. Mods typically sticky-pin this once so they can glance
 * at recent flags without leaving the feed.
 */
export async function createDashboardPostFromMenu(
  _event: MenuItemOnPressEvent,
  context: Context,
): Promise<void> {
  try {
    const subredditName =
      context.subredditName ?? (await context.reddit.getCurrentSubredditName());
    const post = await context.reddit.submitPost({
      subredditName,
      title: "Slopguard — recent flags",
      preview: (
        <vstack padding="medium">
          <text>Slopguard dashboard loading…</text>
        </vstack>
      ),
    });
    context.ui.showToast(`Slopguard: dashboard post created (${post.id}).`);
  } catch (err) {
    context.ui.showToast(
      `Slopguard: failed to create dashboard — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

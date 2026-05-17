import { Devvit, useAsync, useState } from "@devvit/public-api";
import { readFlaggedQueue } from "./queue.js";
import type { EnsembleScore } from "../types.js";

/**
 * Slopguard live dashboard — a Devvit custom post that mods install at
 * the top of their sub (sticky-pin). Renders the recent flagged queue
 * with score badges, top reasons, and a tap-through to the item.
 *
 * Re-fetches on demand via the Refresh button so we don't have to set up
 * a separate scheduler-driven refresh loop. The underlying queue is
 * updated by the create-triggers on every first-flag event.
 */

const CONFIDENCE_COLOR: Record<EnsembleScore["confidence"], string> = {
  high: "#d62728",
  medium: "#ff7f0e",
  low: "#888888",
};

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtAgo(ts: number): string {
  const ms = Date.now() - ts;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function ScoreCard({ score }: { score: EnsembleScore }): JSX.Element {
  const color = CONFIDENCE_COLOR[score.confidence];
  const reasons = (score.topReasons ?? score.localSignals?.topReasons ?? []).slice(0, 3);
  return (
    <vstack
      padding="small"
      gap="small"
      border="thin"
      borderColor="neutral-border-weak"
      cornerRadius="small"
    >
      <hstack gap="small" alignment="middle">
        <text size="large" weight="bold" color={color}>
          {fmtPct(score.finalScore)}
        </text>
        <text size="small" color="neutral-content-weak">
          {score.confidence}
        </text>
        <spacer grow />
        <text size="small" color="neutral-content-weak">
          {score.itemType} · u/{score.authorName} · {fmtAgo(score.scoredAt)}
        </text>
      </hstack>
      {reasons.length > 0 && (
        <vstack gap="none">
          {reasons.map(r => (
            <text size="small" wrap>
              • {r}
            </text>
          ))}
        </vstack>
      )}
      <hstack gap="small">
        <text size="xsmall" color="neutral-content-weak">
          source: {score.source}
        </text>
        {score.localScore !== undefined && (
          <text size="xsmall" color="neutral-content-weak">
            · local {fmtPct(score.localScore)}
          </text>
        )}
        {score.llmScore !== undefined && (
          <text size="xsmall" color="neutral-content-weak">
            · llm {fmtPct(score.llmScore)}
          </text>
        )}
      </hstack>
    </vstack>
  );
}

function Header({
  total,
  onRefresh,
}: {
  total: number;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <hstack
      padding="small"
      gap="small"
      alignment="middle"
      backgroundColor="neutral-background"
    >
      <text size="xlarge" weight="bold">
        Slopguard
      </text>
      <text size="medium" color="neutral-content-weak">
        recent flags
      </text>
      <spacer grow />
      <text size="small" color="neutral-content-weak">
        {total} flagged
      </text>
      <button size="small" appearance="secondary" onPress={onRefresh}>
        Refresh
      </button>
    </hstack>
  );
}

export const SlopguardDashboard = Devvit.createElement;

export function registerDashboard(): void {
  Devvit.addCustomPostType({
    name: "Slopguard Dashboard",
    description: "Live queue of recent Slopguard flags for this sub.",
    render: context => {
      const [refreshKey, setRefreshKey] = useState(0);
      // Devvit's useAsync constrains return type to JSONValue. EnsembleScore
      // is plain JSON-serializable, but its interface doesn't include the
      // explicit string-index signature TS demands, so we round-trip through
      // JSON.parse(JSON.stringify(...)) and cast on use.
      const { data, loading } = useAsync(
        async () => {
          // Cap at 15 visible entries — keeps the dashboard cheap to render
          // and keeps Refresh from doing more Redis round-trips than the
          // viewer can see at once.
          const list = await readFlaggedQueue(context, 15);
          return JSON.parse(JSON.stringify(list));
        },
        { depends: [refreshKey] },
      );

      if (loading) {
        return (
          <vstack padding="medium">
            <text>Loading recent flags…</text>
          </vstack>
        );
      }

      const list = (data ?? []) as EnsembleScore[];

      return (
        <vstack gap="small" padding="small" height={100} width={100}>
          <Header total={list.length} onRefresh={() => setRefreshKey(k => k + 1)} />
          {list.length === 0 ? (
            <vstack padding="medium" gap="small">
              <text size="medium">No flagged items yet.</text>
              <text size="small" color="neutral-content-weak" wrap>
                When Slopguard flags a post or comment, it'll appear here with
                its score, top reasons, and per-signal breakdown. Use the
                Slopguard menu actions on the underlying item to act.
              </text>
            </vstack>
          ) : (
            <vstack gap="small">
              {/* Devvit Blocks doesn't expose a key prop on components, so
                  we rely on a stable order (queue is already sorted
                  most-recent-first) for predictable reconciliation. */}
              {list.map(s => (
                <ScoreCard score={s} />
              ))}
            </vstack>
          )}
        </vstack>
      );
    },
  });
}

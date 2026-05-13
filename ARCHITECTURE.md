# Slopguard Architecture

## Stack

- **Devvit Classic** (NOT Devvit Web/bolt) — matches fsvreddit's image-moderator pattern, proven for external-API mod tools
- **TypeScript** + `@devvit/public-api`
- **No build system overhead** — Devvit handles bundling. No Vite/Webpack/React/Express.
- **Detection modules** = pluggable, mirrors image-moderator's `src/detections/` pattern

## Project layout

```
slopguard/
├── devvit.yaml              # app name
├── package.json             # deps: @devvit/public-api, @devvit/protos
├── tsconfig.json            # extends @devvit/public-api/devvit.tsconfig.json
├── .gitignore
├── README.md                # GitHub-facing
├── LICENSE                  # MIT
├── src/
│   ├── main.ts              # entry — registers settings, triggers, menus, forms, scheduler
│   ├── settings.ts          # app settings schema (thresholds, API keys, behavior)
│   ├── types.ts             # shared TypeScript types
│   ├── redis.ts             # Redis key conventions + helpers
│   │
│   ├── ensemble/
│   │   ├── index.ts         # ensemble orchestrator
│   │   ├── gemini.ts        # Gemini Flash provider
│   │   ├── claude.ts        # Claude Haiku provider
│   │   ├── openai.ts        # GPT-4o-mini provider
│   │   └── scoring.ts       # ensemble fusion + disagreement signals
│   │
│   ├── detections/
│   │   ├── textAI.ts        # ensemble call on post/comment body
│   │   ├── imageAI.ts       # vision-model classification for image posts
│   │   └── ocrText.ts       # OCR pass on images then text AI check
│   │
│   ├── triggers/
│   │   ├── onPostCreate.ts  # PostSubmit / PostCreate handler
│   │   ├── onCommentCreate.ts
│   │   ├── onPostReport.ts
│   │   └── onModAction.ts   # learn from mod overrides (later)
│   │
│   ├── menu/
│   │   ├── explainScore.ts  # "Explain AI score" — show modal w/ reasoning
│   │   ├── removeAsAI.ts    # "Remove as AI slop" — one-click full action
│   │   └── setApiKey.ts     # mod-only menu to set API keys
│   │
│   ├── customPost/
│   │   ├── badgeOverlay.tsx # Devvit Blocks: score badge UI (mod-visible)
│   │   ├── explainModal.tsx # detailed breakdown modal
│   │   └── metricsPost.tsx  # daily-metrics custom post UI
│   │
│   ├── modmail/
│   │   └── appealClassifier.ts # V2: classify ban appeals + draft response
│   │
│   ├── scheduler/
│   │   └── dailyMetrics.ts  # cron: post daily metrics to mod-only sticky
│   │
│   ├── realtime/
│   │   └── collisionLock.ts # V4: live mod-collision warning via pubsub
│   │
│   └── lib/
│       ├── modActions.ts    # wrapper for remove + reason + reply + modnote chain
│       ├── userHistory.ts   # fetch + summarize user's prior AI-flagged content
│       └── cost.ts          # token + spend caps + per-day quota
```

## Data model (Redis)

Per-installation, namespaced keys:

```
sg:score:{postId|commentId}        → JSON { score, models, reasoning, ts }
sg:scoreList                       → sorted set by ts for recent scores (window for metrics)
sg:user:{username}:flagCount       → counter of confirmed-AI items by this user
sg:user:{username}:history         → list of {postId, score, action, ts}
sg:metrics:daily:{YYYY-MM-DD}      → JSON { flagged, autoRemoved, manualRemoved, timeSavedMin }
sg:lock:{postId}                   → hash { modUsername, lockedAt } for collision warning
sg:settings:thresholds             → JSON cached settings
```

## External API allowlist (devvit.yaml http)

```yaml
http:
  - https://generativelanguage.googleapis.com  # Gemini
  - https://api.anthropic.com                   # Claude
  - https://api.openai.com                      # GPT
```

## Triggers

| Event | Handler | Purpose |
|---|---|---|
| `PostCreate` | `onPostCreate` | Score text + image, store in Redis, optionally action |
| `CommentSubmit` | `onCommentCreate` | Score comment body, store + optional action |
| `PostReport` | `onPostReport` | Re-score with higher cost budget (mods report = signal) |
| `ModAction` | `onModAction` | Learn (V4): if mod manually removes AI-scored item, increment user flagCount |
| `AppInstall` | `onInstall` | Welcome message, initial config |
| `AppUpgrade` | `onUpgrade` | Schema migrations |

## Menu items

| Location | Label | For | Behavior |
|---|---|---|---|
| subreddit | "Slopguard: Set API Keys" | moderator | Open form to enter Gemini/Anthropic/OpenAI keys |
| subreddit | "Slopguard: Pin Daily Metrics" | moderator | Schedule + pin daily-metrics post |
| post | "Slopguard: Explain AI score" | moderator | Show modal w/ per-model reasoning |
| post | "Slopguard: Remove as AI slop" | moderator | Remove + reason + reply + modnote |
| comment | "Slopguard: Explain AI score" | moderator | Same as post |
| comment | "Slopguard: Remove as AI slop" | moderator | Same |

## Settings (mod-tunable)

- **API keys** (secret, per-installation) — Gemini, Anthropic, OpenAI
- **Score thresholds** — flag-only (default 0.6), auto-remove (default off, can set to 0.9+)
- **Daily spend cap** — USD limit on LLM calls per day
- **Models to use** — checkbox list to enable/disable individual providers
- **Removal reason template** — text + placeholders ({{score}}, {{model}}, {{reason}})
- **Modmail reply template** — for users whose post got removed as AI
- **Ignore approved users** — skip scoring users in approved-submitter list
- **Min karma threshold** — only score users below X karma (cost saver)
- **Metrics post schedule** — daily / weekly / off; time-of-day
- **Cross-sub federation** — opt in to shared bad-actor list (V3)

## Ensemble scoring algorithm

```
1. Skip if user is approved-submitter or above karma threshold (cost saver)
2. Call Gemini Flash (fast, cheap) → score₁, reasoning₁
3. If score₁ > 0.4 AND score₁ < 0.85 (uncertain band):
     escalate to Claude Haiku and GPT-4o-mini in parallel
     → score₂, reasoning₂, score₃, reasoning₃
4. Fuse:
     finalScore = weighted_average(scores, weights={gemini: 0.4, claude: 0.35, openai: 0.25})
     disagreement = std_dev(scores)
     if disagreement > 0.25: flag as "low confidence" but still surface
5. Store in Redis with reasoning from all queried models
6. If finalScore > threshold: emit Redis event for badge overlay + queue
7. If finalScore > auto_remove_threshold AND auto_remove enabled: take action
```

## Cost discipline (critical)

- **Gemini Flash only** for first pass = ~$0.0001 per check
- Escalation to Claude/GPT only on uncertain (~20% of items by historical AI-rate)
- Daily spend cap enforced in Redis counter; halts non-mandatory checks if exceeded
- Per-sub quota configurable; defaults: 1000 free checks/day per installation

## Feature phases (revisit)

### MVP (Phase 1)
- PostCreate + CommentSubmit triggers
- Gemini-only ensemble (Claude + GPT stub)
- Custom post badge overlay
- "Explain AI score" + "Remove as AI slop" menu items
- Settings UI
- API key entry form
- Redis storage

### Phase 2
- Claude + GPT integration → full ensemble
- Image AI detection (Gemini vision)
- Modmail appeal classifier
- User history overlay
- Daily metrics scheduler

### Phase 3
- OCR text-in-image
- Cross-sub federation
- Modnote integration for confirmed AI users

### Phase 4 (stretch)
- Live mod-collision prevention via realtime
- Per-sub model fine-tuning hints
- Learning from mod overrides

## Why this wins

1. **Built for the Feed** — score badge appears on the Reddit post itself, mod actions happen inline via menu, not in an external dashboard
2. **One mechanic, polished** — AI-content detection with multiple surfaces, not a kitchen-sink platform
3. **Multi-LLM ensemble = differentiated tech** — nobody else will ship this in 16 days
4. **Plays user's strengths** — Jarvis architecture transplanted, MCP-shipping experience visible
5. **Mobile works** — Devvit triggers + menu actions work in Reddit mobile app
6. **Speaks community language** — "slop" is the mods' own term
7. **Time-saved provable** — metrics post and impact statement quantify hours saved

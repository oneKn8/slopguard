# Slopguard

> AI-content detection for Reddit mod queues with explainable multi-LLM ensemble scoring.

![Slopguard banner placeholder](docs/banner.png)

## What it does

Slopguard auto-flags AI-generated submissions on your subreddit using a 3-model ensemble (Gemini, Claude, GPT) and surfaces a confidence score directly on the Reddit post — with one-click triage actions and an audit trail.

- **Multi-LLM ensemble** — three models cross-check each item; surfaces disagreement when they don't agree
- **Built for the feed** — score badge appears on the Reddit post itself (mod-only visible). No external dashboard.
- **One-click triage** — "Remove as AI slop" applies removal reason + reply + modnote in a single action
- **Image AI + OCR** — detects AI-generated images and text-in-images that AutoMod can't read
- **Mobile-friendly** — works in the Reddit mobile app where Toolbox doesn't
- **Time-saved metrics** — daily auto-pinned post showing what it caught and time saved
- **Mod collision warnings** — see when another mod is already reviewing an item
- **Zero config defaults** — works out of the box; every threshold tunable per sub

## Why this exists

In 2026, AI-generated content is mods' #1 reported pain. r/programming banned all AI-LLM content as triage. r/AmItheAsshole mods estimate 50% of posts are AI. AutoMod is regex-only — it cannot catch AI submissions. Slopguard fills that gap.

## Install

1. Visit [developers.reddit.com/apps/slopguard](https://developers.reddit.com/apps/slopguard)
2. Click Install → pick your subreddit
3. Open Settings → paste a Gemini API key (free tier: [Google AI Studio](https://aistudio.google.com/apikey))
4. Done. Defaults are flag-only (no auto-remove).

Optional: add Anthropic + OpenAI keys for full ensemble accuracy.

## Cost

- **Gemini Flash free tier**: ~1,500 free requests/day — enough for most small/medium subs at $0/month
- **Paid ensemble**: ~$0.0004 per item scored, with karma-threshold gating to cut volume ~50%
- **Per-sub spend cap** configurable in Settings

## Architecture

Multi-provider scoring with escalation:

```
PostCreate ──► Gemini Flash (always) ──► confident? ──► action / store
                       │
                       └─► uncertain? ──► Claude + GPT (parallel) ──► fuse + action
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for full details.

## Built for the Reddit Mod Tools & Migrated Apps Hackathon (2026)

Designed for the [Reddit Devvit hackathon](https://mod-tools-migration.devpost.com) closing 2026-05-27.

## Author

[Shifat Islam Santo](https://github.com/oneKn8), UTD CS '27 — [shifatsanto75 on Reddit](https://reddit.com/user/shifatsanto75)

## License

MIT — see [`LICENSE`](LICENSE).

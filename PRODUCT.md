# Slopguard — Product Definition

**Canonical product description, locked 2026-05-12.**

Source of truth for the README, Devpost submission, impact statement, mod outreach DMs, and the UTD GitHub issue. If anything elsewhere conflicts with this doc, this wins.

---

## One-line pitch

> Graduated-autopilot AI-content triage for Reddit mod queues — multi-signal scoring with confidence tiers, verify-author appeals, mod-collision prevention, and per-sub policy modes. Set thresholds once, walk away with confidence.

## What it is

Slopguard is a Devvit-native moderation tool that scores incoming posts and comments for AI-generated patterns using a combination of structural, behavioral, duplication, history, and (optionally) LLM signals. Instead of a single binary threshold, Slopguard routes items into graduated autopilot tiers so mods can set-and-forget without the false-positive risk of black-box detection.

| Confidence | Default action | Mod involvement |
|---|---|---|
| 92%+ | Auto-remove with audit log | None |
| 75–92% | Auto-modmail asking author to explain their process; post stays visible until reply | None (Slopguard reads the reply, escalates if it's another AI block) |
| 50–75% | Flag to mod queue with explainability panel | One click — approve / remove / lock |
| < 50% | Ignore | Not surfaced |

All thresholds and policy modes are per-sub configurable.

## What it solves

A documented, dated problem set with primary sources:

- **AI-content flood is mods' #1 reported pain in 2026.** r/programming temporarily banned LLM content as triage (April 2026, Tom's Hardware). One r/AmItheAsshole mod estimated up to 50% of submissions may be AI-generated or edited (WinBuzzer, Dec 2025).
- **74.5% of moderators experience modqueue collisions** under volume (Bajpai & Chandrasekharan, CHI 2026, n=110 mods, arxiv 2509.07314).
- **AI detectors have a 61.3% false-positive rate on non-native English** (Liang et al, Patterns 2023, Stanford HAI). Autopilot at a fixed threshold silently bans innocent users.
- **AutoMod is regex-only** — cannot detect AI submissions at all.
- **Toolbox is browser-only**, no mobile, no AI awareness, aging codebase.

## How it's different from Stop AI

Stop AI (developers.reddit.com/apps/stop-ai, 431 communities, v1.2.0) is the incumbent — academic detection algorithms (Binoculars, DetectGPT, GLTR, TypeTruth), one threshold, autopilot mode, gamification.

Slopguard is for mods who want autopilot WITHOUT the binary failure mode:

| | Stop AI | Slopguard |
|---|---|---|
| Method | 4 academic detection algorithms (statistical) | Multi-signal triage: structural + behavioral + duplication + history + optional multi-LLM ensemble |
| Threshold model | Fixed 50% binary | Graduated tiers (configurable per sub) |
| False positive handling | User reports via Reddit native | Verify-author modmail before removal — fair to non-native English / dyslexia / translation users |
| Explainability | Score from algorithm | Per-signal panel — flagged because: em-dash density 3.2/1k, 1-day account, dup hash, LLM 78% |
| Mod-collision prevention | None | Real-time lock — "u/X is reviewing this" badge |
| Per-sub policy modes | One mode (autopilot) | Three modes (Advisory / Verify / Strict) |
| Aesthetic | XP, ranks, badges | Professional mod tooling, no gamification |
| Open-source | Unknown | MIT |
| Stack | Detection-first | Workflow-first |

**Position:** Slopguard works standalone or alongside Stop AI as the workflow + fairness layer. Stop AI replaces mod judgment; Slopguard amplifies it.

## How it works (technical)

Five signal layers, all local-first (no HTTP/LLM required for MVP):

| Signal | What it measures | Cost |
|---|---|---|
| **Structural** | Em-dash density, formulaic phrase frequency, sentence-length burstiness, markdown heading patterns | Free, ~5ms |
| **Behavioral** | Account age, karma curve, cross-posting velocity, posting pattern | Free, ~10ms |
| **Duplication** | Text-hash match against prior submissions across the sub | Free, ~10ms |
| **History** | This user's prior flag count, prior confirmed-AI rate | Free, ~5ms |
| **LLM ensemble** (opt-in) | Gemini 2.5 Flash + Claude Haiku 4.5 + GPT-4o-mini, weighted fusion, disagreement signal | $0.0004/item, ~800ms |

Final score = weighted blend. LLM ensemble is opt-in escalation — Slopguard's MVP works fully without HTTP fetch approval, ships faster, no premium-feature review required. Mods enable LLM when they want max accuracy on uncertain cases.

**Cost discipline:** karma threshold gating, approved-user skip, account-age skip, daily spend cap, mod-skip. Gemini free tier covers most subs at $0/month.

## What you get as a mod

- Per-signal explainability on every flag — never a black box
- Verify-author workflow — auto-modmail asks the user to explain before removal (fair to non-native speakers; research-backed approach via AppealMod, arxiv 2301.07163)
- Real-time mod-collision lock — "u/X is reviewing this" prevents two mods acting on the same item
- Per-sub policy modes (Advisory / Verify / Strict) — sub rules drive enforcement style
- Daily metrics post — items scored, flagged, removed, time saved, API spend
- Modnote integration — confirmed AI users get notes for cross-mod consistency
- Mobile parity — works in Reddit's mobile app (Toolbox doesn't)
- Cross-sub federation (opt-in V2) — shared bad-actor list across participating subs

## Honesty stance (the thing competitors won't admit)

No AI detector is perfectly accurate. Stanford documented 61.3% false-positive rates on non-native English. Stop AI's autopilot at 50% threshold means real people get wrongly banned every day.

Slopguard is built around this reality:

- LLM ensemble is one signal among five, not the verdict
- Multi-model disagreement is surfaced explicitly — mods see the doubt
- Conservative defaults — auto-remove only at 92%+ confidence
- Verify-author safety net handles the 75–92% band fairly
- Prompts explicitly de-emphasize surface fluency so non-native English isn't penalized
- Mod judgment is the final authority for ambiguous cases

This is defensible to the most skeptical judge or mod — including non-native speakers who'd be Stop AI's silent false-positive victims.

## What Slopguard is NOT

- Not a verdict — mods decide; Slopguard is a triage signal with reasoning
- Not anti-AI dogma — per-sub policy determines action
- Not a black box — every score is explainable down to the signal level
- Not adversarial-proof — no detector is, and we don't pretend otherwise
- Not a replacement for human judgment — it scaffolds it, doesn't substitute

## Target prizes

- Best New Mod Tool ($10K) — differentiated tech (multi-signal triage, graduated autopilot, collision prevention)
- Moderators' Choice ($10K) — fair, explainable, mod-respecting design wins mod testimonials
- Honorable Mention ($1K) — fallback for build quality alone
- Reddit Developer Funds 2026 — passive tail revenue at 250+ qualified installs in 200+ member subs

## Author

Shifat Islam Santo, UTD CS '27 — github.com/oneKn8, u/shifatsanto75

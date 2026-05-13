# Slopguard — Product Definition

**Canonical product description, locked 2026-05-12 (v2 — fact-check pass complete).**

Source of truth for the README, Devpost submission, impact statement, mod outreach DMs, and the UTD GitHub issue. If anything elsewhere conflicts with this doc, this wins.

---

## One-line pitch

> **Slopguard is an explainable triage layer for Reddit mods — surfacing likely synthetic content, spam, scams, and coordinated inauthentic behavior with multi-signal scoring, confidence-based review tiers, verify-author appeals, and mod-collision prevention. Human judgment is preserved by default.**

## The wedge

> **Stop AI asks: "Is this AI?"**
> **Slopguard asks: "What should mods do with this suspicious item, and how do we handle it fairly?"**

That's the whole product.

## What it is

Slopguard is a Devvit-native moderation tool that scores incoming posts and comments for synthetic-content and low-quality-submission patterns using a combination of structural, behavioral, promo/contact-leak, duplication, history, and (optionally) LLM signals. It covers AI-generated content, karma-farm spam, affiliate/promo accounts, scam patterns, and dupe-content bots — all from the same multi-signal architecture. Instead of a single binary threshold, Slopguard routes items into confidence tiers so mods configure their sub's policy once and only see the cases that need their attention.

| Confidence | Default action (Advisory mode) | If Strict mode is enabled |
|---|---|---|
| 92%+ | Surface to mod queue marked "high confidence" with full explainability | Auto-filter or remove (mod-configured) |
| 75–92% | Verify-author workflow: auto-modmail asks author to explain, reply attached to review card | Same |
| 50–75% | Flag to mod queue with explainability panel | Same |
| < 50% | Ignore (not surfaced) | Same |

All thresholds and policy modes are per-sub configurable. **Default mode is Advisory** — Slopguard never removes anything by itself unless the mod team explicitly opts into Strict mode. Configure once, surface only what needs attention.

## What it solves

A documented, dated problem set with primary sources:

- **AI-generated content is a fast-growing moderation pain in 2026.** r/programming temporarily banned LLM content as triage (April 2026, Tom's Hardware). One r/AmItheAsshole moderator estimated up to 50% of submissions may be AI-generated or edited (WinBuzzer, December 2025).
- **74.5% of moderators experience modqueue collisions** under volume (Bajpai & Chandrasekharan, CHI 2026, n=110 mods, arxiv 2509.07314).
- **AI detectors have a 61.22% false-positive rate on non-native English** (Liang et al, Patterns 2023, Stanford HAI). Fixed-threshold autopilot can penalize innocent users without enough context, especially when there is no built-in verification path.
- **AutoMod is rule/config based** and cannot reliably evaluate semantic synthetic-content patterns by itself.
- **Toolbox is browser-only**, no mobile, no AI awareness, aging codebase.

## How it's different from Stop AI

[Stop AI](https://developers.reddit.com/apps/stop-ai) (431 communities, v1.2.0) is the incumbent in this space — academic detection algorithms (Binoculars, DetectGPT, GLTR, TypeTruth), one threshold (50%), and optional autopilot enforcement. Stop AI is **detection-first**.

Slopguard is **workflow-first**: confidence bands, review coordination, author verification, and reversible moderation decisions. The two products solve adjacent problems for different mod philosophies.

| | Stop AI | Slopguard |
|---|---|---|
| Approach | Detection-first — academic algorithms producing a score | Workflow-first — multi-signal triage with explainable tiers |
| Threshold model | Fixed 50% binary | Graduated tiers (configurable per sub) |
| Default mode | Detection + optional autopilot enforcement | Advisory — surface to queue, mod decides |
| False-positive handling | Mod adjusts threshold; user files Reddit native report | Verify-author modmail before action — fair to non-native English, dyslexia, translation users |
| Explainability | Score from algorithm | Per-signal panel: "flagged because em-dash density 3.2/1k chars, 1-day account, duplicate body hash" |
| Mod-collision prevention | None | Real-time "u/X is reviewing this" lock |
| Per-sub policy modes | One mode (autopilot configurable) | Three (Advisory / Verify / Strict) |
| Aesthetic | XP, ranks, badges | Professional mod tooling, no gamification |
| Open-source | Unknown | MIT, https://github.com/oneKn8/slopguard |

**Position:** Slopguard works standalone or alongside Stop AI as the workflow + fairness + collision-safety layer.

## How it works (technical)

Seven signal layers, all local-first (no HTTP/LLM required for MVP):

| Signal | What it catches | Cost |
|---|---|---|
| **Structural** | AI-output patterns — em-dash density, formulaic phrases, sentence-length burstiness, markdown heading patterns | Free, ~5ms |
| **Behavioral** | Account / submission metadata where exposed by Devvit — new accounts, low karma, cross-posting velocity, posting cadence (helps surface AI bots and spam bots alike) | Free, ~10ms |
| **Promo** | Affiliate links, URL shorteners, "DM me for…" patterns, crypto wallet addresses, common pump/promo phrases | Free, ~5ms |
| **Contact-leak** | Phone numbers, Telegram handles, WhatsApp links, personal emails in body (high spam correlation) | Free, ~5ms |
| **Duplication** | Hash match against prior submissions across the sub (catches AI spam AND copy-paste spam) | Free, ~10ms |
| **History** | User prior-flag count and confirmed-flag rate | Free, ~5ms |
| **LLM ensemble** (V2, opt-in escalation) | Gemini 2.5 Flash + Claude Haiku 4.5 + GPT-4o-mini, weighted fusion, disagreement signal | $0.0004/item, ~800ms |

Final score = weighted blend of local signals. **MVP ships without any HTTP fetch** — no Devvit premium-feature review needed for the core product. LLM ensemble is a V2 opt-in feature for mods who want extra signal on uncertain cases; that's the path that requires HTTP allowlist approval.

**Cost discipline (when LLM is enabled):** karma threshold gating, approved-user skip, account-age skip, daily spend cap, mod-skip. Gemini free tier covers most subs at $0/month.

## What you get as a mod

- **Per-signal explainability** on every flag — never a black box
- **Verify-author workflow** — auto-modmail asks the user to explain; reply is attached to the review card so mods see context in one place (research-backed via [AppealMod, arxiv 2301.07163](https://arxiv.org/abs/2301.07163))
- **Real-time mod-collision lock** — "u/X is reviewing this" prevents two mods acting on the same item (solves the CHI 2026 74.5% pain directly)
- **Per-sub policy modes** (Advisory default / Verify / Strict)
- **Daily metrics post** — items scored, flagged, removed, reversed, time saved
- **Modnote integration** — confirmed cases get notes for cross-mod consistency
- **Mobile parity** — works in Reddit's mobile app (Toolbox doesn't)
- **Reversible moderation** — every action is logged for easy undo

## Future roadmap (V2+)

- **LLM ensemble opt-in escalation** (Gemini + Claude + GPT, weighted fusion, disagreement signal)
- **LLM-aided reply parsing** for verify-author workflow (auto-classify legitimate vs. evasive responses)
- **Image AI detection** via Gemini vision
- **OCR for text-in-images** (hidden promo/contact info)
- **Cross-sub federation** — opt-in shared bad-actor lists across participating subs (requires trust + privacy framework before launch)

## Honesty stance

No AI detector is perfectly accurate. Stanford documented a 61.22% false-positive rate on TOEFL essays. Fixed-threshold autopilot — without an appeals path — risks silently penalizing innocent users, especially non-native English speakers.

Slopguard is built around this reality:

- **Default mode is Advisory** — Slopguard never removes by itself unless Strict mode is explicitly enabled
- **LLM ensemble is opt-in V2**, not core to MVP
- **Multi-model disagreement is surfaced explicitly** when LLM is enabled
- **Verify-author safety net** handles the 75–92% band fairly
- **Prompts (when LLM is enabled) explicitly de-emphasize surface fluency** so non-native English isn't penalized
- **Every action is reversible and logged**
- **Mod judgment is the final authority** for any ambiguous case

This is the version we can defend to the most skeptical judge or mod — including non-native speakers who would be most at risk under fixed-threshold autopilot tools.

## What Slopguard is NOT

- Not a verdict — mods decide; Slopguard is a triage signal with reasoning
- Not anti-AI dogma — per-sub policy determines action
- Not a black box — every score is explainable down to the signal level
- Not adversarial-proof — no detector is, and we don't pretend otherwise
- Not a replacement for human judgment — it scaffolds it, doesn't substitute
- Not in competition with Stop AI — they're detection-first, we're workflow-first

## Target prizes

- **Best New Mod Tool ($10,000)** — differentiated workflow (multi-signal triage, graduated review tiers, collision prevention)
- **Moderators' Choice ($10,000)** — fair, explainable, mod-respecting design wins mod testimonials
- **Honorable Mention ($1,000)** — fallback for build quality

## Author

Shifat Islam Santo, UTD CS '27 — [github.com/oneKn8](https://github.com/oneKn8), u/shifatsanto75

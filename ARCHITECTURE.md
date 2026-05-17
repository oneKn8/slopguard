# Slopguard Architecture

## Stack

- **Devvit Classic** — TypeScript + `@devvit/public-api` 0.12.x. V8 isolate runtime (Cloudflare-Worker-like; `fetch`, `crypto.subtle`, no Node `fs`).
- **No build system overhead** — Devvit handles bundling.
- **Local-first signals** — six deterministic detectors run on every item with zero HTTP/LLM cost. LLM ensemble is an opt-in escalation tier.

## Project layout (as shipped)

```
slopguard/
├── devvit.yaml              # app name
├── package.json             # @devvit/public-api 0.12.23, TS 5.8.3
├── tsconfig.json            # extends @devvit/public-api/devvit.tsconfig.json
├── tsconfig.tests.json      # compiles smoke tests (no Devvit runtime needed)
├── README.md                # GitHub-facing, matches PRODUCT.md positioning
├── PRODUCT.md               # canonical product description (LOCKED)
├── ARCHITECTURE.md          # this file
├── LICENSE                  # MIT
├── docs/
│   └── banner.png           # README hero
├── src/
│   ├── main.ts              # entry — registers settings, triggers, menus, scheduler jobs, custom post type
│   ├── settings.ts          # app settings schema + getPolicyMode() helper
│   ├── types.ts             # shared TS types (EnsembleScore, ProviderScore, PolicyMode, LocalSignalSummary, ScoreSource)
│   ├── redis.ts             # Redis key conventions + markFlagCounted/markHandled dedup helpers
│   │
│   ├── signals/             # six local, deterministic detectors (no HTTP, no LLM)
│   │   ├── types.ts         # SignalKind, SignalResult, AggregatedSignals
│   │   ├── structural.ts    # em-dash density, formulaic phrases, burstiness, markdown headings
│   │   ├── behavioral.ts    # account age, karma, posting velocity (uses Devvit User where exposed)
│   │   ├── duplication.ts   # text+URL hash dedup with 48h sliding window
│   │   ├── history.ts       # prior-flag/removal weighting with time decay
│   │   ├── promo.ts         # affiliate URLs, shorteners, pump phrases, crypto wallets
│   │   ├── contact.ts       # Telegram (context-gated), WhatsApp, strong-shape phone, personal email
│   │   └── index.ts         # orchestrator — weighted fusion + corroboration boost
│   │
│   ├── ensemble/            # opt-in LLM escalation tier
│   │   ├── index.ts         # orchestrator with gray-band gate
│   │   ├── gemini.ts        # Gemini 2.5 Flash
│   │   ├── claude.ts        # Claude Haiku 4.5
│   │   ├── openai.ts        # GPT-4o-mini
│   │   ├── scoring.ts       # weighted fusion + disagreement std-dev
│   │   ├── replyClassifier.ts  # Gemini-based author-reply classification (genuine/evasive/non-response/ai-generated-reply)
│   │   └── vision.ts        # Gemini vision: AI-image classification + OCR (with AbortController timeout)
│   │
│   ├── lib/
│   │   ├── triage.ts        # top-level runTriage() — local-first, optional LLM escalation, vision pass, federation lookup
│   │   ├── modActions.ts    # remove + reason + reply + modnote chain; records to federation outbox
│   │   ├── gating.ts        # karma/age/approved/mod skip
│   │   ├── verifyAuthor.ts  # modmail sender, Redis ledger, attach-reply
│   │   ├── collisionLock.ts # per-item lock with TTL + optional Devvit realtime broadcast
│   │   ├── discord.ts       # opt-in webhook notifier on first-flag events
│   │   └── federation.ts    # opt-in, hashed-only (128-bit) cross-sub bad-actor sharing + audit + dry-run mode
│   │
│   ├── triggers/
│   │   ├── onPostCreate.ts  # runTriage → save → metrics → queue → Discord → policy-mode action
│   │   ├── onCommentCreate.ts  # same pattern for comments
│   │   ├── onPostReport.ts  # re-scores with forceLlm
│   │   └── onModMail.ts     # attaches author replies; runs reply classifier when LLM escalation is on
│   │
│   ├── menu/
│   │   ├── explainScore.ts  # full per-signal breakdown + verify-author reply + classification
│   │   ├── removeAsAI.ts    # one-click remove chain
│   │   ├── analyzeWithSlopguard.ts  # manual mod triage (forces LLM)
│   │   ├── claimReview.ts   # collision-lock toggle (claim / release)
│   │   ├── createDashboardPost.tsx  # submit the live dashboard custom post
│   │   ├── showMetrics.ts   # today's metrics toast
│   │   └── federation.ts    # audit outbox, publish now, clear outbox
│   │
│   ├── customPost/
│   │   ├── queue.ts         # Redis-backed recent-flagged queue (capped 50, 7d TTL)
│   │   └── dashboard.tsx    # Devvit Blocks live queue UI with Refresh button
│   │
│   └── scheduler/
│       ├── dailyMetricsPost.ts   # 13:00 UTC daily summary sticky
│       └── federationPublish.ts  # every-6h publish + merge cycle
├── tests/
│   └── signals.smoke.ts     # 29 pure-function assertions (structural/promo/contact + fuseLocalAndLlm + shortHash + normalizeCategory)
```

## Data model (Redis)

All keys are namespaced `sg:*`. Devvit Redis supports `SET NX`, atomic `INCRBY`, sorted sets (`zAdd`/`zRange`/`zRemRange*`), and key-level TTL — used throughout for concurrency-safe state.

```
sg:score:{itemId}                  → JSON EnsembleScore (30-day TTL)
sg:user:{username}                 → JSON UserHistory { flagCount, removedCount, lastFlagTs }
sg:metrics:{YYYY-MM-DD}            → JSON DailyMetrics
sg:spend:{YYYY-MM-DD}              → integer microcents (USD * 1e6), atomic via INCRBY
sg:lock:{itemId}                   → JSON CollisionLock — atomic NX-claim, force-claim via second press
sg:lock-force-intent:{id}:{mod}    → "1" — 60s force-claim intent marker
sg:handled:{event}:{id}            → "1" — atomic NX trigger dedup
sg:flagged:{itemId}                → "1" — atomic NX first-flag dedup
sg:dup:txt:{sub}:{hash}            → ZSET (member=itemId, score=ts) — duplication, 48h sliding window
sg:dup:url:{sub}:{hash}            → ZSET (member=itemId, score=ts) — duplication, 48h sliding window
sg:verify:{itemId}                 → JSON VerifyRequest — verify-author ledger
sg:verify-conv:{conversationId}    → string itemId — reverse index for ModMail trigger
sg:queue:recent                    → ZSET (member=itemId, score=ts) — dashboard queue, capped 50, 7d TTL
sg:fed:outbox                      → JSON FederationOutbox — local-only until publish
sg:fed:index                       → JSON FederationIndex — peer observations, per-record TTL filter on read
sg:fed:last-published              → number ms timestamp of last publish cycle
```

## External HTTP

Devvit Classic 0.12.x uses `Devvit.configure({ http: true })` in `src/main.ts` for outbound HTTP — there is no per-domain allowlist in `devvit.yaml` for this Devvit version. Outbound endpoints used at runtime:

- `https://generativelanguage.googleapis.com` — Gemini text + vision (BYOK)
- `https://api.anthropic.com` — Claude Haiku 4.5 (BYOK, optional)
- `https://api.openai.com` — GPT-4o-mini (BYOK, optional)
- `https://discord.com` — webhook notifications, only when `DiscordWebhookUrl` is configured
- User-configured `FederationEndpoint` — only when federation is enabled and the field is set

## Triage flow

```
PostCreate / CommentSubmit / PostReport
        │
        ▼
runTriage (src/lib/triage.ts)
        │
        ├── runLocalSignals (6 detectors in parallel where async)
        │     - structural (text)
        │     - behavioral (user metadata)
        │     - duplication (Redis hash check)
        │     - history (prior flags)
        │     - promo (regex)
        │     - contact (regex)
        │
        ├── queryFederation (if EnableFederation)
        │     - looks up shortHash(username) in sg:fed:index
        │     - folds in as synthetic history-kind SignalResult
        │
        ├── visionPass (if UseLlmVision + image URL + budget reservation succeeds)
        │     - classifyImageForAi(geminiKey, url)  →  AI-generation score
        │     - extractTextFromImage(geminiKey, url) → OCR text
        │     - re-runs promo+contact on OCR text
        │     - folds in as synthetic structural-kind SignalResult
        │
        ├── (if UseLlmEscalation AND combinedScore in [low, high] band)
        │     scoreItem (LLM ensemble — Gemini + Claude + OpenAI weighted fusion)
        │     fuseLocalAndLlm — local 0.55 + llm 0.45, ratchet ONLY when both ≥ 0.5
        │
        ▼
EnsembleScore { finalScore, confidence, source, localScore, llmScore, localSignals, topReasons }
        │
        ▼  finalScore ≥ flagThreshold?
        │
        ├── saveScore + bumpDailyMetrics
        ├── markFlagCounted (first-time only) → incrUserFlag + pushToQueue + notifyDiscord
        └── policy mode:
             - Advisory  → done (mod sees it on dashboard / via Explain Score)
             - Verify    → sendVerifyDm (modmail to author)
             - Strict    → sendVerifyDm + autoRemoveIfThreshold (only if score ≥ autoRemoveThreshold AND confidence != low)
```

## Cost discipline

- **Default = local-only, $0/month at any volume.**
- **LLM escalation (opt-in)**: only fires when local combined score is in the gray band [0.4, 0.75]. Gemini Flash free tier (~1,500 req/day) covers most subs.
- **Spend cap**: `MaxDailySpendUsd` enforced via atomic `INCRBY` on integer microcents. Concurrent triggers all see a consistent post-increment total — whichever caller pushes the spend past the cap refunds its reservation. Vision pass reserves `$0.001` up-front before fan-out.
- **Two-tier gating**: see `src/lib/gating.ts`.
  - `skipCompletely` — system users, AutoModerator, mods, approved submitters. No detection runs.
  - `skipLlm` — karma above threshold, account age above threshold. **Local signals still run** (wallet, contact, duplication, structural) because they're free and high-karma accounts can be compromised. Only LLM/vision escalation is suppressed.

## Privacy / federation framework

See `src/lib/federation.ts` header. In short:

- Only **128-bit SHA-256 hashes** leave the sub (`shortHash`). The salt is constant and public — this is pseudonymization, not anti-enumeration. Mods who want stronger privacy keep federation disabled (the default).
- No content, no IP, no metadata. Just `{userHash, srcHash, removedCount, lastRemovedTs}`.
- Sub identifier is also hashed.
- Mods can `audit` the outbox before publish via menu action.
- Records expire after 90 days.
- Gateway responses are validated: bounded record count (5000), clamped `removedCount` (1-50), hex-validated hashes, future-dated timestamps rejected.
- Dry-run mode when `FederationEndpoint` is unset — nothing leaves the sub.
- Index uses per-(user,src) observations; re-merging the same record across cycles is idempotent.

## What ships in MVP vs V2

| Layer | MVP (default-on) | V2 (opt-in) |
|---|---|---|
| Six local signals | ✅ | — |
| Weighted fusion + corroboration boost | ✅ | — |
| Advisory mode | ✅ | — |
| Verify / Strict modes | ✅ | — |
| Verify-author modmail | ✅ | — |
| Mod-collision lock + Claim/Release menu | ✅ | — |
| Custom-post live dashboard | ✅ | — |
| Daily metrics post | ✅ | — |
| LLM ensemble escalation (Gemini/Claude/OpenAI) | — | ✅ `UseLlmEscalation` |
| Gemini vision (AI-image + OCR) | — | ✅ `UseLlmVision` |
| LLM-aided reply classifier | — | ✅ (under `UseLlmEscalation`) |
| Discord webhook | — | ✅ `DiscordWebhookUrl` |
| Cross-sub federation | — | ✅ `EnableFederation` (dry-run by default) |

## Testing

`npm run test:smoke` runs 29 pure-function assertions covering:
- Structural: AI-text-heavy → ≥0.5, non-native-English → ≤0.25, clean casual → ≤0.2
- Promo: scam-pump-wallet → ≥0.7, legit link → ≤0.15, crypto discussion without wallet → ≤0.15, lone shortener → 0.1–0.4
- Contact: multi-channel scam → ≥0.7, Reddit @username mentions → ≤0.1, ISBN/order numbers → ≤0.2, single legit phone → 0.05–0.3
- `fuseLocalAndLlm` ratchet (refuses to over-ride clean local with hallucinated high LLM)
- `shortHash` stability + shape (32-hex / 128-bit)
- `normalizeCategory` alias mapping + invalid inputs

Stateful modules (duplication, history, behavioral, verifyAuthor, federation, queue) require Devvit Redis and are exercised in playtest.

## Why this design

1. **Local-first** keeps cost at zero for the default install and makes the product viable at any sub size — no API-key barrier.
2. **Hybrid escalation** captures the cases the local signals can't (true AI-text on non-template prose, AI images) without paying for every item.
3. **Explainability** at the signal level beats any single black-box score. Mods don't trust verdicts they can't audit.
4. **Workflow-first** complements rather than replaces existing tools. Mods install it alongside Stop AI, AutoMod, and Toolbox.
5. **Fairness by default** — non-native-English protection cap, verify-author appeal path, Advisory default — addresses the Stanford documented 61.22% FPR risk head-on.

## Known limitations

- **Daily spend cap is best-effort under burst load.** Atomic `INCRBY` guarantees no torn updates, and the first caller to cross the cap refunds. But under extreme concurrency (many triggers firing within the same Redis round-trip window), all callers can pass the pre-flight check, run, and *then* see the cap exceeded. Bounded by N * worst-case-call-cost; for Gemini Flash with default ~$1/day cap and ~$0.0005/call, overage is at most a few cents.
- **Per-record JSON counters (UserHistory, DailyMetrics) use get-then-set.** Lost updates are possible under concurrent flags on the same author or same calendar day. Could be reworked to hash fields with `HINCRBY`; left as-is for MVP. Impact: occasional missed +1 on flagCount under heavy concurrent load; never affects flagging correctness.
- **Federation transport assumes a trusted gateway** at the configured `FederationEndpoint`. Gateway responses are validated (record count, hex hashes, clamped removedCount, future-dated rejection), but a malicious gateway could still flood the index with realistic-looking fake observations to inflate or deflate a specific user's federated score. Default is dry-run (no endpoint) for this reason.
- **Realtime broadcast is best-effort**; the Redis lock is the source of truth for collision prevention.

import type { SignalResult } from "./types.js";

/**
 * Promo signal — surfaces classic spam/scam/promo markers:
 * affiliate-tagged URLs, link shorteners, crypto wallet addresses, pump
 * phrases ("get rich quick", "guaranteed returns", "limited spots"), and
 * "DM me" routing patterns common to scams and MLM recruiting.
 *
 * NOT a verdict — overlap with legitimate content (referral links, affiliate
 * disclosures, legitimate trading discussion) is unavoidable, so we keep
 * weights moderate and let mods see the per-pattern reason.
 */

const SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "t.co",
  "shorturl.at",
  "rebrand.ly",
  "cutt.ly",
  "rb.gy",
  "bitly.com",
  "shorte.st",
  "adf.ly",
  "linktr.ee",
  "lnkd.in",
  "v.gd",
  "tr.im",
  "soo.gd",
  "s.id",
]);

const AFFILIATE_PARAMS = [
  /[?&]ref=/i,
  /[?&]aff(iliate)?=/i,
  /[?&]tag=[a-z0-9_-]{4,}/i,
  /[?&]utm_source=affiliate/i,
  /[?&]partner_id=/i,
  /[?&]referrer=/i,
  /[?&]via=/i,
];

const PUMP_PHRASES = [
  /\bguaranteed\s+(returns?|profit|income)/i,
  /\b(easy|quick|fast)\s+money\b/i,
  /\bget\s+rich\s+quick\b/i,
  /\bfinancial\s+freedom\b/i,
  /\bpassive\s+income\s+stream/i,
  /\blimited\s+(spots?|seats?|time)\s+(only|left|available)/i,
  /\b\d{1,3}%\s+(returns?|profit|gains?)\s+(per|in)\s+(day|week|month)/i,
  /\bmake\s+\$\s?\d{2,}/i,
  /\bearn\s+\$\s?\d{2,}\s+(daily|weekly|monthly|per\s+day)/i,
  /\bno\s+experience\s+(needed|required)/i,
  /\bwork\s+from\s+home\b.{0,40}\$/i,
  /\bjoin\s+my\s+(team|downline|group)/i,
  /\b(crypto|btc|eth|nft)\s+(signals?|gem|moonshot|pump)/i,
  /\bairdrop\s+(claim|free)/i,
  /\bdouble\s+your\s+(money|btc|eth|crypto)/i,
  /\binvest(ment)?\s+opportunity\b/i,
  /\b100x\s+(gem|coin|gains?)/i,
];

const DM_PATTERNS = [
  /\bdm\s+me\b/i,
  /\bmessage\s+me\s+(for|to|directly|privately)/i,
  /\bpm\s+me\b/i,
  /\bsend\s+me\s+a\s+(dm|pm|message)\b/i,
  /\binbox\s+me\b/i,
  /\bhit\s+me\s+up\b/i,
  /\bcontact\s+me\s+(privately|directly|via)/i,
];

// Crypto wallet address patterns (conservative — require word boundaries).
// SOL is omitted from the unconditional list because base58 32–44 char strings
// collide with many non-wallet tokens (Reddit IDs, UUID variants, hashes).
// We only match SOL when it appears within 40 chars of a SOL-specific keyword.
const WALLET_PATTERNS = [
  /\b(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,39}\b/, // BTC (legacy + bech32)
  /\b0x[a-fA-F0-9]{40}\b/, // ETH / EVM
  /\bT[A-Za-z0-9]{33}\b/, // TRON
];

const SOL_NEAR_CONTEXT =
  /\b(sol|solana|phantom|spl|sol-?address)\b[^\n]{0,40}[1-9A-HJ-NP-Za-km-z]{32,44}\b|[1-9A-HJ-NP-Za-km-z]{32,44}\b[^\n]{0,40}\b(sol|solana|phantom|spl|sol-?address)\b/i;

function extractUrls(text: string): string[] {
  const raw = text.match(/https?:\/\/[^\s)\]]+/gi) ?? [];
  // Trim trailing sentence punctuation that should not be part of the URL.
  return raw.map(u => u.replace(/[.,;:!?)]+$/, ""));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export interface PromoInput {
  text: string;
  url?: string;
}

export function promoSignal(input: PromoInput): SignalResult {
  const text = `${input.text ?? ""} ${input.url ?? ""}`.trim();
  if (text.length === 0) {
    return {
      kind: "promo",
      name: "promo",
      score: 0,
      reasons: ["empty content"],
    };
  }

  const reasons: string[] = [];
  const detail: Record<string, number | string | boolean> = {};
  let score = 0;

  // --- Shorteners ---
  const urls = [
    ...extractUrls(text),
    ...(input.url ? [input.url] : []),
  ];
  const shortenerHits = new Set<string>();
  const affiliateHits: string[] = [];
  for (const u of urls) {
    const host = hostOf(u);
    if (host && SHORTENERS.has(host)) shortenerHits.add(host);
    for (const re of AFFILIATE_PARAMS) {
      if (re.test(u)) {
        affiliateHits.push(u.slice(0, 60));
        break;
      }
    }
  }
  if (shortenerHits.size > 0) {
    score += shortenerHits.size >= 2 ? 0.3 : 0.18;
    reasons.push(
      `link shortener: ${[...shortenerHits].slice(0, 3).join(", ")}`,
    );
    detail.shortenerCount = shortenerHits.size;
  }
  if (affiliateHits.length > 0) {
    score += affiliateHits.length >= 2 ? 0.28 : 0.15;
    reasons.push(`affiliate-tagged URL (${affiliateHits.length})`);
    detail.affiliateCount = affiliateHits.length;
  }

  // --- Pump phrases ---
  let pumpHits = 0;
  const firstPumpMatches: string[] = [];
  for (const re of PUMP_PHRASES) {
    const m = text.match(re);
    if (m) {
      pumpHits++;
      if (firstPumpMatches.length < 2) firstPumpMatches.push(m[0].slice(0, 50));
    }
  }
  if (pumpHits >= 3) {
    score += 0.45;
    reasons.push(`${pumpHits} pump/scam phrases ("${firstPumpMatches[0]}"…)`);
  } else if (pumpHits === 2) {
    score += 0.28;
    reasons.push(`pump phrases: "${firstPumpMatches[0]}", "${firstPumpMatches[1]}"`);
  } else if (pumpHits === 1) {
    score += 0.15;
    reasons.push(`pump phrase: "${firstPumpMatches[0]}"`);
  }
  detail.pumpHits = pumpHits;

  // --- DM routing ---
  let dmHits = 0;
  let firstDm = "";
  for (const re of DM_PATTERNS) {
    const m = text.match(re);
    if (m) {
      dmHits++;
      if (!firstDm) firstDm = m[0];
    }
  }
  if (dmHits > 0) {
    score += dmHits >= 2 ? 0.2 : 0.1;
    reasons.push(`off-platform routing: "${firstDm}"`);
    detail.dmHits = dmHits;
  }

  // --- Crypto wallets ---
  // BTC/ETH/TRON patterns are tight enough to use unconditionally.
  // SOL only fires when within 40 chars of a SOL-specific keyword.
  let walletHits = 0;
  let firstWallet = "";
  for (const re of WALLET_PATTERNS) {
    const m = text.match(re);
    if (m) {
      walletHits++;
      if (!firstWallet) firstWallet = m[0];
    }
  }
  const solMatch = text.match(SOL_NEAR_CONTEXT);
  if (solMatch) {
    walletHits++;
    if (!firstWallet) {
      // Extract just the address portion from the proximity match
      const addr = solMatch[0].match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      firstWallet = addr ? addr[0] : solMatch[0].slice(0, 20);
    }
  }
  if (walletHits > 0) {
    score += walletHits >= 2 ? 0.45 : 0.3;
    reasons.push(
      `crypto wallet address in body (${firstWallet.slice(0, 10)}…)`,
    );
    detail.walletHits = walletHits;
  }

  score = Math.max(0, Math.min(1, score));

  if (reasons.length === 0) {
    reasons.push("no promo/spam markers found");
  }

  return {
    kind: "promo",
    name: "promo",
    score,
    reasons,
    detail,
  };
}

import type { SignalResult } from "./types.js";

/**
 * Contact signal — flags off-platform contact info embedded in the body.
 * Telegram handles, WhatsApp / wa.me links, personal phone numbers, and
 * personal emails are strong correlates of scam/spam/recruitment content.
 *
 * Conservative on emails — newsletter footers and "contact us" lines on
 * legitimate org accounts shouldn't trip this hard, so a single email gets
 * a low weight. Multiple contact channels in one post is the strong signal.
 */

const TELEGRAM_LINK = /\b(?:t\.me|telegram\.me|telegram\.org)\/[A-Za-z0-9_+/?=&-]+/i;
// A bare "@username" matches Reddit user mentions far more often than Telegram,
// so we only accept handles when an explicit Telegram context word is present.
const TELEGRAM_CONTEXT = /\btelegram\b/i;
const TELEGRAM_HANDLE_NEAR_CONTEXT =
  /\btelegram\b[^\n]{0,40}@[A-Za-z][A-Za-z0-9_]{4,31}\b|@[A-Za-z][A-Za-z0-9_]{4,31}\b[^\n]{0,40}\btelegram\b/i;
const WHATSAPP_LINK = /\b(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/[A-Za-z0-9_+/?=&-]+/i;
const WHATSAPP_MENTION = /\bwhats?\s?app\b/i;
const SIGNAL_LINK = /\bsignal\.me\/#p\/[A-Za-z0-9_+-]+/i;
const DISCORD_INVITE = /\b(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9_-]+/i;

// Email — exclude obvious noreply / support / org-style addresses (single weight only).
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const NOREPLY_PARTS = /(noreply|no-reply|donotreply|support|admin|info|hello|contact|hr|jobs|press|sales)@/i;

// Phone numbers — require a strong shape (+country code OR parenthesized area
// code) so ISBN/SKU/order-number patterns don't match. The previous loose
// pattern caught long product IDs and base58 substrings.
const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?\d[\d\s.-]{7,15}\d)|(?:\(\d{2,4}\)[\s.-]?\d{2,4}[\s.-]?\d{3,4})/g;

function isLikelyPhone(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  return true;
}

export interface ContactInput {
  text: string;
}

export function contactSignal(input: ContactInput): SignalResult {
  const text = input.text ?? "";
  if (text.length === 0) {
    return {
      kind: "contact",
      name: "contact",
      score: 0,
      reasons: ["empty content"],
    };
  }

  const reasons: string[] = [];
  const detail: Record<string, number | string | boolean> = {};
  let score = 0;
  let channels = 0;

  // Telegram — require either an explicit t.me/telegram.* link or an "@handle"
  // co-occurring with the word "telegram" within 40 chars. Plain "@username"
  // is way more often a Reddit mention than a Telegram one.
  const tgLink = text.match(TELEGRAM_LINK);
  const tgHandleWithContext = TELEGRAM_CONTEXT.test(text)
    ? text.match(TELEGRAM_HANDLE_NEAR_CONTEXT)
    : null;
  if (tgLink || tgHandleWithContext) {
    score += 0.32;
    channels++;
    const sample = tgLink?.[0] ?? tgHandleWithContext?.[0].trim();
    reasons.push(`Telegram contact: ${sample?.slice(0, 40)}`);
    detail.telegram = true;
  }

  // WhatsApp
  const waLink = text.match(WHATSAPP_LINK);
  if (waLink) {
    score += 0.32;
    channels++;
    reasons.push(`WhatsApp link: ${waLink[0].slice(0, 40)}`);
    detail.whatsapp = true;
  } else if (WHATSAPP_MENTION.test(text) && /\d{7,}/.test(text)) {
    score += 0.18;
    channels++;
    reasons.push("WhatsApp mention with number nearby");
    detail.whatsappLoose = true;
  }

  // Signal messenger
  if (SIGNAL_LINK.test(text)) {
    score += 0.25;
    channels++;
    reasons.push("Signal Messenger contact link");
    detail.signalMessenger = true;
  }

  // Discord invite (mild — Discord invites are also legitimate community use)
  if (DISCORD_INVITE.test(text)) {
    score += 0.1;
    channels++;
    reasons.push("Discord invite link");
    detail.discordInvite = true;
  }

  // Phone numbers
  const rawPhones = text.match(PHONE_RE) ?? [];
  const phones = rawPhones.filter(isLikelyPhone);
  if (phones.length >= 2) {
    score += 0.25;
    channels++;
    reasons.push(`${phones.length} phone numbers in body`);
  } else if (phones.length === 1) {
    score += 0.15;
    channels++;
    reasons.push(`phone number in body (${phones[0].trim().slice(0, 20)})`);
  }
  detail.phoneCount = phones.length;

  // Emails — personal-looking only (filter org/role addresses)
  const emails = (text.match(EMAIL_RE) ?? []).filter(
    e => !NOREPLY_PARTS.test(e),
  );
  if (emails.length >= 2) {
    score += 0.18;
    channels++;
    reasons.push(`${emails.length} personal emails in body`);
  } else if (emails.length === 1) {
    score += 0.08;
    reasons.push(`email in body (${emails[0]})`);
  }
  detail.emailCount = emails.length;

  // Stacking bonus — multiple distinct off-platform channels is the real
  // scam fingerprint.
  if (channels >= 3) {
    score += 0.2;
    reasons.push(`${channels} distinct off-platform contact channels`);
  } else if (channels === 2) {
    score += 0.08;
  }
  detail.channels = channels;

  score = Math.max(0, Math.min(1, score));

  if (reasons.length === 0) {
    reasons.push("no off-platform contact info found");
  }

  return {
    kind: "contact",
    name: "contact",
    score,
    reasons,
    detail,
  };
}

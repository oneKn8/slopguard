/**
 * Smoke tests for pure-text signals (structural, promo, contact). These
 * exercise the regex/heuristic logic against representative samples;
 * stateful signals (duplication, history, behavioral) need Devvit Redis
 * and are exercised in the playtest sub.
 *
 * Run:  npm run test:smoke
 */
import { structuralSignal } from "../src/signals/structural.js";
import { promoSignal } from "../src/signals/promo.js";
import { contactSignal } from "../src/signals/contact.js";

type Range = [number, number];

interface Case {
  name: string;
  expect: Range;
  text: string;
  url?: string;
}

let fails = 0;
let passes = 0;

function assertRange(
  signal: string,
  caseName: string,
  actual: number,
  range: Range,
  reasons: string[],
): void {
  const [lo, hi] = range;
  const ok = actual >= lo && actual <= hi;
  if (ok) {
    passes++;
    console.log(`  PASS  ${signal.padEnd(11)} ${caseName.padEnd(40)} ${actual.toFixed(2)} ∈ [${lo},${hi}]`);
  } else {
    fails++;
    console.log(`  FAIL  ${signal.padEnd(11)} ${caseName.padEnd(40)} ${actual.toFixed(2)} ∉ [${lo},${hi}]`);
    console.log(`        reasons: ${reasons.join(" | ")}`);
  }
}

// --------------- structural ---------------

const aiTextHeavy = `In today's fast-paced digital landscape, it's important to note that AI is reshaping the world — fundamentally transforming how we work, communicate, and learn.

**Key Considerations**

Firstly, organizations must navigate the complex landscape of emerging technologies. Not only is this crucial — but also essential to long-term success. The cornerstone of this transformation lies in unlocking the potential of generative models.

**Strategic Implications**

It's crucial to harness the power of these tools while remaining mindful of their limitations. This delicate balance plays a pivotal role in shaping outcomes — and it shines a light on what truly matters going forward.`;

const nonNativeEnglish = `Hi everyone, this is my first post here. I am from Bangladesh and I am learning English programming. I have a question about my python code. I am getting error when I run it. The error is "TypeError: cannot convert int to str". I tried many things from stackoverflow but nothing work. Can someone please help me to understand what is happening here. I am very new and want to learn. Thank you in advance for your time and help.`;

const clean = `Just spent the weekend rewiring my garage. Took longer than expected because the previous owner ran 14-gauge where they should've used 12-gauge for the compressor circuit. Anyway, all done now, breakers stop tripping. If anyone else is doing a similar project, get the right gauge wire the first time — it's annoying to redo.`;

const structuralCases: Case[] = [
  { name: "ai-text-heavy", expect: [0.5, 1.0], text: aiTextHeavy },
  { name: "non-native-english", expect: [0.0, 0.25], text: nonNativeEnglish },
  { name: "clean-casual", expect: [0.0, 0.2], text: clean },
];

console.log("\n--- structural ---");
for (const c of structuralCases) {
  const r = structuralSignal(c.text);
  assertRange("structural", c.name, r.score, c.expect, r.reasons);
}

// --------------- promo ---------------

const promoSpammy = `Make $5000 daily — no experience needed! Limited spots available, DM me for details. Join my team and unlock financial freedom. 100x gem coming soon, send 0.1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e and double your money guaranteed!`;

const legitWithLink = `I wrote up my notes on the new release here: https://example.com/blog/release-notes. Lmk if anything is unclear, happy to clarify.`;

const legitDiscussion = `I've been using crypto wallets for a while and the address format always confuses me. Anyone know why Solana addresses look so different from Ethereum ones?`;

const shortenerOnly = `Quick read: https://bit.ly/abc123 lots of great info here.`;

const promoCases: Case[] = [
  { name: "spam-pump-wallet", expect: [0.7, 1.0], text: promoSpammy },
  { name: "legit-with-link", expect: [0.0, 0.15], text: legitWithLink },
  { name: "crypto-discussion-no-wallet", expect: [0.0, 0.15], text: legitDiscussion },
  { name: "shortener-only", expect: [0.1, 0.4], text: shortenerOnly },
];

console.log("\n--- promo ---");
for (const c of promoCases) {
  const r = promoSignal({ text: c.text, url: c.url });
  assertRange("promo", c.name, r.score, c.expect, r.reasons);
}

// --------------- contact ---------------

const scamContact = `Hi, I can help you recover your lost funds. Contact me on telegram @recovery_pro_99 or whatsapp at https://wa.me/12025550123. Email me too at recovery.expert.99@gmail.com if you prefer. Phone (202) 555-0199.`;

const redditMention = `Thanks @JohnDoe for the great explanation! @AliceSmith might also have input on this since she worked on the original PR.`;

const isbnAndOrderNumber = `Just got my copy of the book, ISBN 978-3-16-148410-0. Order number was 1234-5678-9012 if anyone's curious. Now I'm waiting for the supplementary materials.`;

const phoneInBody = `If you're in Texas you can call the help line at (512) 555-0119 between 9am and 5pm for assistance.`;

const contactCases: Case[] = [
  { name: "scam-multi-channel", expect: [0.7, 1.0], text: scamContact },
  { name: "reddit-username-mentions", expect: [0.0, 0.1], text: redditMention },
  { name: "isbn-and-order-numbers", expect: [0.0, 0.2], text: isbnAndOrderNumber },
  { name: "single-legit-phone", expect: [0.05, 0.3], text: phoneInBody },
];

console.log("\n--- contact ---");
for (const c of contactCases) {
  const r = contactSignal({ text: c.text });
  assertRange("contact", c.name, r.score, c.expect, r.reasons);
}

console.log(`\n${passes} passed, ${fails} failed`);
declare const process: { exit(code: number): never };
if (fails > 0) process.exit(1);

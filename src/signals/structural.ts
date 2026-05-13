import type { SignalResult } from "./types.js";

/**
 * Structural signal — deterministic markers in text that correlate with
 * default-output LLM writing. NOT a verdict; one input among many.
 *
 * Designed to be conservative on short or non-native English text so we don't
 * disproportionately flag those users.
 */

const FORMULAIC_PHRASES = [
  /\bdelve\s+into\s+the\s+(realm|world|landscape|tapestry)/i,
  /\bin\s+the\s+ever[-\s]evolving\s+(landscape|world|realm)/i,
  /\bnavigate\s+the\s+(complex|nuanced|intricate)/i,
  /\bunlock\s+the\s+(potential|power|secrets)/i,
  /\bharness(ing)?\s+the\s+power/i,
  /\bin\s+today'?s?\s+(fast[-\s]paced|modern|digital)/i,
  /\bit'?s?\s+important\s+to\s+note\s+that/i,
  /\bit'?s?\s+(crucial|essential|imperative)\s+to/i,
  /\bnot\s+only\s+[^,]+,?\s+but\s+also/i,
  /\bcornerstone\s+of/i,
  /\bplay(s)?\s+a\s+(crucial|pivotal|vital|key)\s+role/i,
  /\bshed(s|ding)?\s+light\s+on/i,
  /\bgame[-\s]changer/i,
  /\ba\s+testament\s+to/i,
  /\btapestry\s+of/i,
];

const ENUMERATION_OPENERS = [
  /^\s*1\.\s+\*\*/m,
  /^\s*\*\*1\.\*\*/m,
  /^\s*Firstly,/im,
  /^\s*In\s+conclusion,/im,
];

function emDashDensityPer1k(text: string): number {
  const chars = text.length;
  if (chars === 0) return 0;
  const emDashes = (text.match(/—/g) ?? []).length;
  return (emDashes / chars) * 1000;
}

/**
 * Sentence-length burstiness = std-dev / mean of sentence lengths.
 * Human writing is bursty (high variance); AI default output is uniform.
 * Returns `null` when there isn't enough data — caller must skip the
 * burstiness contribution rather than treat the value as evidence.
 */
function sentenceLengthBurstiness(text: string): number | null {
  // Lookahead split so a trailing terminator (no following whitespace) still
  // closes the final sentence — common in non-native English text.
  const sentences = text
    .split(/[.!?]+(?=\s|$)/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (sentences.length < 4) return null;
  const lengths = sentences.map(s => s.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (mean === 0) return null;
  const variance =
    lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const std = Math.sqrt(variance);
  return std / mean;
}

function formulaicMatches(text: string): string[] {
  const hits: string[] = [];
  for (const re of FORMULAIC_PHRASES) {
    const m = text.match(re);
    if (m) hits.push(m[0].slice(0, 60));
  }
  return hits;
}

function hasEnumerationOpener(text: string): boolean {
  return ENUMERATION_OPENERS.some(re => re.test(text));
}

export function structuralSignal(text: string): SignalResult {
  if (text.length < 200) {
    return {
      kind: "structural",
      name: "structural",
      score: 0,
      reasons: ["text too short for reliable structural analysis"],
      detail: { length: text.length },
    };
  }

  const reasons: string[] = [];
  let score = 0;

  // Compute every component first, then decide how much to surface.
  const emDashRate = emDashDensityPer1k(text);
  const phrases = formulaicMatches(text);
  const enumerationOpener = hasEnumerationOpener(text);
  const burst = sentenceLengthBurstiness(text);
  const boldHeadings = (text.match(/^\*\*[A-Z][^*]{2,30}\*\*\s*$/gm) ?? []).length;

  // Strong-indicator count — used to gate the score for non-native-English
  // fairness. A single trigger (e.g. one formulaic phrase, or just a
  // markdown style choice) is not enough to score this signal hard.
  // Shifat's design constraint: do not disproportionately flag non-native
  // English writers.
  const indicators = [
    phrases.length >= 1,
    emDashRate > 1,
    enumerationOpener,
    burst !== null && burst < 0.3,
    boldHeadings >= 2,
  ].filter(Boolean).length;

  // Em-dash density
  if (emDashRate > 2) {
    score += 0.25;
    reasons.push(
      `em-dash density ${emDashRate.toFixed(1)}/1k chars (typical AI output)`,
    );
  } else if (emDashRate > 1) {
    score += 0.1;
    reasons.push(`elevated em-dash density ${emDashRate.toFixed(1)}/1k chars`);
  }

  // Formulaic phrases
  if (phrases.length >= 3) {
    score += 0.3;
    reasons.push(
      `${phrases.length} formulaic AI phrases: "${phrases[0]}", "${phrases[1]}"…`,
    );
  } else if (phrases.length >= 1) {
    score += 0.12;
    reasons.push(`formulaic phrase: "${phrases[0]}"`);
  }

  // Enumeration opener
  if (enumerationOpener) {
    score += 0.08;
    reasons.push("formulaic enumeration / 'Firstly' opener");
  }

  // Burstiness — only contributes when we had enough sentences to compute it.
  if (burst !== null) {
    if (burst < 0.3) {
      score += 0.18;
      reasons.push(`uniform sentence lengths (burstiness ${burst.toFixed(2)})`);
    } else if (burst > 0.7) {
      // human-like — slight negative signal
      score -= 0.05;
    }
  }

  // Markdown bold sub-headings in casual posts
  if (boldHeadings >= 2) {
    score += 0.1;
    reasons.push(
      `${boldHeadings} bold markdown headings (formal AI structuring)`,
    );
  }

  // Non-native-English protection: if only 0–1 indicators agree, cap the
  // structural score at 0.2 so this signal alone cannot tip a post over
  // the flag threshold. Real AI default-output stacks multiple indicators.
  if (indicators < 2) {
    score = Math.min(score, 0.2);
  }

  score = Math.max(0, Math.min(1, score));

  return {
    kind: "structural",
    name: "structural",
    score,
    reasons,
    detail: {
      emDashRate: Number(emDashRate.toFixed(2)),
      formulaicPhraseCount: phrases.length,
      burstiness: burst === null ? -1 : Number(burst.toFixed(2)),
      boldHeadings,
      indicators,
    },
  };
}

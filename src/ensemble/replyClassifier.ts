/**
 * Reply classifier — categorizes an author's reply to a verify-author
 * modmail as genuine / evasive / non-response / ai-generated-reply. The
 * output is attached to the score's review card so mods see at a glance
 * whether the author's response made the case stronger or weaker.
 *
 * NOT a verdict — mods make the final call. The classifier is one extra
 * signal among the per-signal panel. Designed to err toward "uncertain"
 * rather than "evasive" so we don't penalize sincere but brief replies.
 *
 * Uses Gemini 2.5 Flash since replies are short (<2000 chars typically).
 * Costs ~$0.0001 per classification.
 */

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const COST_INPUT_PER_TOKEN = 0.3 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 2.5 / 1_000_000;

export type ReplyCategory =
  | "genuine"
  | "evasive"
  | "non-response"
  | "ai-generated-reply"
  | "uncertain";

export interface ReplyClassification {
  category: ReplyCategory;
  confidence: number; // 0..1 — confidence in the chosen category, not in guilt
  reasoning: string;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

const SYSTEM_INSTRUCTION = `You evaluate a Reddit user's brief reply to a moderator's request that they explain how they wrote a flagged submission.

Your job is to categorize the REPLY, not the original content. Return STRICT JSON:
{
  "category": one of "genuine" | "evasive" | "non-response" | "ai-generated-reply" | "uncertain",
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence"
}

Definitions:
- "genuine": the user describes their own thought process, personal context, or how they wrote it (e.g. "I wrote this after my own experience with X", "I'm a nurse and I see this all the time"). Brevity is fine — a one-line genuine reply still counts as genuine.
- "evasive": the user dodges the question, deflects to "why are you accusing me?", changes the subject, or refuses to answer without a personal explanation.
- "non-response": the user did not address the question at all — purely emotional response, abuse, or off-topic.
- "ai-generated-reply": the reply itself looks LLM-generated — formulaic language, excessive em-dashes, "as an AI" disclaimers, hedging boilerplate. ONLY pick this if the reply has structural AI markers, not just because it's well-written.
- "uncertain": you genuinely can't tell. Default to this for short or ambiguous replies. Better to be uncertain than to penalize a sincere user.

Be CONSERVATIVE. Non-native-English replies are not "ai-generated" or "evasive". Real users often write short, awkward, or emotional responses — those are still "genuine" if they describe context.

Output JSON ONLY, no markdown fences.`;

interface GeminiPart {
  text?: string;
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

interface ParsedClassification {
  category?: ReplyCategory | string;
  confidence?: number;
  reasoning?: string;
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function normalizeCategory(s: string | undefined): ReplyCategory {
  switch ((s ?? "").toLowerCase().trim()) {
    case "genuine":
      return "genuine";
    case "evasive":
      return "evasive";
    case "non-response":
    case "nonresponse":
    case "off-topic":
      return "non-response";
    case "ai-generated-reply":
    case "ai-generated":
    case "ai":
      return "ai-generated-reply";
    default:
      return "uncertain";
  }
}

function safeParse(raw: string): ParsedClassification {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    return JSON.parse(trimmed) as ParsedClassification;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as ParsedClassification;
      } catch {
        return {};
      }
    }
    return {};
  }
}

export async function classifyReply(
  apiKey: string,
  args: { originalScore: number; topReasons: string[]; replyText: string },
): Promise<ReplyClassification> {
  const start = Date.now();
  const user =
    `Original Slopguard score: ${(args.originalScore * 100).toFixed(0)}%\n` +
    `Reasons given to author:\n${args.topReasons.map(r => `- ${r}`).join("\n") || "(none)"}\n\n` +
    `Author's reply:\n---\n${args.replyText.slice(0, 4000)}\n---`;

  try {
    const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 200,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        category: "uncertain",
        confidence: 0,
        reasoning: `Gemini error ${res.status}: ${body.slice(0, 200)}`,
        latencyMs: Date.now() - start,
        costUsd: 0,
        error: `http_${res.status}`,
      };
    }

    const data = (await res.json()) as GeminiResponse;
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = safeParse(raw);

    const inTok = data.usageMetadata?.promptTokenCount ?? 0;
    const outTok = data.usageMetadata?.candidatesTokenCount ?? 0;
    const costUsd = inTok * COST_INPUT_PER_TOKEN + outTok * COST_OUTPUT_PER_TOKEN;

    return {
      category: normalizeCategory(
        typeof parsed.category === "string" ? parsed.category : undefined,
      ),
      confidence: clamp01(parsed.confidence),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      latencyMs: Date.now() - start,
      costUsd,
    };
  } catch (err) {
    return {
      category: "uncertain",
      confidence: 0,
      reasoning: `Gemini exception: ${(err as Error).message}`,
      latencyMs: Date.now() - start,
      costUsd: 0,
      error: "exception",
    };
  }
}

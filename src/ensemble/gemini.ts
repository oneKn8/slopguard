import type { ProviderScore } from "../types.js";

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Pricing as of 2026 (Gemini 2.5 Flash).
// Gemini 2.0 Flash is deprecated (shutdown June 1, 2026) — using 2.5 Flash.
const COST_INPUT_PER_TOKEN = 0.3 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 2.5 / 1_000_000;

const SYSTEM_INSTRUCTION = `You evaluate Reddit submissions for whether they were written by an AI/LLM.

Return STRICT JSON with this exact shape, nothing else:
{
  "score": <number from 0.0 to 1.0, where 1.0 = certainly AI-written, 0.0 = certainly human-written>,
  "reasoning": "<one or two sentences explaining the call>",
  "signals": ["<short tags like 'em-dash overuse', 'formulaic intro', 'em-dash + listing', 'overly hedged', 'lexical bursting', 'enumerated structure', 'repetition of "delve/realm"', 'no personal voice', 'natural typos', 'idiomatic slang', 'imperfect punctuation', 'human authentic'>"]
}

Score conservatively. A score above 0.85 means very high confidence. Avoid flagging non-native English as AI; look for STRUCTURE markers, not surface fluency. Output JSON ONLY, no markdown fences.`;

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

export async function scoreWithGemini(
  apiKey: string,
  text: string,
): Promise<ProviderScore> {
  const start = Date.now();
  const userPrompt = `Evaluate this Reddit submission:\n\n---\n${text}\n---`;

  try {
    const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 300,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        model: "gemini-flash",
        score: 0,
        reasoning: `Gemini error ${res.status}: ${body.slice(0, 200)}`,
        signals: [],
        latencyMs: Date.now() - start,
        costUsd: 0,
        error: `http_${res.status}`,
      };
    }

    const data = (await res.json()) as GeminiResponse;
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = safeParseJson(raw);

    const inTok = data.usageMetadata?.promptTokenCount ?? 0;
    const outTok = data.usageMetadata?.candidatesTokenCount ?? 0;
    const costUsd = inTok * COST_INPUT_PER_TOKEN + outTok * COST_OUTPUT_PER_TOKEN;

    return {
      model: "gemini-flash",
      score: clamp01(parsed.score),
      reasoning: parsed.reasoning ?? "",
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      latencyMs: Date.now() - start,
      costUsd,
    };
  } catch (err) {
    return {
      model: "gemini-flash",
      score: 0,
      reasoning: `Gemini exception: ${(err as Error).message}`,
      signals: [],
      latencyMs: Date.now() - start,
      costUsd: 0,
      error: "exception",
    };
  }
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

interface ParsedScore {
  score?: number;
  reasoning?: string;
  signals?: string[];
}

function safeParseJson(raw: string): ParsedScore {
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(trimmed) as ParsedScore;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as ParsedScore;
      } catch {
        return {};
      }
    }
    return {};
  }
}

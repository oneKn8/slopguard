import type { ProviderScore } from "../types.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

const COST_INPUT_PER_TOKEN = 0.15 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 0.6 / 1_000_000;

const SYSTEM = `You evaluate Reddit submissions for whether they were written by an AI/LLM. Return JSON only: {"score": <0.0-1.0>, "reasoning": "<1-2 sentences>", "signals": ["<tag>"]}. Score conservatively; >0.85 = very high confidence. Look for STRUCTURE markers (em-dash overuse, formulaic intros, enumerated structure, "delve/realm/tapestry", overly hedged, no personal voice), not surface fluency.`;

interface OpenAIChoice {
  message?: { content?: string };
}
interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}
interface ParsedScore {
  score?: number;
  reasoning?: string;
  signals?: string[];
}

export async function scoreWithOpenAi(
  apiKey: string,
  text: string,
): Promise<ProviderScore> {
  const start = Date.now();

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Evaluate this Reddit submission:\n\n---\n${text}\n---`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        model: "gpt-4o-mini",
        score: 0,
        reasoning: `OpenAI error ${res.status}: ${body.slice(0, 200)}`,
        signals: [],
        latencyMs: Date.now() - start,
        costUsd: 0,
        error: `http_${res.status}`,
      };
    }

    const data = (await res.json()) as OpenAIResponse;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseJson(raw);

    const inTok = data.usage?.prompt_tokens ?? 0;
    const outTok = data.usage?.completion_tokens ?? 0;
    const costUsd =
      inTok * COST_INPUT_PER_TOKEN + outTok * COST_OUTPUT_PER_TOKEN;

    return {
      model: "gpt-4o-mini",
      score: clamp01(parsed.score),
      reasoning: parsed.reasoning ?? "",
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      latencyMs: Date.now() - start,
      costUsd,
    };
  } catch (err) {
    return {
      model: "gpt-4o-mini",
      score: 0,
      reasoning: `OpenAI exception: ${(err as Error).message}`,
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

import type { ProviderScore } from "../types.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

const COST_INPUT_PER_TOKEN = 0.8 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 4 / 1_000_000;

const SYSTEM = `You evaluate Reddit submissions for whether they were written by an AI/LLM.

Return STRICT JSON only:
{"score": <0.0-1.0>, "reasoning": "<1-2 sentences>", "signals": ["<tag>", ...]}

Score conservatively. Above 0.85 = very high confidence. Avoid flagging non-native English as AI; look for STRUCTURE markers, not surface fluency.`;

interface AnthropicContent {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content?: AnthropicContent[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

interface ParsedScore {
  score?: number;
  reasoning?: string;
  signals?: string[];
}

export async function scoreWithClaude(
  apiKey: string,
  text: string,
): Promise<ProviderScore> {
  const start = Date.now();

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0.1,
        system: SYSTEM,
        messages: [
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
        model: "claude-haiku",
        score: 0,
        reasoning: `Claude error ${res.status}: ${body.slice(0, 200)}`,
        signals: [],
        latencyMs: Date.now() - start,
        costUsd: 0,
        error: `http_${res.status}`,
      };
    }

    const data = (await res.json()) as AnthropicResponse;
    const raw =
      data.content?.find(c => c.type === "text")?.text ?? "";
    const parsed = safeParseJson(raw);

    const inTok = data.usage?.input_tokens ?? 0;
    const outTok = data.usage?.output_tokens ?? 0;
    const costUsd =
      inTok * COST_INPUT_PER_TOKEN + outTok * COST_OUTPUT_PER_TOKEN;

    return {
      model: "claude-haiku",
      score: clamp01(parsed.score),
      reasoning: parsed.reasoning ?? "",
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      latencyMs: Date.now() - start,
      costUsd,
    };
  } catch (err) {
    return {
      model: "claude-haiku",
      score: 0,
      reasoning: `Claude exception: ${(err as Error).message}`,
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

import type { TriggerContext, Context, SettingsValues } from "@devvit/public-api";
import type { EnsembleScore, ProviderScore } from "../types.js";
import { AppSetting } from "../settings.js";
import { addToDailySpend, getDailySpend } from "../redis.js";
import { fuse, isUncertain } from "./scoring.js";
import { scoreWithGemini } from "./gemini.js";
import { scoreWithClaude } from "./claude.js";
import { scoreWithOpenAi } from "./openai.js";

export interface ScoreOptions {
  itemId: string;
  itemType: "post" | "comment";
  authorName: string;
  text: string;
  forceEscalation?: boolean; // e.g. when called from a report — pay more
}

export async function scoreItem(
  ctx: TriggerContext | Context,
  settings: SettingsValues,
  opts: ScoreOptions,
): Promise<EnsembleScore | null> {
  const text = opts.text.trim();
  if (text.length < 25) return null;

  const maxSpend = (settings[AppSetting.MaxDailySpendUsd] as number) ?? 1;
  const spent = await getDailySpend(ctx);
  if (spent >= maxSpend) {
    console.log(`Slopguard: daily spend $${spent.toFixed(4)} >= cap $${maxSpend}. Skipping.`);
    return null;
  }

  const useGemini = settings[AppSetting.UseGemini] !== false;
  const useClaude = settings[AppSetting.UseClaude] === true;
  const useOpenAi = settings[AppSetting.UseOpenAi] === true;

  const geminiKey = (settings[AppSetting.GeminiApiKey] as string) ?? "";
  const claudeKey = (settings[AppSetting.AnthropicApiKey] as string) ?? "";
  const openaiKey = (settings[AppSetting.OpenAiApiKey] as string) ?? "";

  const providers: ProviderScore[] = [];

  // First pass: Gemini (cheap, always)
  if (useGemini && geminiKey) {
    const g = await scoreWithGemini(geminiKey, text);
    providers.push(g);
    await addToDailySpend(ctx, g.costUsd);
  }

  // Decide whether to escalate
  const firstScore = providers[0]?.score ?? 0;
  const shouldEscalate =
    opts.forceEscalation || isUncertain(firstScore) || providers.length === 0;

  if (shouldEscalate) {
    const escalations: Promise<ProviderScore>[] = [];
    if (useClaude && claudeKey) escalations.push(scoreWithClaude(claudeKey, text));
    if (useOpenAi && openaiKey) escalations.push(scoreWithOpenAi(openaiKey, text));

    if (escalations.length > 0) {
      const results = await Promise.all(escalations);
      for (const r of results) {
        providers.push(r);
        await addToDailySpend(ctx, r.costUsd);
      }
    }
  }

  if (providers.length === 0) return null;

  return fuse(providers, {
    itemId: opts.itemId,
    itemType: opts.itemType,
    authorName: opts.authorName,
  });
}

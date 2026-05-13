import type { SettingsFormField, SettingsValues } from "@devvit/public-api";
import type { PolicyMode } from "./types.js";

export enum AppSetting {
  // Provider keys
  GeminiApiKey = "geminiApiKey",
  AnthropicApiKey = "anthropicApiKey",
  OpenAiApiKey = "openAiApiKey",

  // Behavior
  PolicyMode = "policyMode",
  FlagThreshold = "flagThreshold",
  AutoRemoveEnabled = "autoRemoveEnabled",
  AutoRemoveThreshold = "autoRemoveThreshold",

  // Hybrid local-first triage
  UseLlmEscalation = "useLlmEscalation",
  LlmEscalationLow = "llmEscalationLow",
  LlmEscalationHigh = "llmEscalationHigh",

  // Provider selection
  UseGemini = "useGemini",
  UseClaude = "useClaude",
  UseOpenAi = "useOpenAi",

  // Cost discipline
  MaxDailySpendUsd = "maxDailySpendUsd",
  MaxKarmaToCheck = "maxKarmaToCheck",
  IgnoreApprovedUsers = "ignoreApprovedUsers",
  MinAccountAgeDaysToSkip = "minAccountAgeDaysToSkip",

  // Templates
  RemovalReasonTemplate = "removalReasonTemplate",
  RemovalReplyTemplate = "removalReplyTemplate",

  // Metrics post
  EnableDailyMetricsPost = "enableDailyMetricsPost",
}

export function getPolicyMode(settings: SettingsValues): PolicyMode {
  const raw = settings[AppSetting.PolicyMode];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === "verify" || first === "strict") return first;
  return "advisory";
}

export function buildSettings(): SettingsFormField[] {
  return [
    {
      type: "group",
      label: "API keys (Gemini is required; Claude + OpenAI optional)",
      fields: [
        {
          type: "string",
          name: AppSetting.GeminiApiKey,
          label: "Gemini API key",
          helpText:
            "Required. Get a free key at https://aistudio.google.com/apikey — generous free tier.",
          isSecret: true,
          scope: "installation",
        },
        {
          type: "string",
          name: AppSetting.AnthropicApiKey,
          label: "Anthropic API key (optional)",
          helpText:
            "Adds Claude to the ensemble for higher accuracy on uncertain cases. https://console.anthropic.com",
          isSecret: true,
          scope: "installation",
        },
        {
          type: "string",
          name: AppSetting.OpenAiApiKey,
          label: "OpenAI API key (optional)",
          helpText:
            "Adds GPT-4o-mini to the ensemble as a tiebreaker. https://platform.openai.com/api-keys",
          isSecret: true,
          scope: "installation",
        },
      ],
    },
    {
      type: "group",
      label: "Policy mode",
      fields: [
        {
          type: "select",
          name: AppSetting.PolicyMode,
          label: "Policy mode",
          helpText:
            "Advisory: flag only, mods decide (recommended). Verify: also DM the author for a brief reply on high-confidence flags. Strict: also auto-remove at very high confidence.",
          options: [
            { label: "Advisory (flag only)", value: "advisory" },
            { label: "Verify (flag + author DM)", value: "verify" },
            { label: "Strict (flag + DM + auto-remove)", value: "strict" },
          ],
          defaultValue: ["advisory"],
          multiSelect: false,
        },
        {
          type: "number",
          name: AppSetting.FlagThreshold,
          label: "Flag threshold (0.0–1.0)",
          helpText: "Combined score above this surfaces the review card to mods.",
          defaultValue: 0.6,
        },
        {
          type: "boolean",
          name: AppSetting.AutoRemoveEnabled,
          label: "Auto-remove enabled (Strict mode only)",
          helpText:
            "Has no effect unless policy mode = Strict. Off by default — recommended to flag-only first.",
          defaultValue: false,
        },
        {
          type: "number",
          name: AppSetting.AutoRemoveThreshold,
          label: "Auto-remove threshold (0.0–1.0)",
          helpText: "Only used in Strict mode with auto-remove enabled.",
          defaultValue: 0.92,
        },
      ],
    },
    {
      type: "group",
      label: "LLM escalation (optional, costs money)",
      fields: [
        {
          type: "boolean",
          name: AppSetting.UseLlmEscalation,
          label: "Escalate uncertain cases to LLM",
          helpText:
            "Off = pure local signals (free, fast, deterministic). On = items whose local score lands in the gray band also get scored by Gemini/Claude/OpenAI for a tiebreaker. Requires API keys.",
          defaultValue: false,
        },
        {
          type: "number",
          name: AppSetting.LlmEscalationLow,
          label: "Escalation band lower bound (0.0–1.0)",
          helpText: "Local scores at or above this trigger LLM escalation.",
          defaultValue: 0.4,
        },
        {
          type: "number",
          name: AppSetting.LlmEscalationHigh,
          label: "Escalation band upper bound (0.0–1.0)",
          helpText: "Local scores at or below this trigger LLM escalation. Above this we trust local.",
          defaultValue: 0.75,
        },
      ],
    },
    {
      type: "group",
      label: "Models",
      fields: [
        {
          type: "boolean",
          name: AppSetting.UseGemini,
          label: "Use Gemini Flash (primary)",
          defaultValue: true,
        },
        {
          type: "boolean",
          name: AppSetting.UseClaude,
          label: "Use Claude Haiku (escalation)",
          defaultValue: false,
        },
        {
          type: "boolean",
          name: AppSetting.UseOpenAi,
          label: "Use GPT-4o-mini (escalation)",
          defaultValue: false,
        },
      ],
    },
    {
      type: "group",
      label: "Cost discipline",
      fields: [
        {
          type: "number",
          name: AppSetting.MaxDailySpendUsd,
          label: "Max daily LLM spend (USD)",
          helpText: "Halts non-mandatory checks when reached. Default $1/day.",
          defaultValue: 1,
        },
        {
          type: "number",
          name: AppSetting.MaxKarmaToCheck,
          label: "Only check users below this karma",
          helpText: "Saves cost by skipping established users. Set 0 to check everyone.",
          defaultValue: 5000,
        },
        {
          type: "boolean",
          name: AppSetting.IgnoreApprovedUsers,
          label: "Skip approved submitters",
          defaultValue: true,
        },
        {
          type: "number",
          name: AppSetting.MinAccountAgeDaysToSkip,
          label: "Skip accounts older than (days)",
          helpText: "Set 0 to check all ages.",
          defaultValue: 365,
        },
      ],
    },
    {
      type: "group",
      label: "Templates",
      fields: [
        {
          type: "paragraph",
          name: AppSetting.RemovalReasonTemplate,
          label: "Removal reason (mod-facing)",
          defaultValue:
            "Slopguard flagged this submission as AI-generated (score {{score}}). Models in agreement: {{models}}.",
        },
        {
          type: "paragraph",
          name: AppSetting.RemovalReplyTemplate,
          label: "Reply to user (visible)",
          defaultValue:
            "Hi {{author}}, your submission was removed because it was flagged as AI-generated content, which is not permitted in r/{{subreddit}}. If you believe this was in error, please respond in modmail with a brief explanation of how you wrote this. — r/{{subreddit}} mods (via Slopguard)",
        },
      ],
    },
    {
      type: "group",
      label: "Metrics",
      fields: [
        {
          type: "boolean",
          name: AppSetting.EnableDailyMetricsPost,
          label: "Post daily metrics summary (mod-only sticky)",
          defaultValue: true,
        },
      ],
    },
  ];
}

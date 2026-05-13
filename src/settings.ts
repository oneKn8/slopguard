import type { SettingsFormField } from "@devvit/public-api";

export enum AppSetting {
  // Provider keys
  GeminiApiKey = "geminiApiKey",
  AnthropicApiKey = "anthropicApiKey",
  OpenAiApiKey = "openAiApiKey",

  // Behavior
  FlagThreshold = "flagThreshold",
  AutoRemoveEnabled = "autoRemoveEnabled",
  AutoRemoveThreshold = "autoRemoveThreshold",

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
      label: "Behavior",
      fields: [
        {
          type: "number",
          name: AppSetting.FlagThreshold,
          label: "Flag threshold (0.0–1.0)",
          helpText: "Score above this surfaces the AI badge on the post.",
          defaultValue: 0.6,
        },
        {
          type: "boolean",
          name: AppSetting.AutoRemoveEnabled,
          label: "Auto-remove enabled",
          helpText:
            "If on, posts above the auto-remove threshold are removed automatically. Off by default — recommended to flag-only first.",
          defaultValue: false,
        },
        {
          type: "number",
          name: AppSetting.AutoRemoveThreshold,
          label: "Auto-remove threshold (0.0–1.0)",
          helpText: "Only used if auto-remove is enabled.",
          defaultValue: 0.92,
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

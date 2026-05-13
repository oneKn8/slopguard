import { Devvit } from "@devvit/public-api";
import { buildSettings } from "./settings.js";
import { onPostCreate } from "./triggers/onPostCreate.js";
import { onCommentCreate } from "./triggers/onCommentCreate.js";
import { onPostReport } from "./triggers/onPostReport.js";
import { explainScoreFromMenu } from "./menu/explainScore.js";
import { removeAsAiFromMenu } from "./menu/removeAsAI.js";
import { showMetricsFromMenu } from "./menu/showMetrics.js";
import { analyzeWithSlopguardFromMenu } from "./menu/analyzeWithSlopguard.js";
import { claimReviewFromMenu } from "./menu/claimReview.js";
import {
  dailyMetricsHandler,
  DAILY_METRICS_JOB,
} from "./scheduler/dailyMetricsPost.js";

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

Devvit.addSettings(buildSettings());

Devvit.addTrigger({
  event: "PostCreate",
  onEvent: onPostCreate,
});

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: onCommentCreate,
});

Devvit.addTrigger({
  event: "PostReport",
  onEvent: onPostReport,
});

Devvit.addTrigger({
  events: ["AppInstall", "AppUpgrade"],
  onEvent: async (_event, context) => {
    try {
      await context.scheduler.runJob({
        name: DAILY_METRICS_JOB,
        cron: "0 13 * * *", // 13:00 UTC ≈ 8am Central daily summary
      });
      console.log("Slopguard: scheduled daily metrics job.");
    } catch (e) {
      console.warn(`Slopguard: scheduler init failed: ${(e as Error).message}`);
    }
  },
});

Devvit.addSchedulerJob({
  name: DAILY_METRICS_JOB,
  onRun: dailyMetricsHandler,
});

Devvit.addMenuItem({
  location: "post",
  forUserType: "moderator",
  label: "Slopguard: Explain AI score",
  onPress: explainScoreFromMenu,
});

Devvit.addMenuItem({
  location: "comment",
  forUserType: "moderator",
  label: "Slopguard: Explain AI score",
  onPress: explainScoreFromMenu,
});

Devvit.addMenuItem({
  location: "post",
  forUserType: "moderator",
  label: "Slopguard: Remove as AI slop",
  onPress: removeAsAiFromMenu,
});

Devvit.addMenuItem({
  location: "comment",
  forUserType: "moderator",
  label: "Slopguard: Remove as AI slop",
  onPress: removeAsAiFromMenu,
});

Devvit.addMenuItem({
  location: "post",
  forUserType: "moderator",
  label: "Slopguard: Analyze this post",
  onPress: analyzeWithSlopguardFromMenu,
});

Devvit.addMenuItem({
  location: "comment",
  forUserType: "moderator",
  label: "Slopguard: Analyze this comment",
  onPress: analyzeWithSlopguardFromMenu,
});

Devvit.addMenuItem({
  location: "post",
  forUserType: "moderator",
  label: "Slopguard: Claim review (or release)",
  onPress: claimReviewFromMenu,
});

Devvit.addMenuItem({
  location: "comment",
  forUserType: "moderator",
  label: "Slopguard: Claim review (or release)",
  onPress: claimReviewFromMenu,
});

Devvit.addMenuItem({
  location: "subreddit",
  forUserType: "moderator",
  label: "Slopguard: Show today's metrics",
  onPress: showMetricsFromMenu,
});

export default Devvit;

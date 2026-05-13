import { Devvit } from "@devvit/public-api";
import { buildSettings } from "./settings.js";
import { onPostCreate } from "./triggers/onPostCreate.js";
import { onCommentCreate } from "./triggers/onCommentCreate.js";
import { onPostReport } from "./triggers/onPostReport.js";
import { onModMail } from "./triggers/onModMail.js";
import { explainScoreFromMenu } from "./menu/explainScore.js";
import { removeAsAiFromMenu } from "./menu/removeAsAI.js";
import { showMetricsFromMenu } from "./menu/showMetrics.js";
import { analyzeWithSlopguardFromMenu } from "./menu/analyzeWithSlopguard.js";
import { claimReviewFromMenu } from "./menu/claimReview.js";
import { createDashboardPostFromMenu } from "./menu/createDashboardPost.js";
import { registerDashboard } from "./customPost/dashboard.js";
import {
  dailyMetricsHandler,
  DAILY_METRICS_JOB,
} from "./scheduler/dailyMetricsPost.js";
import {
  federationPublishHandler,
  FEDERATION_PUBLISH_JOB,
} from "./scheduler/federationPublish.js";
import {
  auditFederationFromMenu,
  clearFederationOutboxFromMenu,
  publishFederationNowFromMenu,
} from "./menu/federation.js";

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true,
});

Devvit.addSettings(buildSettings());

registerDashboard();

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
  event: "ModMail",
  onEvent: onModMail,
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
    try {
      await context.scheduler.runJob({
        name: FEDERATION_PUBLISH_JOB,
        cron: "0 */6 * * *", // every 6h
      });
      console.log("Slopguard: scheduled federation publish job.");
    } catch (e) {
      console.warn(`Slopguard: federation scheduler init failed: ${(e as Error).message}`);
    }
  },
});

Devvit.addSchedulerJob({
  name: DAILY_METRICS_JOB,
  onRun: dailyMetricsHandler,
});

Devvit.addSchedulerJob({
  name: FEDERATION_PUBLISH_JOB,
  onRun: federationPublishHandler,
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

Devvit.addMenuItem({
  location: "subreddit",
  forUserType: "moderator",
  label: "Slopguard: Create dashboard post",
  onPress: createDashboardPostFromMenu,
});

Devvit.addMenuItem({
  location: "subreddit",
  forUserType: "moderator",
  label: "Slopguard: Audit federation outbox",
  onPress: auditFederationFromMenu,
});

Devvit.addMenuItem({
  location: "subreddit",
  forUserType: "moderator",
  label: "Slopguard: Publish federation now",
  onPress: publishFederationNowFromMenu,
});

Devvit.addMenuItem({
  location: "subreddit",
  forUserType: "moderator",
  label: "Slopguard: Clear federation outbox",
  onPress: clearFederationOutboxFromMenu,
});

export default Devvit;

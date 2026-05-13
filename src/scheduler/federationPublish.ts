import type { ScheduledJobEvent, JobContext } from "@devvit/public-api";
import { publishCycle } from "../lib/federation.js";

export const FEDERATION_PUBLISH_JOB = "slopguardFederationPublish";

export async function federationPublishHandler(
  _event: ScheduledJobEvent<undefined>,
  context: JobContext,
): Promise<void> {
  try {
    const settings = await context.settings.getAll();
    const res = await publishCycle(context, settings as Record<string, unknown>);
    console.log(
      `Slopguard federation cycle: ok=${res.ok} published=${res.published} received=${res.received}${res.reason ? ` (${res.reason})` : ""}`,
    );
  } catch (err) {
    console.warn(
      `Slopguard federation cycle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

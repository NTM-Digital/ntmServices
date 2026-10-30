import { videoDescriptionController } from "../controllers/videoDescriptionController.js";

const SYNC_INTERVAL = 24 * 60 * 60; // 24 hours in seconds

/** The project whose new uploads get described. */
const PROJECT_NAME = "Kids";

/**
 * Deliberately twice the sync interval. Overlap costs nothing — the query skips any
 * video that already has rows — so a wider window simply absorbs a late run, a
 * restart, or a video published right on the boundary, instead of losing it.
 */
const LOOKBACK_HOURS = 48;

/**
 * Ceiling on one run, not an expectation: the Kids project publishes roughly 27
 * videos a day, so this is slack for a burst or a day missed to a restart. It also
 * stops a mistake in the lookback window from turning into a backfill by accident.
 */
const MAX_VIDEOS_PER_RUN = 100;

/** Second guard on the same risk, in money rather than count. ~27 videos is ~$1.80. */
const MAX_SPEND_PER_RUN_USD = 15;

class VideoDescriptionService {
  private running = false;

  async startSync() {
    console.log("Video description service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async performSync() {
    try {
      console.log("Performing video description sync...");
      const summary = await videoDescriptionController.describeNewestInProject(
        PROJECT_NAME,
        MAX_VIDEOS_PER_RUN,
        { publishedSinceHours: LOOKBACK_HOURS, maxSpendUsd: MAX_SPEND_PER_RUN_USD },
      );
      console.log(
        `Video description sync completed: ${summary.processed} described, `
        + `${summary.failed} failed, $${summary.totalCostUsd.toFixed(4)} spent.`
      );
    } catch (error) {
      // Swallowed on purpose, as in the other services: a failed cycle must not break
      // the loop, and anything that failed has no description, so the next run retries
      // it anyway.
      console.error("Video description sync failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping video description service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const videoDescriptionService = new VideoDescriptionService();

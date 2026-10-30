import { videoDescriptionController } from "../controllers/videoDescriptionController.js";

/**
 * One-shot backfill of descriptions for a project's existing catalogue.
 *
 * Unlike every other service here this does not loop forever — it works through the
 * backlog in batches and then returns, because it exists to be run once. It is off
 * unless RUN_DESCRIPTION_BACKFILL is set (see index.ts), since on the Kids project it
 * means roughly 24,000 videos and four figures of spend.
 *
 * It is also safe to stop and restart at any point: each batch re-queries for videos
 * that still have no description, so nothing is redone and nothing is lost.
 */

/** The project to work through. */
const PROJECT_NAME = "Kids";

/**
 * Videos per batch. Each batch is one query plus that many analyses, so the only
 * reason not to make this huge is that the spend ceiling is checked between batches
 * as well as between videos.
 */
const BATCH_SIZE = 50;

/**
 * Total spend ceiling across the whole run, in USD. Deliberately far below the ~$1,580
 * the full Kids catalogue would cost, so an unattended run cannot quietly empty the
 * account — raise it on purpose once a batch or two has confirmed the economics.
 */
const MAX_SPEND_USD = 50;

/** Breather between batches, so the shared connection pool and the API both get air. */
const PAUSE_BETWEEN_BATCHES_SECONDS = 30;

class VideoDescriptionBackfillService {
  private running = false;

  async startSync() {
    console.log(`Video description backfill started for project "${PROJECT_NAME}" (ceiling $${MAX_SPEND_USD}).`);
    this.running = true;

    let totalProcessed = 0;
    let totalFailed = 0;
    let totalCostUsd = 0;

    while (this.running) {
      const remainingBudget = MAX_SPEND_USD - totalCostUsd;
      if (remainingBudget <= 0) {
        console.log(`Backfill stopping: spend ceiling of $${MAX_SPEND_USD} reached.`);
        break;
      }

      const summary = await this.performBatch(remainingBudget);
      if (!summary) break;

      totalProcessed += summary.processed;
      totalFailed += summary.failed;
      totalCostUsd += summary.totalCostUsd;

      // Nothing attempted means the query found no more candidates, so the backlog is
      // clear and there is nothing to come back for.
      if (summary.processed === 0 && summary.failed === 0) {
        console.log("Backfill stopping: no videos left without descriptions.");
        break;
      }

      console.log(
        `Backfill progress: ${totalProcessed} described, ${totalFailed} failed, `
        + `$${totalCostUsd.toFixed(2)} of $${MAX_SPEND_USD} spent.`
      );
      await this.sleep(PAUSE_BETWEEN_BATCHES_SECONDS);
    }

    this.running = false;
    console.log(
      `Video description backfill finished: ${totalProcessed} described, ${totalFailed} failed, `
      + `$${totalCostUsd.toFixed(4)} spent. Re-run to continue where this left off.`
    );
  }

  /** Returns the batch summary, or null if the batch itself failed. */
  private async performBatch(remainingBudget: number) {
    try {
      return await videoDescriptionController.describeNewestInProject(
        PROJECT_NAME,
        BATCH_SIZE,
        { maxSpendUsd: remainingBudget },
      );
    } catch (error) {
      // A batch-level failure is the query or the database, not one video — those are
      // handled per video inside the controller. Retrying would most likely fail the
      // same way, so this stops and leaves the rest for the next run.
      console.error("Video description backfill batch failed, stopping:", error);
      return null;
    }
  }

  stopSync() {
    console.log("Stopping video description backfill...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const videoDescriptionBackfillService = new VideoDescriptionBackfillService();

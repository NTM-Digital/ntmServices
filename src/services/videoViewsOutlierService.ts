import { syncVideoCreatorsAndFilmingDates } from "../controllers/databasesSyncController.js";

const SYNC_INTERVAL = 24 * 60 * 60; // 24 hours in seconds

class VideoViewsOutlierService {
  private running = false;

  async startSync() {
    console.log("Video views outlier service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async performSync() {
    try {
      console.log("Performing video views outlier sync...");
      await syncVideoCreatorsAndFilmingDates();
      console.log("Video views outlier sync completed.");
    } catch (error) {
      console.error("Video views outlier sync failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping video views outlier service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const videoViewsOutlierService = new VideoViewsOutlierService();

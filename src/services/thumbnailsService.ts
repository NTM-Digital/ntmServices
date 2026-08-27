import { thumbnailsController } from "../controllers/thumbnailsController.js";

const SYNC_INTERVAL = 2 * 60 * 60; // 2 hours in seconds

class ThumbnailsService {
  private running = false;

  async startSync() {
    console.log("Thumbnails service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async performSync() {
    try {
      console.log("Performing thumbnails sync...");
      await thumbnailsController.syncThumbnailsForRecentVideos();
      console.log("Thumbnails sync completed.");
    } catch (error) {
      console.error("Thumbnails sync failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping thumbnails service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const thumbnailsService = new ThumbnailsService();

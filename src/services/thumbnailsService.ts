import { thumbnailsController } from "../controllers/thumbnailsController.js";

// The rotation waits on a 15 minute publishing window, so it needs to be checked a good deal
// more often than that for a thumbnail to be swapped out shortly after its window is up.
const SYNC_INTERVAL = 5 * 60; // 5 minutes in seconds

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

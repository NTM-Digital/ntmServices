import { trelloGDriveSyncController } from "../controllers/trelloGDriveSyncController.js";

const SYNC_INTERVAL = 60; // 1 minute in seconds

class TrelloGDriveSyncService {
  private running = false;

  async startSync() {
    console.log("Google Drive - Trello sync service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async performSync() {
    try {
      console.log("Performing Google Drive - Trello sync...");
      await trelloGDriveSyncController.syncGdriveWithTrello();
      console.log("Google Drive - Trello sync completed.");
    } catch (error) {
      console.error("Google Drive - Trello sync failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping Google Drive - Trello sync service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const trelloGDriveSyncService = new TrelloGDriveSyncService();

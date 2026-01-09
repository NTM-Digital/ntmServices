import { syncVideoCreatorsAndFilmingDates } from "../controllers/databasesSyncController.js";

const SYNC_INTERVAL = 5 * 60; // 5 minutes in seconds

class DatabasesSyncService {
  private running = false;

  async startSync() {
    console.log("Database sync service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async performSync() {
    try {
      console.log("Performing database sync...");
      await syncVideoCreatorsAndFilmingDates();
      console.log("Database sync completed.");
    } catch (error) {
      console.error("Database sync failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping database sync service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const databasesSyncService = new DatabasesSyncService();

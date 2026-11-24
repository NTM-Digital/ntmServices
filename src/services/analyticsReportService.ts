import { analyticsReportController } from "../controllers/analyticsReportController.js";
import { analyticsReportTablesExist } from "../datasources/ntmDataDatasource.js";

// Reports land once a day, but not at a predictable hour, and a newly created job takes
// up to 48 hours to produce its first one - so there is nothing to gain from polling
// harder than this. Four passes a day keeps a fresh report from sitting for most of a
// day, and costs two jobs.reports.list calls per channel when there is nothing new.
const SYNC_INTERVAL = 6 * 60 * 60; // 6 hours in seconds

class AnalyticsReportService {
  private running = false;

  async startSync() {
    // The DDL in sql/analytics_report.sql is applied by hand, and this DB has parallel
    // public and dev schemas, so a deployment can easily be pointed at a schema that
    // never got it. Checking once here turns that into one loud line at startup rather
    // than a 42P01 every six hours, lost among seven other services' logs.
    if (!await this.tablesReady()) {
      return;
    }

    console.log("Analytics report service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async tablesReady(): Promise<boolean> {
    try {
      if (await analyticsReportTablesExist()) {
        return true;
      }
      console.error("Analytics report service not starting: the analytics_report tables are missing. Apply sql/analytics_report.sql to this schema.");
    } catch (error) {
      console.error("Analytics report service not starting: could not check for its tables:", error);
    }
    return false;
  }

  private async performSync() {
    try {
      console.log("Performing analytics report sync...");
      await analyticsReportController.importReports();
      console.log("Analytics report sync completed.");
    } catch (error) {
      console.error("Analytics report sync failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping analytics report service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const analyticsReportService = new AnalyticsReportService();

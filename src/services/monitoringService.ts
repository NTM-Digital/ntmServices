import { monitorController } from "../controllers/monitorController.js";

type MonitorData = {
  id: string;
  url: string;
  name: string;
  expected_response: any;
  check_interval: number;
  retry_interval: number;
};

class MonitoringService {
  private monitors: Map<string, Monitor> = new Map();

  async startMonitoring() {
    console.log("Monitoring service started.");

    // Load and start all monitors
    await this.reloadMonitors();

    // Listen for changes in the database
    await monitorController.listenForMonitorChanges((payload) => {
      console.log(`Received monitor change: ${payload.operation} for ID: ${payload.id}`);
      this.reloadMonitors();
    });
  }

  async reloadMonitors() {
    console.log("Reloading monitors...");

    // Stop all existing monitors
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();

    // Load fresh monitor data from database
    const { monitors } = await monitorController.getAllMonitors() as {
      monitors: MonitorData[];
    };

    console.log("URLs to monitor:", monitors.length);

    // Start new monitors
    for (const data of monitors) {
      const monitor = new Monitor(data);
      this.monitors.set(data.id, monitor);
      monitor.start(); // fire-and-forget
    }
  }

  async stopMonitoring() {
    console.log("Stopping monitoring service...");

    // Stop all monitors
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    this.monitors.clear();

    // Stop listening for database changes
    await monitorController.stopListeningForChanges();
  }
}

export const monitoringService = new MonitoringService();

/* ---------------- Monitor ---------------- */

class Monitor {
  private running = true;
  private currentErrorMessage: string | null = null;
  private isHandlingIncident = false;
  private consecutiveFailures = 0;

  constructor(private data: MonitorData) {}

  async start() {
    console.log(`Monitor started: ${this.data.name}`);
    let isFailing = false;
    while (this.running) {
      isFailing = await this.runCheck(isFailing);
    }
  }

  async runCheck(isFailing: boolean): Promise<boolean> {
    let errorMessage: string | null = null;
    let sleepTime = this.data.check_interval;

    // Update last check timestamp
    await monitorController.updateLastCheck(this.data.id);

    try {
      console.log(
        `Checking ${this.data.name} → ${this.data.url}`
      );

      const response = await fetch(this.data.url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });

      console.log(
        `[${this.data.name}] Status: ${response.status}`
      );

      if (response.status !== 200) {
        errorMessage = `Status code ${response.status}`;
        console.log(`[${this.data.name}] ALERT: ${errorMessage}`);
      } else {
        let responseBody;
        const contentType = response.headers.get("content-type");

        if (contentType && contentType.includes("application/json")) {
          try {
            responseBody = await response.json();
          } catch (err) {
            console.log(`[${this.data.name}] Failed to parse JSON response`);
            responseBody = null;
          }
        } else {
          responseBody = null;
        }

        const expectedStatus = this.data.expected_response;
        console.log(responseBody, expectedStatus);

        if (responseBody && expectedStatus.status === "ok" && responseBody.status !== "ok") {
          errorMessage = `Expected status "ok" but got "${responseBody.status}"`;
          console.log(`[${this.data.name}] ALERT: ${errorMessage}`);
        }
      }
    } catch (err) {
      errorMessage = `Check failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[${this.data.name}] ALERT: ${errorMessage}`);
    }

    // Update consecutive failures counter
    if (errorMessage) {
      this.consecutiveFailures++;
      sleepTime = this.data.retry_interval;
      console.log(`[${this.data.name}] Consecutive failures: ${this.consecutiveFailures}`);
    } else {
      this.consecutiveFailures = 0;
      sleepTime = this.data.check_interval;
    }

    // Handle incident management
    await this.handleIncident(isFailing, errorMessage);

    await this.sleep(sleepTime);
    return errorMessage !== null;
  }

  private async handleIncident(isFailing: boolean, errorMessage: string | null) {
    // Prevent concurrent incident handling
    if (this.isHandlingIncident) {
      return;
    }

    this.isHandlingIncident = true;

    try {
      // Only create incident if 2+ consecutive failures
      if (errorMessage && this.consecutiveFailures >= 2) {
        // Check if we need to create or update incident
        if (this.currentErrorMessage !== errorMessage) {
          // Error changed or new error
          if (this.currentErrorMessage !== null) {
            // Close the old incident if there was one
            const { incidents } = await monitorController.getOpenIncidentsByMonitorId(this.data.id);
            if (incidents && incidents.length > 0) {
              for (const incident of incidents) {
                await monitorController.closeIncident(incident.id);
              }
            }
            console.log(`[${this.data.name}] Error changed. Closed old incident and created new one: ${errorMessage}`);
          } else {
            console.log(`[${this.data.name}] Created new incident: ${errorMessage}`);
          }

          // Create new incident
          await monitorController.createIncident(this.data.id, errorMessage);
          this.currentErrorMessage = errorMessage;
        }
        // If error is the same as currentErrorMessage, do nothing
      } else if (isFailing && !errorMessage) {
        // Was failing, now resolved - close incidents
        if (this.currentErrorMessage !== null) {
          const { incidents } = await monitorController.getOpenIncidentsByMonitorId(this.data.id);

          if (incidents && incidents.length > 0) {
            for (const incident of incidents) {
              await monitorController.closeIncident(incident.id);
              console.log(`[${this.data.name}] Resolved incident: ${incident.error_message}`);
            }
          }

          this.currentErrorMessage = null;
        }
      }
    } finally {
      this.isHandlingIncident = false;
    }
  }

  stop() {
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}
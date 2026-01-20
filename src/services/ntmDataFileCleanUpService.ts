
const SYNC_INTERVAL = 24 * 60 * 60; // 24 hours in seconds

class NtmDataFileCleanUpService {
  private running = false;

  async startSync() {
    console.log("Ntm data file clean up service started.");
    this.running = true;

    while (this.running) {
      await this.performSync();
      await this.sleep(SYNC_INTERVAL);
    }
  }

  private async performSync() {
    try {
      console.log("Performing ntm data file clean up...");
      await fetch('https://data.ntmbase.com/api/media/cleanup', {
        method: 'GET',
        headers: {
          'x-api-key': process.env.NTM_DATA_PROTECTED_API_ENDPOINT_KEY!
        }
      });
      console.log("Ntm data file clean up completed.");
    } catch (error) {
      console.error("Ntm data file clean up failed:", error);
    }
  }

  stopSync() {
    console.log("Stopping ntm data file clean up service...");
    this.running = false;
  }

  private sleep(seconds: number) {
    return new Promise(resolve =>
      setTimeout(resolve, seconds * 1000)
    );
  }
}

export const ntmDataFileCleanUpService = new NtmDataFileCleanUpService();

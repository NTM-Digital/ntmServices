import { monitoringService } from './services/monitoringService.js';
import { databasesSyncService } from './services/databasesSyncService.js';
import { ntmDataFileCleanUpService } from './services/ntmDataFileCleanUpService.js';
import { videoViewsOutlierService } from './services/videoViewsOutlierService.js';
import { trelloGDriveSyncService } from './services/TrelloGDriveSyncService.js';
import { thumbnailsService } from './services/thumbnailsService.js';
import { videoDescriptionService } from './services/videoDescriptionService.js';
import { videoDescriptionBackfillService } from './services/videoDescriptionBackfillService.js';

// Start all services
export async function startServices() {
    console.log('Starting services...');

    // Start all services in parallel to avoid blocking
    const services = [
        monitoringService.startMonitoring(),
        databasesSyncService.startSync(),
        ntmDataFileCleanUpService.startSync(),
        videoViewsOutlierService.startSync(),
        trelloGDriveSyncService.startSync(),
        thumbnailsService.startSync(),
        // videoDescriptionService.startSync(),
    ];

    // The backfill is a one-off that costs four figures to run to completion, so it
    // only starts when explicitly asked for. It is listed here rather than commented
    // out so it stays wired up and compiled.
    //
    // Prefer running it in its own process (RUN_DESCRIPTION_BACKFILL=true npm start)
    // rather than alongside the daily services: it runs for days and holds connections
    // from the same pool the other services use.
    if (process.env.RUN_DESCRIPTION_BACKFILL === 'true') {
        services.push(videoDescriptionBackfillService.startSync());
    }

    await Promise.all(services);

    console.log('All services started.');
}

// Auto-start services when this module is imported
startServices().catch(error => {
    // Every service traps its own errors and loops forever, so a rejection here means
    // something failed outside those loops. Without this it would surface as a bare
    // unhandled rejection.
    console.error('Startup failed:', error);
    process.exit(1);
});

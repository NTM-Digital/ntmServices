import { monitoringService } from './services/monitoringService.js';
import { databasesSyncService } from './services/databasesSyncService.js';
import { ntmDataFileCleanUpService } from './services/ntmDataFileCleanUpService.js';
import { videoViewsOutlierService } from './services/videoViewsOutlierService.js';
import { trelloGDriveSyncService } from './services/TrelloGDriveSyncService.js';
import { thumbnailsService } from './services/thumbnailsService.js';

// Start all services
export async function startServices() {
    console.log('Starting services...');

    // Start all services in parallel to avoid blocking
    await Promise.all([
        monitoringService.startMonitoring(),
        databasesSyncService.startSync(),
        ntmDataFileCleanUpService.startSync(),
        videoViewsOutlierService.startSync(),
        trelloGDriveSyncService.startSync(),
        thumbnailsService.startSync(),
    ]);

    console.log('All services started.');
}

// Auto-start services when this module is imported
startServices();
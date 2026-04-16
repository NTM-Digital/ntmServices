import { monitoringService } from './services/monitoringService.js';
import { databasesSyncService } from './services/databasesSyncService.js';
import { ntmDataFileCleanUpService } from './services/ntmDataFileCleanUpService.js';
import { videoViewsOutlierService } from './services/videoViewsOutlierService.js';
import { trelloGDriveSyncService } from './services/TrelloGDriveSyncService.js';

// Start all services
export async function startServices() {
    console.log('Starting services...');

    // // Start monitoring service
    // await monitoringService.startMonitoring();
    // // Start database synchronization service
    // await databasesSyncService.startSync();
    // // Start NTM data file clean up service
    // await ntmDataFileCleanUpService.startSync();
    // // Start video views outlier service
    // await videoViewsOutlierService.startSync();
    // Start Trello-Google Drive synchronization service
    await trelloGDriveSyncService.startSync();

    console.log('All services started.');
}

// Auto-start services when this module is imported
startServices();
import { monitoringService } from './services/monitoringService.js';
import { databasesSyncService } from './services/databasesSyncService.js';
import { ntmDataFileCleanUpService } from './services/ntmDataFileCleanUpService.js';

// Start all services
export async function startServices() {
    console.log('Starting services...');

    // Start monitoring service
    await monitoringService.startMonitoring();
    // Start database synchronization service
    await databasesSyncService.startSync();
    // Start NTM data file clean up service
    await ntmDataFileCleanUpService.startSync();

    console.log('All services started.');
}

// Auto-start services when this module is imported
startServices();
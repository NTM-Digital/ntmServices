import { monitoringService } from './services/monitoringService.js';

// Start all services
export async function startServices() {
    console.log('Starting services...');

    // Start monitoring service
    await monitoringService.startMonitoring();

    console.log('All services started.');
}

// Auto-start services when this module is imported
startServices();
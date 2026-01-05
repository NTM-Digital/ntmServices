import { monitorDatasource } from '../datasources/monitorDatasource.js';

interface CreateMonitorResult {
  success?: boolean;
  monitor?: any;
  error?: string;
  status?: number;
}

interface UpdateMonitorResult {
  success?: boolean;
  monitor?: any;
  error?: string;
  status?: number;
}

interface GetMonitorsResult {
  monitors?: any[];
  error?: string;
  status?: number;
}

interface DeleteMonitorResult {
  success?: boolean;
  error?: string;
  status?: number;
}

interface IncidentResult {
  success?: boolean;
  incident?: any;
  error?: string;
  status?: number;
}

interface GetIncidentsResult {
  incidents?: any[];
  error?: string;
  status?: number;
}

class MonitorController {
  async createMonitor(
    name: string,
    url: string,
    expectedResponse: string,
    checkInterval: number,
    retryInterval: number
  ): Promise<CreateMonitorResult> {
    try {
      // Validate inputs
      if (!name || !url) {
        return {
          error: 'Name and URL are required',
          status: 400
        };
      }

      // Validate URL format
      try {
        new URL(url);
      } catch {
        return {
          error: 'Invalid URL format',
          status: 400
        };
      }

      // Validate intervals
      if (checkInterval < 1 || retryInterval < 1) {
        return {
          error: 'Check interval and retry interval must be positive numbers',
          status: 400
        };
      }

      const monitor = await monitorDatasource.createMonitor({
        name,
        url,
        expected_response: expectedResponse,
        check_interval: checkInterval,
        retry_interval: retryInterval
      });

      return {
        success: true,
        monitor,
        status: 201
      };
    } catch (error) {
      console.error('Error in createMonitor:', error);
      return {
        error: 'Failed to create monitor',
        status: 500
      };
    }
  }

  async updateMonitor(
    id: string,
    name?: string,
    url?: string,
    expectedResponse?: string,
    checkInterval?: number,
    retryInterval?: number
  ): Promise<UpdateMonitorResult> {
    try {
      // Validate at least one field is provided
      if (!name && !url && !expectedResponse && checkInterval === undefined && retryInterval === undefined) {
        return {
          error: 'At least one field must be provided for update',
          status: 400
        };
      }

      // Validate URL format if provided
      if (url) {
        try {
          new URL(url);
        } catch {
          return {
            error: 'Invalid URL format',
            status: 400
          };
        }
      }

      // Validate intervals if provided
      if ((checkInterval !== undefined && checkInterval < 1) || (retryInterval !== undefined && retryInterval < 1)) {
        return {
          error: 'Check interval and retry interval must be positive numbers',
          status: 400
        };
      }

      const monitor = await monitorDatasource.updateMonitor({
        id,
        name,
        url,
        expected_response: expectedResponse,
        check_interval: checkInterval,
        retry_interval: retryInterval
      });

      if (!monitor) {
        return {
          error: 'Monitor not found',
          status: 404
        };
      }

      return {
        success: true,
        monitor,
        status: 200
      };
    } catch (error) {
      console.error('Error in updateMonitor:', error);
      return {
        error: 'Failed to update monitor',
        status: 500
      };
    }
  }

  async getAllMonitors(): Promise<GetMonitorsResult> {
    try {
      const monitors = await monitorDatasource.getAllMonitors();
      return {
        monitors,
        status: 200
      };
    } catch (error) {
      console.error('Error in getAllMonitors:', error);
      return {
        error: 'Failed to fetch monitors',
        status: 500
      };
    }
  }

  async getMonitorById(id: string): Promise<UpdateMonitorResult> {
    try {
      const monitor = await monitorDatasource.getMonitorById(id);

      if (!monitor) {
        return {
          error: 'Monitor not found',
          status: 404
        };
      }

      return {
        success: true,
        monitor,
        status: 200
      };
    } catch (error) {
      console.error('Error in getMonitorById:', error);
      return {
        error: 'Failed to fetch monitor',
        status: 500
      };
    }
  }

  async deleteMonitor(id: string): Promise<DeleteMonitorResult> {
    try {
      const deleted = await monitorDatasource.deleteMonitor(id);

      if (!deleted) {
        return {
          error: 'Monitor not found',
          status: 404
        };
      }

      return {
        success: true,
        status: 200
      };
    } catch (error) {
      console.error('Error in deleteMonitor:', error);
      return {
        error: 'Failed to delete monitor',
        status: 500
      };
    }
  }

  async createIncident(monitorId: string, message: string): Promise<IncidentResult> {
    try {
      if (!monitorId || !message) {
        return {
          error: 'Monitor ID and message are required',
          status: 400
        };
      }

      await monitorDatasource.createIncident(monitorId, message);

      return {
        success: true,
        status: 201
      };
    } catch (error) {
      console.error('Error in createIncident:', error);
      return {
        error: 'Failed to create incident',
        status: 500
      };
    }
  }

  async getOpenIncidentsByMonitorId(monitorId: string): Promise<GetIncidentsResult> {
    try {
      const incidents = await monitorDatasource.getOpenIncidentsByMonitorId(monitorId);
      return {
        incidents,
        status: 200
      };
    } catch (error) {
      console.error('Error in getOpenIncidentsByMonitorId:', error);
      return {
        error: 'Failed to fetch open incidents',
        status: 500
      };
    }
  }

  async closeIncident(incidentId: string): Promise<IncidentResult> {
    try {
      const incident = await monitorDatasource.closeIncident(incidentId);

      if (!incident) {
        return {
          error: 'Incident not found',
          status: 404
        };
      }

      return {
        success: true,
        incident,
        status: 200
      };
    } catch (error) {
      console.error('Error in closeIncident:', error);
      return {
        error: 'Failed to close incident',
        status: 500
      };
    }
  }

  async updateLastCheck(monitorId: string): Promise<{ success?: boolean; error?: string; status?: number }> {
    try {
      await monitorDatasource.updateLastCheck(monitorId);
      return {
        success: true,
        status: 200
      };
    } catch (error) {
      console.error('Error in updateLastCheck:', error);
      return {
        error: 'Failed to update last check',
        status: 500
      };
    }
  }
}

export const monitorController = new MonitorController();

import PG from 'pg';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

interface CreateMonitorParams {
  name: string;
  url: string;
  expected_response: string;
  check_interval: number;
  retry_interval: number;
}

interface UpdateMonitorParams {
  id: string;
  name?: string;
  url?: string;
  expected_response?: string;
  check_interval?: number;
  retry_interval?: number;
}

class MonitorDatasource {
  private pool: PG.Pool;

  constructor() {
    this.pool = new PG.Pool({
      connectionString: process.env.POSTGRES_URL
    });
  }

  async createMonitor(params: CreateMonitorParams) {
    try {
      const client = await this.pool.connect();
      const query = `
        INSERT INTO monitored_urls (name, url, expected_response, check_interval, retry_interval)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      const values = [
        params.name,
        params.url,
        params.expected_response,
        params.check_interval,
        params.retry_interval
      ];
      const result = await client.query(query, values);
      client.release();

      return result.rows[0];
    } catch (error) {
      console.error('Error creating monitor:', error);
      throw new Error('Failed to create monitor');
    }
  }

  async updateMonitor(params: UpdateMonitorParams) {
    try {
      const client = await this.pool.connect();

      // Build dynamic update query based on provided fields
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (params.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(params.name);
      }
      if (params.url !== undefined) {
        updates.push(`url = $${paramIndex++}`);
        values.push(params.url);
      }
      if (params.expected_response !== undefined) {
        updates.push(`expected_response = $${paramIndex++}`);
        values.push(params.expected_response);
      }
      if (params.check_interval !== undefined) {
        updates.push(`check_interval = $${paramIndex++}`);
        values.push(params.check_interval);
      }
      if (params.retry_interval !== undefined) {
        updates.push(`retry_interval = $${paramIndex++}`);
        values.push(params.retry_interval);
      }

      if (updates.length === 0) {
        throw new Error('No fields to update');
      }

      values.push(params.id);
      const query = `
        UPDATE monitored_urls
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await client.query(query, values);
      client.release();

      if (result.rows.length === 0) {
        return null; // Monitor not found
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error updating monitor:', error);
      throw new Error('Failed to update monitor');
    }
  }

  async getMonitorById(id: string) {
    try {
      const client = await this.pool.connect();
      const query = `
        SELECT * FROM monitored_urls
        WHERE id = $1
      `;
      const values = [id];
      const result = await client.query(query, values);
      client.release();

      if (result.rows.length === 0) {
        return null; // Monitor not found
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error fetching monitor by ID:', error);
      throw new Error('Failed to fetch monitor');
    }
  }

  async getAllMonitors() {
    try {
      const client = await this.pool.connect();
      const query = `
        SELECT * FROM monitored_urls
        ORDER BY name ASC
      `;
      const result = await client.query(query);
      client.release();

      return result.rows;
    } catch (error) {
      console.error('Error fetching monitors:', error);
      throw new Error('Failed to fetch monitors');
    }
  }

  async deleteMonitor(id: string) {
    try {
      const client = await this.pool.connect();
      const query = `
        DELETE FROM monitored_urls
        WHERE id = $1
        RETURNING id
      `;
      const values = [id];
      const result = await client.query(query, values);
      client.release();

      if (result.rows.length === 0) {
        return null; // Monitor not found
      }

      return true;
    } catch (error) {
      console.error('Error deleting monitor:', error);
      throw new Error('Failed to delete monitor');
    }
  }

  async createIncident(monitorId: string, message: string) {
    try {
      const client = await this.pool.connect();

      // First, close any existing open incidents with different error messages
      await client.query(`
        UPDATE monitor_incidents
        SET is_open = FALSE, ended_at = NOW()
        WHERE monitored_urls_id = $1
          AND is_open = TRUE
          AND error_message != $2
      `, [monitorId, message]);

      // Then insert or do nothing if same incident already exists
      const query = `
        INSERT INTO monitor_incidents (monitored_urls_id, error_message, is_open)
        VALUES ($1, $2, TRUE)
        ON CONFLICT (monitored_urls_id, error_message, is_open)
        WHERE is_open = TRUE
        DO NOTHING
        RETURNING *
      `;
      const values = [monitorId, message];
      const result = await client.query(query, values);
      client.release();

      if (result.rows.length > 0) {
        console.log(`Created new incident for monitor ${monitorId}`);
      } else {
        console.log(`Incident already exists for monitor ${monitorId} with same error`);
      }

      return result.rows[0];
    } catch (error) {
      console.error('Error in createIncident:', error);
      throw error;
    }
  }

  async getOpenIncidentsByMonitorId(monitorId: string) {
    try {
      const client = await this.pool.connect();
      const query = `
        SELECT * FROM monitor_incidents
        WHERE monitored_urls_id = $1 AND is_open = TRUE
      `;
      const values = [monitorId];
      const result = await client.query(query, values);
      client.release();
      return result.rows;
    } catch (error) {
      console.error('Error fetching open incidents:', error);
      throw new Error('Failed to fetch open incidents');
    }
  }
  async closeIncident(incidentId: string) {
    try {
      const client = await this.pool.connect();
      const query = `
        UPDATE monitor_incidents
        SET is_open = FALSE, ended_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      const values = [incidentId];
      const result = await client.query(query, values);
      client.release();

      if (result.rows.length === 0) {
        return null; // Incident not found
      }
      return result.rows[0];
    } catch (error) {
      console.error('Error closing incident:', error);
      throw new Error('Failed to close incident');
    }
  }

  async updateLastCheck(monitorId: string) {
    try {
      const client = await this.pool.connect();
      const query = `
        UPDATE monitored_urls
        SET last_check_at = NOW()
        WHERE id = $1
      `;
      const values = [monitorId];
      await client.query(query, values);
      client.release();
    } catch (error) {
      console.error('Error updating last check:', error);
      throw new Error('Failed to update last check');
    }
  }
}

export const monitorDatasource = new MonitorDatasource();

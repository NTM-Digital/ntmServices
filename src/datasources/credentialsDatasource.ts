import PG from 'pg';
import { POSTGRES_URL } from '../lib/env.js';

export interface Credential {
  id: number;
  name: string | null;
  provider: number | null;
  type: number | null;
  key: string | null; // PROVIDER_TYPE in upper snake case, e.g. OPEN_AI_API_KEY
  values: Record<string, string>; // key/value bag; each value is individually encrypted
  created_at: Date;
  updated_at: Date | null;
  user_id: string | null;
  is_public: boolean;
  apps: string[]; // app names this credential is scoped to — empty means global
}

class CredentialsDatasource {
  private pool: PG.Pool;

  constructor() {
    // The credential table lives in the Auth DB. This connection string is
    // bootstrap config read straight from process.env — sourcing it from the
    // credential table would be circular.
    this.pool = new PG.Pool({
      connectionString: POSTGRES_URL
    });
  }

  private async getAppsByCredentialId(credentialIds: number[]): Promise<Map<number, string[]>> {
    const appsByCredential = new Map<number, string[]>();
    if (credentialIds.length === 0) return appsByCredential;

    const result = await this.pool.query(
      'SELECT credential_id, app_name FROM apps_credential WHERE credential_id = ANY($1)',
      [credentialIds]
    );
    for (const row of result.rows) {
      const list = appsByCredential.get(row.credential_id) ?? [];
      list.push(row.app_name);
      appsByCredential.set(row.credential_id, list);
    }
    return appsByCredential;
  }

  /** App-specific credential wins if one exists; otherwise falls back to the global one (no apps_credential rows).
   * Matched on the credential's own `key` column, which is unambiguous since it's set on the row itself rather
   * than re-derived by joining on a name/node_key that isn't guaranteed unique elsewhere. */
  public async getCredentialForApp(appName: string, key: string): Promise<Credential | null> {
    const result = await this.pool.query(
      `SELECT c.id, c.name, c.provider, c.type, c.key, c.values, c.created_at, c.updated_at, c.user_id, c.is_public,
              ac.app_name IS NOT NULL AS app_specific
       FROM credential c
       LEFT JOIN apps_credential ac ON ac.credential_id = c.id AND ac.app_name = $1
       WHERE c.key = $2
         AND (
           ac.app_name IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM apps_credential ac2 WHERE ac2.credential_id = c.id)
         )
       ORDER BY app_specific DESC
       LIMIT 1`,
      [appName, key]
    );
    if (result.rows.length === 0) return null;
    const { app_specific, ...row } = result.rows[0];
    const appsByCredential = await this.getAppsByCredentialId([row.id]);
    return { ...row, apps: appsByCredential.get(row.id) ?? [] };
  }
}

export const credentialsDatasource = new CredentialsDatasource();
